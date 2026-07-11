import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma, type Prisma, type SyncEvent } from '@taskara/db';
import {
  carryForwardMeetingActionItemSchema,
  createCheckInResponseSchema,
  createCommentSchema,
  createMeetingActionItemSchema,
  createMilestoneSchema,
  createOneOnOneAgendaItemSchema,
  createOneOnOneSeriesSchema,
  createProjectHealthUpdateSchema,
  createTaskFromMeetingActionItemSchema,
  createTaskSchema,
  milestoneCompletionSchema,
  milestoneTransitionSchema,
  reorderMilestoneSchema,
  updateMeetingActionItemSchema,
  updateMilestoneSchema,
  updateTaskSchema
} from '@taskara/shared';
import { z, ZodError } from 'zod';
import { getRequestActor, type RequestActor } from '../services/actor';
import { dismissAttentionItem, resolveAttentionItem, snoozeAttentionItem } from '../services/attention';
import { resolveCorsOrigin as resolveAllowedCorsOrigin } from '../services/cors';
import {
  addOneOnOneAgendaItem,
  cancelMeetingActionItem,
  carryForwardMeetingActionItem,
  completeMeetingActionItem,
  createCheckInResponse,
  createMeetingActionItem,
  createOneOnOneSeries,
  createTaskFromMeetingActionItem,
  updateMeetingActionItem
} from '../services/check-ins';
import { HttpError } from '../services/http';
import {
  activateMilestone,
  archiveMilestone,
  cancelMilestone,
  completeMilestone,
  createMilestone,
  listMilestonesForSync,
  reopenMilestone,
  reorderMilestone,
  restoreMilestone,
  updateMilestone
} from '../services/milestones';
import { createProjectHealthUpdate } from '../services/project-health';
import {
  assertActorCanAccessTeamSlug,
  canManageProjectPlanning,
  canReadProject,
  projectWhereForAccess,
  resolveWorkspaceAccess,
  taskWhereForAccess,
  teamWhereForAccess,
  type WorkspaceAccess
} from '../services/team-access';
import {
  addTaskComment,
  addTaskProgressStartedAt,
  createTask,
  deleteTask,
  findTaskByIdOrKey,
  serializeTaskForResponse,
  taskInclude,
  updateTask
} from '../services/tasks';
import {
  ensurePendingClientMutation,
  markClientMutationRejected,
  serializeSyncEvent,
  syncCursor,
  syncHub,
  type SyncMutationMeta
} from '../services/sync';

const syncScopeQuerySchema = z.object({
  scope: z.literal('tasks').default('tasks'),
  teamId: z.string().min(1).default('all'),
  mine: z.coerce.boolean().optional(),
  cursor: z.string().regex(/^\d+$/).default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  clientId: z.string().trim().min(1).max(160).optional(),
  completedWindowDays: z.coerce.number().int().min(1).max(30).default(5)
});

const pushMutationSchema = z.object({
  mutationId: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(80),
  args: z.unknown(),
  baseVersion: z.number().int().optional(),
  createdAt: z.string().optional()
});

const pushRequestSchema = z.object({
  clientId: z.string().trim().min(1).max(160),
  mutations: z.array(pushMutationSchema).min(1).max(50)
});

const stalePendingMutationMs = 2 * 60 * 1000;

const updateTaskMutationArgsSchema = z.object({
  idOrKey: z.string().trim().min(1),
  baseVersion: z.number().int().optional(),
  patch: updateTaskSchema
});

const deleteTaskMutationArgsSchema = z.object({
  idOrKey: z.string().trim().min(1)
});

const commentTaskMutationArgsSchema = z.object({
  idOrKey: z.string().trim().min(1),
  body: z.string().min(1).max(15000),
  source: z.enum(['WEB', 'API', 'MATTERMOST', 'CODEX', 'AGENT', 'SYSTEM']).default('WEB'),
  mattermostPostId: z.string().optional()
});

const attentionResolveMutationArgsSchema = z.object({
  id: z.string().uuid()
});

const attentionSnoozeMutationArgsSchema = z.object({
  id: z.string().uuid(),
  snoozedUntil: z.string().datetime({ offset: true })
});

const attentionDismissMutationArgsSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(3).max(500)
});

const checkInCreateMutationArgsSchema = createCheckInResponseSchema;

const oneOnOneCreateMutationArgsSchema = createOneOnOneSeriesSchema;

const oneOnOneAgendaItemCreateMutationArgsSchema = z.object({
  seriesId: z.string().uuid(),
  item: createOneOnOneAgendaItemSchema
});

const meetingActionItemCreateMutationArgsSchema = z.object({
  meetingId: z.string().uuid(),
  item: createMeetingActionItemSchema
});

const meetingActionItemUpdateMutationArgsSchema = z.object({
  id: z.string().uuid(),
  patch: updateMeetingActionItemSchema
});

const meetingActionItemIdMutationArgsSchema = z.object({
  id: z.string().uuid()
});

const meetingActionItemCarryMutationArgsSchema = z.object({
  id: z.string().uuid(),
  carry: carryForwardMeetingActionItemSchema
});

const meetingActionItemCreateTaskMutationArgsSchema = z.object({
  id: z.string().uuid(),
  task: createTaskFromMeetingActionItemSchema
});

const projectHealthUpdateCreateMutationArgsSchema = z.object({
  projectId: z.string().uuid(),
  update: createProjectHealthUpdateSchema
});

const milestoneUpdateMutationArgsSchema = z.object({
  id: z.string().uuid(),
  patch: updateMilestoneSchema
});

const milestoneReorderMutationArgsSchema = z.object({
  id: z.string().uuid(),
  reorder: reorderMilestoneSchema
});

const milestoneTransitionMutationArgsSchema = z.object({
  id: z.string().uuid(),
  transition: milestoneTransitionSchema.default({})
});

const milestoneCompletionMutationArgsSchema = z.object({
  id: z.string().uuid(),
  completion: milestoneCompletionSchema.default({})
});

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sync/bootstrap', async (request) => {
    const actor = await getRequestActor(request);
    const query = syncScopeQuerySchema.parse(request.query);
    const access = await resolveWorkspaceAccess(actor);
    if (query.teamId !== 'all') await assertActorCanAccessTeamSlug(actor, query.teamId);
    const omittedCompletedBefore = hotCompletedCutoff(query.completedWindowDays).toISOString();
    const [tasksResult, milestones, projects, teams, usersResult, views, cursor] = await Promise.all([
      listTasksForScope(actor, query, access),
      listMilestonesForSync(actor, access, query.completedWindowDays),
      listProjects(access),
      listTeams(access),
      listUsers(actor.workspace.id),
      listViews(actor, query.teamId, access),
      latestCursor(actor.workspace.id)
    ]);

    return {
      cursor,
      serverTime: new Date().toISOString(),
      completedWindowDays: query.completedWindowDays,
      omittedCompletedBefore,
      tasks: tasksResult.items,
      milestones,
      totalHotTasks: tasksResult.total,
      projects,
      teams,
      users: usersResult.items,
      views
    };
  });

  app.get('/sync/pull', async (request) => {
    const actor = await getRequestActor(request);
    const query = syncScopeQuerySchema.parse(request.query);
    const access = await resolveWorkspaceAccess(actor);
    if (query.teamId !== 'all') await assertActorCanAccessTeamSlug(actor, query.teamId);
    const cursor = BigInt(query.cursor);
    const events = await prisma.syncEvent.findMany({
      where: {
        workspaceId: actor.workspace.id,
        workspaceSeq: { gt: cursor }
      },
      orderBy: { workspaceSeq: 'asc' },
      take: query.limit
    });
    const firstEvent = await prisma.syncEvent.findFirst({
      where: { workspaceId: actor.workspace.id },
      orderBy: { workspaceSeq: 'asc' },
      select: { workspaceSeq: true }
    });

    if (firstEvent && cursor > BigInt(0) && cursor < firstEvent.workspaceSeq - BigInt(1)) {
      return {
        cursor: await latestCursor(actor.workspace.id),
        resetRequired: true,
        events: []
      };
    }

    const mappedEvents = events
      .map((event) => mapSyncEventForScope(event, query, actor, access))
      .filter((event): event is NonNullable<typeof event> => event !== null);
    const nextCursor = events.length ? events[events.length - 1].workspaceSeq.toString() : query.cursor;

    return {
      cursor: nextCursor,
      hasMore: events.length === query.limit,
      events: mappedEvents
    };
  });

  app.post('/sync/push', async (request) => {
    const actor = await getRequestActor(request);
    const input = pushRequestSchema.parse(request.body);
    const access = await resolveWorkspaceAccess(actor);
    const results = [];

    for (const mutation of input.mutations) {
      const existing = await prisma.clientMutation.findUnique({
        where: {
          workspaceId_clientId_mutationId: {
            workspaceId: actor.workspace.id,
            clientId: input.clientId,
            mutationId: mutation.mutationId
          }
        }
      });

      if (existing?.status === 'APPLIED') {
        results.push({
          mutationId: mutation.mutationId,
          status: 'duplicate',
          workspaceSeq: existing.resultWorkspaceSeq?.toString()
        });
        continue;
      }
      if (existing?.status === 'PENDING') {
        if (isStalePendingMutation(existing.updatedAt)) {
          await prisma.clientMutation.delete({ where: { id: existing.id } });
        } else {
          results.push({
            mutationId: mutation.mutationId,
            status: 'rejected',
            error: { code: 'mutation_pending', message: 'Mutation is already pending.', retryable: true }
          });
          continue;
        }
      }
      if (existing?.status === 'REJECTED') {
        results.push({
          mutationId: mutation.mutationId,
          status: existing.errorCode === 'mutation_conflict' ? 'conflict' : 'rejected',
          error: {
            code: existing.errorCode || 'mutation_rejected',
            message: existing.errorMessage || 'Mutation was rejected.',
            retryable: false
          }
        });
        continue;
      }

      const meta: SyncMutationMeta = {
        clientId: input.clientId,
        mutationId: mutation.mutationId,
        mutationName: mutation.name,
        userId: actor.user.id
      };
      const pendingState = await ensurePendingClientMutation({ ...meta, workspaceId: actor.workspace.id });
      if (pendingState === 'existing') {
        const current = await prisma.clientMutation.findUnique({
          where: {
            workspaceId_clientId_mutationId: {
              workspaceId: actor.workspace.id,
              clientId: input.clientId,
              mutationId: mutation.mutationId
            }
          }
        });
        results.push({
          mutationId: mutation.mutationId,
          status:
            current?.status === 'APPLIED'
              ? 'duplicate'
              : current?.status === 'REJECTED' && current.errorCode === 'mutation_conflict'
                ? 'conflict'
                : 'rejected',
          workspaceSeq: current?.resultWorkspaceSeq?.toString(),
          error:
            current?.status === 'APPLIED'
              ? undefined
              : current?.status === 'REJECTED'
                ? {
                    code: current.errorCode || 'mutation_rejected',
                    message: current.errorMessage || 'Mutation was rejected.',
                    retryable: false
                  }
                : { code: 'mutation_pending', message: 'Mutation is already pending.', retryable: true }
        });
        continue;
      }

      try {
        const entity = await applyMutation(actor, mutation.name, mutation.args, meta, access, mutation.baseVersion);
        const ack = await prisma.clientMutation.findUnique({
          where: {
            workspaceId_clientId_mutationId: {
              workspaceId: actor.workspace.id,
              clientId: input.clientId,
              mutationId: mutation.mutationId
            }
          }
        });
        results.push({
          mutationId: mutation.mutationId,
          status: 'applied',
          workspaceSeq: ack?.resultWorkspaceSeq?.toString(),
          entity
        });
      } catch (error) {
        const message = mutationErrorMessage(error);
        const isConflict = error instanceof HttpError && error.statusCode === 409;
        await markClientMutationRejected(
          actor.workspace.id,
          input.clientId,
          mutation.mutationId,
          isConflict ? 'mutation_conflict' : 'mutation_failed',
          message
        );
        results.push({
          mutationId: mutation.mutationId,
          status: isConflict ? 'conflict' : 'rejected',
          error: { code: isConflict ? 'mutation_conflict' : 'mutation_failed', message, retryable: false }
        });
      }
    }

    return {
      cursor: await latestCursor(actor.workspace.id),
      results
    };
  });

  app.get('/sync/stream', async (request, reply) => {
    const actor = await getRequestActor(request);
    const query = syncScopeQuerySchema.parse(request.query);
    openSyncStream(request, reply, actor, query.clientId);
  });
}

async function applyMutation(
  actor: RequestActor,
  name: string,
  args: unknown,
  meta: SyncMutationMeta,
  access: WorkspaceAccess,
  baseVersion?: number
): Promise<unknown> {
  if (name === 'task.create') {
    const input = createTaskSchema.parse(args);
    const task = serializeTaskForResponse(await createTask(actor, input, meta));
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [task]);
    return decoratedTask;
  }

  if (name === 'task.update') {
    const input = updateTaskMutationArgsSchema.parse(args);
    const task = await findTaskByIdOrKey(actor.workspace.id, input.idOrKey, access);
    if (!task) throw new HttpError(404, 'Task not found');
    const updated = serializeTaskForResponse(await updateTask(actor, task.id, input.patch, meta, input.baseVersion ?? baseVersion));
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [updated]);
    return decoratedTask;
  }

  if (name === 'task.delete') {
    const input = deleteTaskMutationArgsSchema.parse(args);
    const task = await findTaskByIdOrKey(actor.workspace.id, input.idOrKey, access);
    if (!task) throw new HttpError(404, 'Task not found');
    return serializeTaskForResponse(await deleteTask(actor, task.id, meta));
  }

  if (name === 'task.comment.create') {
    const input = commentTaskMutationArgsSchema.parse(args);
    const task = await findTaskByIdOrKey(actor.workspace.id, input.idOrKey, access);
    if (!task) throw new HttpError(404, 'Task not found');
    return addTaskComment(actor, task.id, input.body, input.source, input.mattermostPostId, meta);
  }

  if (name === 'milestone.create') {
    return createMilestone(actor, createMilestoneSchema.parse(args), meta);
  }

  if (name === 'milestone.update') {
    const input = milestoneUpdateMutationArgsSchema.parse(args);
    return updateMilestone(actor, input.id, input.patch, meta);
  }

  if (name === 'milestone.reorder') {
    const input = milestoneReorderMutationArgsSchema.parse(args);
    return reorderMilestone(actor, input.id, input.reorder, meta);
  }

  if (name === 'milestone.activate') {
    const input = milestoneTransitionMutationArgsSchema.parse(args);
    return activateMilestone(actor, input.id, input.transition, meta);
  }

  if (name === 'milestone.complete') {
    const input = milestoneCompletionMutationArgsSchema.parse(args);
    return completeMilestone(actor, input.id, input.completion, meta);
  }

  if (name === 'milestone.reopen') {
    const input = milestoneTransitionMutationArgsSchema.parse(args);
    return reopenMilestone(actor, input.id, input.transition, meta);
  }

  if (name === 'milestone.cancel') {
    const input = milestoneCompletionMutationArgsSchema.parse(args);
    return cancelMilestone(actor, input.id, input.completion, meta);
  }

  if (name === 'milestone.archive') {
    const input = milestoneTransitionMutationArgsSchema.parse(args);
    return archiveMilestone(actor, input.id, input.transition, meta);
  }

  if (name === 'milestone.restore') {
    const input = milestoneTransitionMutationArgsSchema.parse(args);
    return restoreMilestone(actor, input.id, input.transition, meta);
  }

  if (name === 'attention.resolve') {
    const input = attentionResolveMutationArgsSchema.parse(args);
    return resolveAttentionItem(actor, input.id, meta);
  }

  if (name === 'attention.snooze') {
    const input = attentionSnoozeMutationArgsSchema.parse(args);
    return snoozeAttentionItem(actor, input.id, new Date(input.snoozedUntil), meta);
  }

  if (name === 'attention.dismiss') {
    const input = attentionDismissMutationArgsSchema.parse(args);
    return dismissAttentionItem(actor, input.id, input.reason, meta);
  }

  if (name === 'check_in.create') {
    const input = checkInCreateMutationArgsSchema.parse(args);
    return createCheckInResponse(actor, input, meta);
  }

  if (name === 'one_on_one.create') {
    const input = oneOnOneCreateMutationArgsSchema.parse(args);
    return createOneOnOneSeries(actor, input, meta);
  }

  if (name === 'one_on_one_agenda_item.create') {
    const input = oneOnOneAgendaItemCreateMutationArgsSchema.parse(args);
    return addOneOnOneAgendaItem(actor, input.seriesId, input.item, meta);
  }

  if (name === 'meeting_action_item.create') {
    const input = meetingActionItemCreateMutationArgsSchema.parse(args);
    return createMeetingActionItem(actor, input.meetingId, input.item, meta);
  }

  if (name === 'meeting_action_item.update') {
    const input = meetingActionItemUpdateMutationArgsSchema.parse(args);
    return updateMeetingActionItem(actor, input.id, input.patch, 'updated', meta);
  }

  if (name === 'meeting_action_item.complete') {
    const input = meetingActionItemIdMutationArgsSchema.parse(args);
    return completeMeetingActionItem(actor, input.id, meta);
  }

  if (name === 'meeting_action_item.cancel') {
    const input = meetingActionItemIdMutationArgsSchema.parse(args);
    return cancelMeetingActionItem(actor, input.id, meta);
  }

  if (name === 'meeting_action_item.carry_forward') {
    const input = meetingActionItemCarryMutationArgsSchema.parse(args);
    return carryForwardMeetingActionItem(actor, input.id, input.carry, meta);
  }

  if (name === 'meeting_action_item.create_task') {
    const input = meetingActionItemCreateTaskMutationArgsSchema.parse(args);
    return createTaskFromMeetingActionItem(actor, input.id, input.task, meta);
  }

  if (name === 'project_health_update.create') {
    const input = projectHealthUpdateCreateMutationArgsSchema.parse(args);
    return createProjectHealthUpdate(actor, input.projectId, input.update, meta);
  }

  throw new HttpError(400, `Unsupported sync mutation: ${name}`);
}

async function listTasksForScope(actor: RequestActor, query: z.infer<typeof syncScopeQuerySchema>, access: WorkspaceAccess) {
  const where = taskWhereForScope(actor, query, access);
  const [items, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: 500
    }),
    prisma.task.count({ where })
  ]);

  return { items: await addTaskProgressStartedAt(actor.workspace.id, items.map(serializeTaskForResponse)), total };
}

function taskWhereForScope(
  actor: RequestActor,
  query: z.infer<typeof syncScopeQuerySchema>,
  access: WorkspaceAccess
): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = {
    ...taskWhereForAccess(access),
    assigneeId: query.mine ? actor.user.id : undefined
  };

  if (query.teamId !== 'all') {
    where.project = {
      team: {
        workspaceId: actor.workspace.id,
        slug: query.teamId
      }
    };
  }

  return {
    AND: [
      where,
      hotTaskWhere(hotCompletedCutoff(query.completedWindowDays))
    ]
  };
}

async function listProjects(access: WorkspaceAccess) {
  return prisma.project.findMany({
    where: projectWhereForAccess(access),
    orderBy: [{ parentId: 'asc' }, { updatedAt: 'desc' }],
    include: {
      team: { select: { id: true, name: true, slug: true } },
      parent: { select: { id: true, name: true, keyPrefix: true } },
      lead: { select: { id: true, name: true, email: true, avatarUrl: true } },
      _count: { select: { tasks: true, subprojects: true, milestones: true } }
    }
  });
}

async function listTeams(access: WorkspaceAccess) {
  return prisma.team.findMany({
    where: teamWhereForAccess(access),
    orderBy: { name: 'asc' },
    include: { _count: { select: { members: true, projects: true } } }
  });
}

async function listUsers(workspaceId: string) {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
    take: 200,
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          mattermostUserId: true,
          mattermostUsername: true,
          avatarUrl: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { assignedTasks: true, reportedTasks: true, comments: true } }
        }
      }
    }
  });

  return {
    items: members.map((member) => ({
      membershipId: member.id,
      role: member.role,
      joinedAt: member.createdAt,
      ...member.user
    })),
    total: members.length,
    limit: 200,
    offset: 0
  };
}

async function listViews(actor: RequestActor, teamId: string, access: WorkspaceAccess) {
  const accessibleTeamSlugs = !access.workspaceWide
    ? new Set(
        (
          await prisma.team.findMany({
            where: { workspaceId: actor.workspace.id, id: { in: access.teamIds } },
            select: { slug: true }
          })
        ).map((team) => team.slug)
      )
    : null;

  const views = await prisma.view.findMany({
    where: {
      workspaceId: actor.workspace.id,
      OR: [{ isShared: true }, { ownerId: actor.user.id }]
    },
    orderBy: [{ updatedAt: 'desc' }]
  });

  return views
    .map((view) => ({
      id: view.id,
      workspaceId: view.workspaceId,
      ownerId: view.ownerId,
      name: view.name,
      isShared: view.isShared,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      state: view.filters
    }))
    .filter((view) => {
      const state = view.state as { scope?: string; teamId?: string };
      if (state.scope !== 'tasks') return false;
      if (state.teamId && state.teamId !== 'all' && accessibleTeamSlugs) {
        const isAllowed = accessibleTeamSlugs.has(state.teamId);
        if (!isAllowed) return false;
      }
      return teamId === 'all' || state.teamId === teamId;
    });
}

async function latestCursor(workspaceId: string): Promise<string> {
  const event = await prisma.syncEvent.findFirst({
    where: { workspaceId },
    orderBy: { workspaceSeq: 'desc' },
    select: { workspaceSeq: true }
  });
  return syncCursor(event?.workspaceSeq);
}

export function mapSyncEventForScope(
  event: SyncEvent,
  query: z.infer<typeof syncScopeQuerySchema>,
  actor: RequestActor,
  access: string[] | WorkspaceAccess | null
) {
  const serialized = serializeSyncEvent(event);
  if (event.entityType !== 'task') {
    if (!managerEventVisibleInScope(event, actor, access)) return null;
    if (event.entityType === 'milestone') {
      return mapMilestoneSyncEvent(serialized, event, actor, access);
    }
    return mapGenericSyncEvent(serialized, event);
  }

  const payload = event.payload as Record<string, unknown>;
  const before = taskPayloadRecord(payload.before);
  const after = taskPayloadRecord(payload.after);
  const beforeVisible = before ? taskVisibleInScope(before, query, actor, access) : false;
  const afterVisible = after ? taskVisibleInScope(after, query, actor, access) : false;

  if (afterVisible && after) {
    return {
      ...serialized,
      type: 'upsert',
      task: withEventProgressStartedAt(after, before, event.createdAt)
    };
  }

  if (beforeVisible && before) {
    return {
      ...serialized,
      type: event.operation === 'deleted' ? 'delete' : 'removeFromScope',
      taskId: before.id,
      taskKey: before.key
    };
  }

  return null;
}

function mapMilestoneSyncEvent(
  serialized: ReturnType<typeof serializeSyncEvent>,
  event: SyncEvent,
  actor: RequestActor,
  access: string[] | WorkspaceAccess | null
) {
  const payload = syncPayloadRecord(event.payload);
  const before = syncPayloadRecord(payload?.before);
  const after = syncPayloadRecord(payload?.after);
  if (after && access && !Array.isArray(access)) {
    const project = projectRecordForAccess(syncPayloadRecord(after.project));
    return {
      ...serialized,
      type: 'upsert' as const,
      entity: {
        ...after,
        canManage: project ? canManageProjectPlanning(actor, access, {
          id: project.id || '',
          teamId: project.teamId || null,
          leadId: project.leadId || null
        }) : false
      }
    };
  }
  if (before) {
    return {
      ...serialized,
      type: event.operation === 'deleted' ? 'delete' as const : 'removeFromScope' as const,
      entityId: event.entityId
    };
  }
  return serialized;
}

function mapGenericSyncEvent(serialized: ReturnType<typeof serializeSyncEvent>, event: SyncEvent) {
  const payload = syncPayloadRecord(event.payload);
  const before = syncPayloadRecord(payload?.before);
  const after = syncPayloadRecord(payload?.after);

  if (after) {
    return {
      ...serialized,
      type: 'upsert' as const,
      entity: after
    };
  }

  if (before) {
    return {
      ...serialized,
      type: event.operation === 'deleted' ? 'delete' as const : 'removeFromScope' as const,
      entityId: event.entityId
    };
  }

  return serialized;
}

function managerEventVisibleInScope(
  event: SyncEvent,
  actor: RequestActor,
  access: string[] | WorkspaceAccess | null
): boolean {
  const payload = syncPayloadRecord(event.payload);
  const before = syncPayloadRecord(payload?.before);
  const after = syncPayloadRecord(payload?.after);
  const record = after || before;
  if (!record) return false;

  if (isWorkspaceWideAccess(access)) return true;

  switch (event.entityType) {
    case 'review':
      return reviewEventVisible(record, actor, access);
    case 'attention':
      return attentionEventVisible(record, actor);
    case 'check_in':
      return checkInEventVisible(record, actor);
    case 'one_on_one':
      return oneOnOneEventVisible(record, actor);
    case 'one_on_one_agenda_item':
      return agendaItemEventVisible(record, actor);
    case 'meeting_action_item':
      return meetingActionItemEventVisible(record, actor, access);
    case 'project_health_update':
      return projectHealthEventVisible(record, access);
    case 'milestone':
      return milestoneEventVisible(record, access);
    default:
      return false;
  }
}

function reviewEventVisible(
  review: Record<string, unknown>,
  actor: RequestActor,
  access: string[] | WorkspaceAccess | null
): boolean {
  if (review.requesterId === actor.user.id || review.reviewerId === actor.user.id) return true;

  const task = syncPayloadRecord(review.task);
  if (!task) return false;
  const assignee = syncPayloadRecord(task.assignee);
  const reporter = syncPayloadRecord(task.reporter);
  if (assignee?.id === actor.user.id || reporter?.id === actor.user.id) return true;
  return taskProjectVisible(task, access);
}

function attentionEventVisible(attention: Record<string, unknown>, actor: RequestActor): boolean {
  return (
    attention.assigneeId === actor.user.id ||
    attention.managerId === actor.user.id ||
    (attention.entityType === 'user' && attention.entityId === actor.user.id)
  );
}

function checkInEventVisible(checkIn: Record<string, unknown>, actor: RequestActor): boolean {
  return checkIn.userId === actor.user.id || checkIn.authorId === actor.user.id;
}

function oneOnOneEventVisible(series: Record<string, unknown>, actor: RequestActor): boolean {
  return series.managerId === actor.user.id || series.participantId === actor.user.id;
}

function agendaItemEventVisible(item: Record<string, unknown>, actor: RequestActor): boolean {
  // Agenda payloads currently do not include the parent series. For non-admins, only send items
  // the actor created; participants/managers can still load their agenda through the route.
  return item.createdById === actor.user.id;
}

function meetingActionItemEventVisible(
  item: Record<string, unknown>,
  actor: RequestActor,
  access: string[] | WorkspaceAccess | null
): boolean {
  if (item.assigneeId === actor.user.id || item.createdById === actor.user.id) return true;
  const meeting = syncPayloadRecord(item.meeting);
  if (!meeting) return false;
  if (meeting.ownerId === actor.user.id || meeting.createdById === actor.user.id) return true;
  const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
  if (participants.some((participant) => syncPayloadRecord(participant)?.userId === actor.user.id)) return true;
  if (!access || Array.isArray(access)) return false;

  const project = syncPayloadRecord(meeting.project);
  if (project && canReadProject(access, projectRecordForAccess(project))) return true;

  const teamId = stringValue(meeting.teamId) || stringValue(project?.teamId);
  return !teamId || access.teamIds.includes(teamId);
}

function projectHealthEventVisible(
  update: Record<string, unknown>,
  access: string[] | WorkspaceAccess | null
): boolean {
  if (!access || Array.isArray(access)) return false;
  const project = syncPayloadRecord(update.project);
  return canReadProject(access, projectRecordForAccess(project));
}

function milestoneEventVisible(
  milestone: Record<string, unknown>,
  access: string[] | WorkspaceAccess | null
): boolean {
  if (!access || Array.isArray(access)) return false;
  const project = syncPayloadRecord(milestone.project);
  return canReadProject(access, projectRecordForAccess(project));
}

function projectRecordForAccess(project: Record<string, unknown> | null): { id?: string | null; teamId?: string | null; leadId?: string | null } | null {
  if (!project) return null;
  return {
    id: stringValue(project.id),
    teamId: stringValue(project.teamId),
    leadId: stringValue(project.leadId)
  };
}

function isWorkspaceWideAccess(access: string[] | WorkspaceAccess | null): boolean {
  return Boolean(access && !Array.isArray(access) && access.workspaceWide);
}

function taskPayloadRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function syncPayloadRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function taskVisibleInScope(
  task: Record<string, unknown>,
  query: z.infer<typeof syncScopeQuerySchema>,
  actor: RequestActor,
  access: string[] | WorkspaceAccess | null
): boolean {
  if (query.mine) {
    const assignee = task.assignee as { id?: string } | null | undefined;
    if (assignee?.id !== actor.user.id) return false;
  }

  if (query.teamId !== 'all') {
    const project = task.project as { team?: { slug?: string } | null } | null | undefined;
    if (project?.team?.slug !== query.teamId) return false;
  } else if (!taskProjectVisible(task, access)) {
    return false;
  }

  return isHotTaskRecord(task, hotCompletedCutoff(query.completedWindowDays));
}

function taskProjectVisible(task: Record<string, unknown>, access: string[] | WorkspaceAccess | null): boolean {
  if (!access) return true;

  const project = task.project as { id?: string; leadId?: string | null; team?: { id?: string } | null } | null | undefined;
  const projectId = project?.id ?? null;
  const teamId = project?.team?.id ?? null;

  if (Array.isArray(access)) {
    return !teamId || access.includes(teamId);
  }

  if (access.workspaceWide) return true;
  if (!teamId) return true;
  if (project?.leadId === access.userId) return true;
  if (projectId && access.projectIds.includes(projectId)) return true;
  return access.teamIds.includes(teamId);
}

function hotCompletedCutoff(completedWindowDays = 5): Date {
  return new Date(Date.now() - completedWindowDays * 24 * 60 * 60 * 1000);
}

function hotTaskWhere(cutoff: Date): Prisma.TaskWhereInput {
  return {
    OR: [
      { status: { notIn: ['DONE', 'CANCELED'] } },
      {
        AND: [
          { status: { in: ['DONE', 'CANCELED'] } },
          {
            OR: [
              { completedAt: { gte: cutoff } },
              { completedAt: null, updatedAt: { gte: cutoff } }
            ]
          }
        ]
      }
    ]
  };
}

function isHotTaskRecord(task: Record<string, unknown>, cutoff: Date): boolean {
  const status = stringValue(task.status);
  if (status !== 'DONE' && status !== 'CANCELED') return true;

  const completedAt = dateValue(task.completedAt);
  if (completedAt) return completedAt >= cutoff;

  const updatedAt = dateValue(task.updatedAt);
  return Boolean(updatedAt && updatedAt >= cutoff);
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const progressTaskStatuses = new Set(['IN_PROGRESS', 'IN_REVIEW']);

function withEventProgressStartedAt(
  after: Record<string, unknown>,
  before: Record<string, unknown> | null,
  eventCreatedAt: Date
): Record<string, unknown> {
  const afterStatus = stringValue(after.status);
  const beforeStatus = before ? stringValue(before.status) : null;

  if (!progressTaskStatuses.has(afterStatus || '')) {
    return { ...after, progressStartedAt: null };
  }

  if (!beforeStatus || !progressTaskStatuses.has(beforeStatus)) {
    return { ...after, progressStartedAt: eventCreatedAt.toISOString() };
  }

  return after;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function openSyncStream(
  request: FastifyRequest,
  reply: FastifyReply,
  actor: RequestActor,
  clientId?: string
): void {
  const corsOrigin = resolveCorsOrigin(request);
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(corsOrigin
      ? {
          'access-control-allow-origin': corsOrigin,
          'access-control-allow-credentials': 'true',
          vary: 'Origin'
        }
      : {})
  });

  const streamClientId = `${actor.workspace.id}:${actor.user.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const cleanup = syncHub.add({
    id: streamClientId,
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    clientId,
    send: (poke) => writeSse(reply, poke.cursor, 'sync', poke)
  });
  const heartbeat = setInterval(() => {
    reply.raw.write(': keepalive\n\n');
  }, 25000);

  const close = () => {
    clearInterval(heartbeat);
    cleanup();
  };

  request.raw.on('close', close);
  writeSse(reply, undefined, 'ready', {
    cursor: '0',
    workspaceId: actor.workspace.id,
    activeConnections: syncHub.count(actor.workspace.id)
  });
}

function writeSse(reply: FastifyReply, id: string | undefined, event: string, data: unknown): void {
  if (id) reply.raw.write(`id: ${id}\n`);
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function mutationErrorMessage(error: unknown): string {
  if (error instanceof ZodError) return 'Validation failed';
  if (error instanceof Error && error.message) return error.message;
  return 'Mutation failed';
}

function resolveCorsOrigin(request: FastifyRequest): string | null {
  const originHeader = request.headers.origin;
  return resolveAllowedCorsOrigin(originHeader);
}

function isStalePendingMutation(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() > stalePendingMutationMs;
}
