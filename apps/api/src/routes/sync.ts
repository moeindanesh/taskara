import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma, type Prisma, type SyncEvent } from '@taskara/db';
import { createCommentSchema, createTaskSchema, updateTaskSchema } from '@taskara/shared';
import { z, ZodError } from 'zod';
import { getRequestActor, type RequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import { addTaskComment, createTask, deleteTask, findTaskByIdOrKey, serializeTaskForResponse, taskInclude, updateTask } from '../services/tasks';
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
  clientId: z.string().trim().min(1).max(160).optional()
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

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sync/bootstrap', async (request) => {
    const actor = await getRequestActor(request);
    const query = syncScopeQuerySchema.parse(request.query);
    const [tasksResult, projects, teams, usersResult, views, cursor] = await Promise.all([
      listTasksForScope(actor, query),
      listProjects(actor.workspace.id),
      listTeams(actor.workspace.id),
      listUsers(actor.workspace.id),
      listViews(actor, query.teamId),
      latestCursor(actor.workspace.id)
    ]);

    return {
      cursor,
      serverTime: new Date().toISOString(),
      tasks: tasksResult.items,
      projects,
      teams,
      users: usersResult.items,
      views
    };
  });

  app.get('/sync/pull', async (request) => {
    const actor = await getRequestActor(request);
    const query = syncScopeQuerySchema.parse(request.query);
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
      .map((event) => mapSyncEventForScope(event, query, actor))
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
        const entity = await applyMutation(actor, mutation.name, mutation.args, meta, mutation.baseVersion);
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
  baseVersion?: number
): Promise<unknown> {
  if (name === 'task.create') {
    const input = createTaskSchema.parse(args);
    return serializeTaskForResponse(await createTask(actor, input, meta));
  }

  if (name === 'task.update') {
    const input = updateTaskMutationArgsSchema.parse(args);
    const task = await findTaskByIdOrKey(actor.workspace.id, input.idOrKey);
    if (!task) throw new HttpError(404, 'Task not found');
    return serializeTaskForResponse(await updateTask(actor, task.id, input.patch, meta, input.baseVersion ?? baseVersion));
  }

  if (name === 'task.delete') {
    const input = deleteTaskMutationArgsSchema.parse(args);
    const task = await findTaskByIdOrKey(actor.workspace.id, input.idOrKey);
    if (!task) throw new HttpError(404, 'Task not found');
    return serializeTaskForResponse(await deleteTask(actor, task.id, meta));
  }

  if (name === 'task.comment.create') {
    const input = commentTaskMutationArgsSchema.parse(args);
    const task = await findTaskByIdOrKey(actor.workspace.id, input.idOrKey);
    if (!task) throw new HttpError(404, 'Task not found');
    return addTaskComment(actor, task.id, input.body, input.source, input.mattermostPostId, meta);
  }

  throw new HttpError(400, `Unsupported sync mutation: ${name}`);
}

async function listTasksForScope(actor: RequestActor, query: z.infer<typeof syncScopeQuerySchema>) {
  const where = taskWhereForScope(actor, query);
  const [items, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: 500
    }),
    prisma.task.count({ where })
  ]);

  return { items: items.map(serializeTaskForResponse), total };
}

function taskWhereForScope(actor: RequestActor, query: z.infer<typeof syncScopeQuerySchema>): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = {
    workspaceId: actor.workspace.id,
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

  return where;
}

async function listProjects(workspaceId: string) {
  return prisma.project.findMany({
    where: { workspaceId },
    orderBy: [{ parentId: 'asc' }, { updatedAt: 'desc' }],
    include: {
      team: { select: { id: true, name: true, slug: true } },
      parent: { select: { id: true, name: true, keyPrefix: true } },
      lead: { select: { id: true, name: true, email: true, avatarUrl: true } },
      _count: { select: { tasks: true, subprojects: true } }
    }
  });
}

async function listTeams(workspaceId: string) {
  return prisma.team.findMany({
    where: { workspaceId },
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

async function listViews(actor: RequestActor, teamId: string) {
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
  actor: RequestActor
) {
  const serialized = serializeSyncEvent(event);
  if (event.entityType !== 'task') return serialized;

  const payload = event.payload as Record<string, unknown>;
  const before = taskPayloadRecord(payload.before);
  const after = taskPayloadRecord(payload.after);
  const beforeVisible = before ? taskVisibleInScope(before, query, actor) : false;
  const afterVisible = after ? taskVisibleInScope(after, query, actor) : false;

  if (afterVisible) {
    return {
      ...serialized,
      type: 'upsert',
      task: after
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

function taskPayloadRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function taskVisibleInScope(
  task: Record<string, unknown>,
  query: z.infer<typeof syncScopeQuerySchema>,
  actor: RequestActor
): boolean {
  if (query.mine) {
    const assignee = task.assignee as { id?: string } | null | undefined;
    if (assignee?.id !== actor.user.id) return false;
  }

  if (query.teamId !== 'all') {
    const project = task.project as { team?: { slug?: string } | null } | null | undefined;
    if (project?.team?.slug !== query.teamId) return false;
  }

  return true;
}

function openSyncStream(
  request: FastifyRequest,
  reply: FastifyReply,
  actor: RequestActor,
  clientId?: string
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
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

function isStalePendingMutation(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() > stalePendingMutationMs;
}
