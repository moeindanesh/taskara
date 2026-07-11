import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@taskara/db';
import { createCommentSchema, createTaskSchema, taskListQuerySchema, updateTaskSchema } from '@taskara/shared';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import { normalizeUploadedMediaInput, uploadedMediaInputSchema } from '../services/media';
import { createTaskAttachment, listTaskAttachments } from '../services/task-attachments';
import {
  assertActorCanAccessTeamSlug,
  resolveWorkspaceAccess,
  taskWhereForAccess
} from '../services/team-access';
import { sendTaskCreatedSms, sendTaskFollowUpSms } from '../services/task-sms';
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
  teamId: z.string().min(1).default('all'),
  q: z.string().max(200).optional(),
  mine: z.coerce.boolean().optional(),
  completedBefore: z.string().datetime().optional(),
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

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

    const [assignedCounts, doneCounts, members] = await Promise.all([
      prisma.task.groupBy({
        by: ['assigneeId'],
        where,
        _count: { _all: true }
      }),
      prisma.task.groupBy({
        by: ['assigneeId'],
        where: {
          ...where,
          status: 'DONE'
        },
        _count: { _all: true }
      }),
      prisma.workspaceMember.findMany({
        where: { workspaceId: actor.workspace.id },
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
    const where: Prisma.TaskWhereInput = {
      ...taskWhereForAccess(access),
      projectId: query.projectId,
      milestoneId: query.milestoneId === 'none' ? null : query.milestoneId,
      assigneeId: query.mine ? actor.user.id : query.assigneeId,
      status: query.status,
      priority: query.priority
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
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { updatedAt: 'desc' }],
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
    const where: Prisma.TaskWhereInput = {
      ...taskWhereForAccess(access),
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
        blockingDependencies: { include: { blockedByTask: true } },
        blockedTasks: { include: { task: true } }
      }
    });
    if (!fullTask) return null;
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(fullTask)]);
    return decoratedTask;
  });

  app.patch('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const input = updateTaskSchema.parse(request.body);
    const task = await updateTask(actor, existing.id, input);
    const [decoratedTask] = await addTaskProgressStartedAt(actor.workspace.id, [serializeTaskForResponse(task)]);
    return decoratedTask;
  });

  app.delete('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    await deleteTask(actor, existing.id);
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
    const body = request.body as { blockedBy: string };
    const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
    const blockedBy = await findTaskByIdOrKey(actor.workspace.id, body.blockedBy, access);
    if (!task || !blockedBy) return reply.code(404).send({ message: 'Task or dependency not found' });
    if (task.id === blockedBy.id) return reply.code(400).send({ message: 'Task cannot block itself' });

    const dependency = await prisma.taskDependency.upsert({
      where: { taskId_blockedByTaskId: { taskId: task.id, blockedByTaskId: blockedBy.id } },
      update: {},
      create: { taskId: task.id, blockedByTaskId: blockedBy.id }
    });

    return reply.code(201).send(dependency);
  });
}

function completedArchiveCutoff(): Date {
  return new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
}
