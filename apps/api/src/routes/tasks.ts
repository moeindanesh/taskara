import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@taskara/db';
import { createCommentSchema, createTaskSchema, taskListQuerySchema, updateTaskSchema } from '@taskara/shared';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import { createTaskAttachment, listTaskAttachments } from '../services/task-attachments';
import { sendTaskCreatedSms } from '../services/task-sms';
import { addTaskComment, createTask, deleteTask, findTaskByIdOrKey, serializeTaskForResponse, taskInclude, updateTask } from '../services/tasks';
import { readMultipartMediaUpload } from '../services/upload-request';

const leaderboardQuerySchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  teamId: z.string().min(1).default('all')
});

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/leaderboard', async (request) => {
    const actor = await getRequestActor(request);
    const query = leaderboardQuerySchema.parse(request.query);
    const startsAt = new Date(query.startsAt);
    const endsAt = new Date(query.endsAt);

    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
      throw new HttpError(400, 'Invalid leaderboard date range');
    }

    const where: Prisma.TaskWhereInput = {
      workspaceId: actor.workspace.id,
      assigneeId: { not: null },
      OR: [
        { completedAt: { gte: startsAt, lt: endsAt } },
        { completedAt: null, createdAt: { gte: startsAt, lt: endsAt } }
      ]
    };

    if (query.teamId !== 'all') {
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
    const where: Prisma.TaskWhereInput = {
      workspaceId: actor.workspace.id,
      projectId: query.projectId,
      assigneeId: query.mine ? actor.user.id : query.assigneeId,
      status: query.status,
      priority: query.priority
    };

    if (query.teamId !== 'all') {
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

    return { items: items.map(serializeTaskForResponse), total, limit: query.limit, offset: query.offset };
  });

  app.post('/tasks', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createTaskSchema.parse(request.body);
    const task = await createTask(actor, input);
    return reply.code(201).send(serializeTaskForResponse(task));
  });

  app.get('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
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
    return fullTask ? serializeTaskForResponse(fullTask) : null;
  });

  app.patch('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const input = updateTaskSchema.parse(request.body);
    const task = await updateTask(actor, existing.id, input);
    return serializeTaskForResponse(task);
  });

  app.delete('/tasks/:idOrKey', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    await deleteTask(actor, existing.id);
    return reply.code(204).send();
  });

  app.get('/tasks/:idOrKey/activity', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
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
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    return listTaskAttachments(actor, existing.id);
  });

  app.post('/tasks/:idOrKey/attachments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const upload = await readMultipartMediaUpload(request);
    const attachment = await createTaskAttachment(actor, existing.id, upload);
    return reply.code(201).send(attachment);
  });

  app.post('/tasks/:idOrKey/comments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const input = createCommentSchema.parse(request.body);
    const comment = await addTaskComment(actor, existing.id, input.body, input.source, input.mattermostPostId);
    return reply.code(201).send(comment);
  });

  app.post('/tasks/:idOrKey/sms/task-created', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const result = await sendTaskCreatedSms(actor, existing.id);
    return reply.send(result);
  });

  app.post('/tasks/:idOrKey/comments/:commentId/attachments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey, commentId } = request.params as { idOrKey: string; commentId: string };
    const existing = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    if (!existing) return reply.code(404).send({ message: 'Task not found' });

    const upload = await readMultipartMediaUpload(request);
    const attachment = await createTaskAttachment(actor, existing.id, upload, commentId);
    return reply.code(201).send(attachment);
  });

  app.post('/tasks/:idOrKey/dependencies', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const body = request.body as { blockedBy: string };
    const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey);
    const blockedBy = await findTaskByIdOrKey(actor.workspace.id, body.blockedBy);
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
