import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@taskara/db';
import {
  createCommentSchema,
  createTaskDependencySchema,
  createTaskSchema,
  strictQueryBooleanSchema,
  taskKindSchema,
  taskListQuerySchema,
  taskPatchConcurrencySchema,
  unfinishedTaskStatusFilter,
  updateTaskSchema,
  type TaskSortOrderValue
} from '@taskara/shared';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import { openBlockersWhere } from '../services/blockers';
import { HttpError } from '../services/http';
import { normalizeUploadedMediaInput, uploadedMediaInputSchema } from '../services/media';
import { measuredMemberWhere, measuredSubjectWhere } from '../services/measured-people';
import { workTaskWhere } from '../services/measured-work';
import { createTaskAttachment, listTaskAttachments } from '../services/task-attachments';
import { addTaskDependency, removeTaskDependency } from '../services/task-dependencies';
import { subscribeToTask, unsubscribeFromTask } from '../services/task-subscriptions';
import {
  assertActorCanAccessTeamSlug,
  resolveWorkspaceAccess,
  taskWhereForAccess
} from '../services/team-access';
import { sendTaskCreatedSms, sendTaskFollowUpSms } from '../services/task-sms';
import {
  addTaskComment,
  addTaskProgressStartedAt,
  claimTask,
  createTask,
  deleteTask,
  findTaskByIdOrKey,
  serializeTaskForResponse,
  taskInclude,
  updateTask
} from '../services/tasks';

const leaderboardQuerySchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  teamId: z.string().min(1).default('all')
});

const taskArchiveQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  milestoneId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  assigneeId: z.string().uuid().optional(),
  priority: z.enum(['NO_PRIORITY', 'LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  kind: taskKindSchema.optional(),
  teamId: z.string().min(1).default('all'),
  q: z.string().max(200).optional(),
  mine: strictQueryBooleanSchema.optional(),
  completedBefore: z.string().datetime().optional(),
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

type TaskListQuery = z.infer<typeof taskListQuerySchema>;

function taskStatusWhere(filter: TaskListQuery['status']): Prisma.TaskWhereInput['status'] {
  if (!filter) return undefined;
  if (filter === unfinishedTaskStatusFilter) return { notIn: ['DONE', 'CANCELED'] };
  return { in: filter };
}

/**
 * Exact name match on one label, the same semantics `GET /knowledge/pages?label=` already has, plus
 * the absence sentinel the rest of this query surface uses. A label literally named `none` is
 * therefore unreachable through this filter.
 */
function taskLabelWhere(label: TaskListQuery['label']): Prisma.TaskWhereInput['labels'] {
  if (!label) return undefined;
  return label === 'none' ? { none: {} } : { some: { label: { name: label } } };
}

/**
 * "What am I watching" and "what did I mute", as a filter on the list everybody already reads.
 *
 * #21's shape, not a `/subscriptions` endpoint: the answer wants a status filter, a project filter
 * and the effort exclusion the moment anybody looks at it, and a parallel endpoint would restate all
 * three. Scoped to the caller because a subscription is a relationship rather than a property —
 * there is no workspace-wide answer to give.
 */
function taskSubscriptionWhere(
  filter: TaskListQuery['subscription'],
  userId: string
): Pick<Prisma.TaskWhereInput, 'subscriptions' | 'mutes'> {
  if (!filter) return {};
  if (filter === 'muted') return { mutes: { some: { userId } } };
  return { subscriptions: { some: { userId } } };
}

const taskSortOrderBy = {
  'createdAt:asc': { createdAt: 'asc' },
  'createdAt:desc': { createdAt: 'desc' },
  'updatedAt:asc': { updatedAt: 'asc' },
  'updatedAt:desc': { updatedAt: 'desc' },
  'dueAt:asc': { dueAt: 'asc' },
  'dueAt:desc': { dueAt: 'desc' }
} satisfies Record<TaskSortOrderValue, Prisma.TaskOrderByWithRelationInput>;

/**
 * `id` is appended to every ordering, including the default, so that offset paging cannot drop or
 * repeat a row when the leading keys tie — which they routinely do on a freshly imported map.
 */
function taskListOrderBy(sort: TaskListQuery['sort']): Prisma.TaskOrderByWithRelationInput[] {
  const leading: Prisma.TaskOrderByWithRelationInput[] = sort
    ? [taskSortOrderBy[sort]]
    : [{ status: 'asc' }, { dueAt: 'asc' }, { updatedAt: 'desc' }];
  return [...leading, { id: 'asc' }];
}

/**
 * A stale write, turned into an answer the loser can act on without asking again.
 *
 * "Re-read and retry" is the price of optimistic concurrency, and half of it is a round trip the
 * server can simply skip: it has just read the row in order to discover the conflict, so it hands it
 * back. A session whose appended line was refused gets the current body and the current version in
 * the 409 and can re-apply immediately, which is what keeps the retry a loop of one.
 *
 * Returns `null` for anything that is not a 409, so an unrelated failure keeps its own status.
 */
async function describeStaleWrite(
  workspaceId: string,
  taskId: string,
  error: unknown
): Promise<Record<string, unknown> | null> {
  if (!(error instanceof HttpError) || error.statusCode !== 409) return null;

  const current = await prisma.task.findFirst({ where: { id: taskId, workspaceId }, include: taskInclude });
  if (!current) return { message: error.message };

  const [decoratedTask] = await addTaskProgressStartedAt(workspaceId, [serializeTaskForResponse(current)]);
  return {
    message: `${current.key} changed on another client: it is now version ${current.version}, and this`
      + ' write was based on an older one. The current row is in this response — re-apply your change'
      + ' to it and send it back with the version it carries.',
    ...decoratedTask
  };
}

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/leaderboard', async (request) => {
    const actor = await getRequestActor(request);
    const query = leaderboardQuerySchema.parse(request.query);
    const access = await resolveWorkspaceAccess(actor);
    const startsAt = new Date(query.startsAt);
    const endsAt = new Date(query.endsAt);

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
      throw new HttpError(400, 'Invalid leaderboard date range');
    }

    const where: Prisma.TaskWhereInput = {
      ...taskWhereForAccess(access),
      assigneeId: { not: null },
      OR: [
        { completedAt: { gte: startsAt, lt: endsAt } },
        { completedAt: null, createdAt: { gte: startsAt, lt: endsAt } }
      ]
    };

    if (query.teamId !== 'all') {
      await assertActorCanAccessTeamSlug(actor, query.teamId);
      where.project = {
        team: {
          workspaceId: actor.workspace.id,
          slug: query.teamId
        }
      };
    }

    // A `by: ['assigneeId']` rollup is a per-person ranking however task-shaped its rows look, so
    // both groupBys carry the predicate on the assignee. Today the loop below reads them by measured
    // member id, which would hide an agent's row anyway — but that safety lives in one `for` line,
    // and iterating the group rows instead (the obvious way to write "everyone who did work") would
    // put every agent back on the leaderboard. Filtering at the query is what survives that edit.
    const [assignedCounts, doneCounts, members] = await Promise.all([
      prisma.task.groupBy({
        by: ['assigneeId'],
        where: { ...where, assignee: { is: measuredSubjectWhere(actor.workspace.id) } },
        _count: { _all: true }
      }),
      prisma.task.groupBy({
        by: ['assigneeId'],
        where: {
          ...where,
          assignee: { is: measuredSubjectWhere(actor.workspace.id) },
          status: 'DONE'
        },
        _count: { _all: true }
      }),
      // The leaderboard ranks people against each other. An agent on it changes real humans' rank
      // positions when it is productive and pads the total when it is idle.
      prisma.workspaceMember.findMany({
        where: { workspaceId: actor.workspace.id, ...measuredMemberWhere },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true
            }
          }
        }
      })
    ]);

    const assignedByUser = new Map<string, number>();
    const doneByUser = new Map<string, number>();

    for (const item of assignedCounts) {
      if (!item.assigneeId) continue;
      assignedByUser.set(item.assigneeId, item._count._all);
    }

    for (const item of doneCounts) {
      if (!item.assigneeId) continue;
      doneByUser.set(item.assigneeId, item._count._all);
    }

    const items = members
      .map((member) => {
        const assignedCount = assignedByUser.get(member.user.id) || 0;
        const doneCount = doneByUser.get(member.user.id) || 0;
        const speedRatio = assignedCount ? doneCount / assignedCount : 0;

        return {
          userId: member.user.id,
          name: member.user.name,
          email: member.user.email,
          avatarUrl: member.user.avatarUrl,
          assignedCount,
          doneCount,
          speedRatio
        };
      })
      .sort((a, b) => {
        if (b.doneCount !== a.doneCount) return b.doneCount - a.doneCount;
        if (b.assignedCount !== a.assignedCount) return b.assignedCount - a.assignedCount;
        return a.name.localeCompare(b.name, 'fa');
      });

    return { items, total: items.length };
  });

  app.get('/tasks', async (request) => {
    const actor = await getRequestActor(request);
    const query = taskListQuerySchema.parse(request.query);
    const access = await resolveWorkspaceAccess(actor);
    // WORK LIST by default, READ PATH on request. Unqualified, this is the issue list, the
    // milestone "add existing tasks" picker and the assistant's task search, none of which is
    // asking about an agent's map. `?kind=EFFORT` is how an effort surface lists efforts, and it
    // is the only reason "excluded" here does not amount to "deleted".
    const where: Prisma.TaskWhereInput = {
      ...taskWhereForAccess(access),
      ...(query.kind ? { kind: query.kind } : workTaskWhere),
      projectId: query.projectId,
      milestoneId: query.milestoneId === 'none' ? null : query.milestoneId,
      // Filters the CHILDREN, never the parent, so this composes with the effort exclusion instead
      // of fighting it: an effort's children are ordinary WORK and stay listable while the effort
      // itself does not. Reaching the effort row is the `kind` parameter's job, not this one's.
      parentId: query.parentId === 'none' ? null : query.parentId,
      assigneeId: query.mine
        ? actor.user.id
        : query.assigneeId === 'none' ? null : query.assigneeId,
      status: taskStatusWhere(query.status),
      priority: query.priority,
      labels: taskLabelWhere(query.label),
      blockingDependencies: openBlockersWhere(query.blockers),
      ...taskSubscriptionWhere(query.subscription, actor.user.id)
    };

    if (query.teamId !== 'all') {
      await assertActorCanAccessTeamSlug(actor, query.teamId);
      where.project = {
        team: {
          workspaceId: actor.workspace.id,
          slug: query.teamId
        }
      };
    }

    if (query.q) {
      where.OR = [
        { key: { contains: query.q.toUpperCase(), mode: 'insensitive' } },
        { title: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } }
      ];
    }

    const [items, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: taskInclude,
        orderBy: taskListOrderBy(query.sort),
        take: query.limit,
        skip: query.offset
      }),
      prisma.task.count({ where })
    ]);

    return {
      items: await addTaskProgressStartedAt(actor.workspace.id, items.map(serializeTaskForResponse)),
      total,
      limit: query.limit,
      offset: query.offset
    };
  });

  app.get('/tasks/archive', async (request) => {
    const actor = await getRequestActor(request);
    const query = taskArchiveQuerySchema.parse(request.query);
    const access = await resolveWorkspaceAccess(actor);
    const completedBefore = query.completedBefore
      ? new Date(query.completedBefore)
      : completedArchiveCutoff();
    // WORK LIST by default — the archive is presented to a human as finished and abandoned WORK.
    // This is a live leak rather than a latent one: `Task_effort_status` permits DONE and CANCELED
    // for an EFFORT, and the DONE path writes a real completedAt. Same `kind` escape hatch as the
    // list above, so a future effort surface can show its own archive.
    const where: Prisma.TaskWhereInput = {
      ...taskWhereForAccess(access),
      ...(query.kind ? { kind: query.kind } : workTaskWhere),
      projectId: query.projectId,
      milestoneId: query.milestoneId === 'none' ? null : query.milestoneId,
      assigneeId: query.mine ? actor.user.id : query.assigneeId,
      priority: query.priority,
      status: { in: ['DONE', 'CANCELED'] },
      OR: [
        { completedAt: { lt: completedBefore } },
        { completedAt: null, updatedAt: { lt: completedBefore } }
      ]
    };

    if (query.teamId !== 'all') {
      await assertActorCanAccessTeamSlug(actor, query.teamId);
      where.project = {
        team: {
          workspaceId: actor.workspace.id,
          slug: query.teamId
        }
      };
    }

    if (query.q) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { key: { contains: query.q.toUpperCase(), mode: 'insensitive' } },
            { title: { contains: query.q, mode: 'insensitive' } },
            { description: { contains: query.q, mode: 'insensitive' } }
          ]
        }
      ];
    }

    const rows = await prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
      skip: query.cursor
    });
    const items = rows.slice(0, query.limit);

    return {
      items: await addTaskProgressStartedAt(actor.workspace.id, items.map(serializeTaskForResponse)),
      total: await prisma.task.count({ where }),
      limit: query.limit,
      cursor: query.cursor,
      nextCursor: rows.length > query.limit ? String(query.cursor + query.limit) : null,
      completedBefore: completedBefore.toISOString()
    };
  });

  app.post('/tasks', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createTaskSchema.parse(request.body);
    const task = await createTask(actor, input);
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(task)]);
    return reply.code(201).send(decoratedTask);
  });

  app.get('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!task) return reply.code(404).send({ message: 'Task not found' });

    const fullTask = await prisma.task.findUnique({
      where: { id: task.id },
      include: {
        ...taskInclude,
        comments: {
          orderBy: { createdAt: 'asc' },
          include: {
            author: { select: { id: true, name: true, email: true, mattermostUsername: true, avatarUrl: true } },
            attachments: { orderBy: { createdAt: 'asc' } }
          }
        },
        subtasks: { orderBy: { createdAt: 'asc' } },
        // Filtered on the far end of each edge, not on this task. An effort cannot be an endpoint of
        // a blocking edge -- assertBothAreWork refuses one -- so this covers only edges predating
        // that guard, and it costs nothing to keep an effort out of a human's dependencies list.
        blockingDependencies: { where: { blockedByTask: workTaskWhere }, include: { blockedByTask: true } },
        blockedTasks: { where: { task: workTaskWhere }, include: { task: true } }
      }
    });
    if (!fullTask) return null;
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(fullTask)]);
    return decoratedTask;
  });

  // Optimistic concurrency lives here rather than in `updateTask`, because it is a property of this
  // path and not of the operation. /sync is the web client's mutation queue: it carries its own
  // `baseVersion` where it has one, and a first push that has no prior version to quote must still
  // be allowed through. This is the path an agent uses, and an agent editing a body has always just
  // read one.
  app.patch('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    // Parsed off the body separately, before the patch. `updateTaskSchema` does not declare
    // `baseVersion` and would strip it silently — a caller that sent the protection would be told
    // nothing and would believe it had it.
    const { baseVersion } = taskPatchConcurrencySchema.parse(request.body ?? {});
    const input = updateTaskSchema.parse(request.body);

    // An Effort's body is an index every resolving session appends a line to, and there is no
    // recovering a line that was overwritten: the ticket holding the detail is already closed. So
    // the version is required rather than merely available — an optional guard is one somebody
    // forgets on the write that mattered, and the failure is silent by construction.
    //
    // Scoped to EFFORT on purpose. A work task's description is a value one caller sets, not a
    // shared document; requiring the round trip there would make every `task edit --body` a
    // two-step operation to protect a race nothing has ever hit.
    if (existing.kind === 'EFFORT' && input.description !== undefined && baseVersion === undefined) {
      return reply.code(400).send({
        message: `Rewriting an Effort's body requires baseVersion: read ${existing.key}, then send the`
          + ' version you read back as baseVersion. Two sessions resolve tickets against one Effort at'
          + ' once, and a write that is no longer based on the current body is refused with 409 rather'
          + ' than overwriting the other session\'s line.'
      });
    }

    let task;
    try {
      task = await updateTask(actor, existing.id, input, undefined, baseVersion);
    } catch (error) {
      const conflict = await describeStaleWrite(actor.workspace.id, existing.id, error);
      if (conflict) return reply.code(409).send(conflict);
      throw error;
    }
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(task)]);
    return decoratedTask;
  });

  // Taking a task, as opposed to being given one. A distinct route rather than a flag on PATCH
  // because it is conditional: it succeeds only if nobody holds the task, and folding that into
  // `assigneeId` would make one field sometimes-conditional depending on its value.
  //
  // 409 is the whole contract. A caller that loses gets the holder in the body and must not treat
  // the task as its own — that misreading is what produced two parallel implementations of #33.
  app.post('/tasks/:idOrKey/claim', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const { claimed, task } = await claimTask(actor, existing.id);
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(task)]);
    if (claimed) return decoratedTask;

    const holder = task.assignee;
    return reply.code(409).send({
      message: holder
        ? `${task.key} is already claimed by ${holder.name}`
        : `${task.key} could not be claimed`,
      ...decoratedTask
    });
  });

  app.delete('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    // Destruction is broader than a tracker agent needs. Everything else an agent does to a task —
    // create, read, update, status, comment, label, dependency, subtask — stays permitted.
    if (actor.user.kind === 'AGENT') {
      return reply.code(403).send({ message: 'Agents cannot delete tasks' });
    }
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    await deleteTask(actor, existing.id);
    return reply.code(204).send();
  });

  // Watching a task, as a thing you choose rather than a thing that happens to you.
  //
  // A subresource rather than a flag on PATCH, because it is the caller's own relationship to the
  // task and not a property of the task: two people can hold different answers at the same moment,
  // and PATCH bodies describe one shared row.
  app.post('/tasks/:idOrKey/subscription', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    // #39 settled that an agent is not an audience for notifications: it has no inbox and never
    // polls one, so a subscription for one is a row that is written, never read and never cleared.
    // Refused rather than quietly accepted, because a surface that reports success for something it
    // did not do is one a caller routes around later.
    if (actor.user.kind === 'AGENT') {
      return reply.code(400).send({
        message: 'Agents receive no notifications, so they cannot watch a task. Find work by querying'
          + ' the frontier instead.'
      });
    }

    await subscribeToTask(actor, existing.id);
    return { state: 'watching' };
  });

  app.delete('/tasks/:idOrKey/subscription', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    await unsubscribeFromTask(actor, existing.id);
    return reply.code(204).send();
  });

  app.get('/tasks/:idOrKey/activity', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    return prisma.activityLog.findMany({
      where: {
        workspaceId: actor.workspace.id,
        entityType: 'task',
        entityId: existing.id
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { actor: { select: { id: true, name: true, email: true, avatarUrl: true } } }
    });
  });

  app.get('/tasks/:idOrKey/attachments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    return listTaskAttachments(actor, existing.id);
  });

  app.post('/tasks/:idOrKey/attachments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const media = normalizeUploadedMediaInput(uploadedMediaInputSchema.parse(request.body));
    const attachment = await createTaskAttachment(actor, existing.id, media);
    return reply.code(201).send(attachment);
  });

  app.post('/tasks/:idOrKey/comments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const input = createCommentSchema.parse(request.body);
    const comment = await addTaskComment(actor, existing.id, input.body, input.source, input.mattermostPostId);
    return reply.code(201).send(comment);
  });

  app.post('/tasks/:idOrKey/sms/task-created', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const result = await sendTaskCreatedSms(actor, existing.id);
    return reply.send(result);
  });

  app.post('/tasks/:idOrKey/sms/follow-up', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const result = await sendTaskFollowUpSms(actor, existing.id);
    return reply.send(result);
  });

  app.post('/tasks/:idOrKey/comments/:commentId/attachments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey, commentId } = request.params as { idOrKey: string; commentId: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const media = normalizeUploadedMediaInput(uploadedMediaInputSchema.parse(request.body));
    const attachment = await createTaskAttachment(actor, existing.id, media, commentId);
    return reply.code(201).send(attachment);
  });

  app.post('/tasks/:idOrKey/dependencies', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    // Parsed, not cast. The old `request.body as { blockedBy: string }` turned a missing body into
    // a 500 with a TypeError in it, which tells a caller nothing and tells a log reader too much.
    const input = createTaskDependencySchema.parse(request.body);
    const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    const blockedBy = await findTaskByIdOrKey(actor.workspace.id, input.blockedBy, access);
    if (!task || !blockedBy) return reply.code(404).send({ message: 'Task or dependency not found' });

    const { dependency } = await addTaskDependency(actor, task, blockedBy);
    return reply.code(201).send(dependency);
  });

  // The edge is addressed by its two endpoints rather than by a dependency id, because that is what
  // the caller who wants it gone actually holds — it is the same pair they sent to create it, and
  // the POST response is not something an agent re-reading a task ever saw.
  app.delete('/tasks/:idOrKey/dependencies/:blockedByIdOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey, blockedByIdOrKey } = request.params as { idOrKey: string; blockedByIdOrKey: string };
    const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    const blockedBy = await findTaskByIdOrKey(actor.workspace.id, blockedByIdOrKey, access);
    if (!task || !blockedBy) return reply.code(404).send({ message: 'Task or dependency not found' });

    await removeTaskDependency(actor, task, blockedBy);
    return reply.code(204).send();
  });
}

function completedArchiveCutoff(): Date {
  return new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
}
