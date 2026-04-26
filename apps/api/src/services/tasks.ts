import { prisma, type Prisma, type Task, type TaskSource } from '@taskara/db';
import type { RequestActor } from './actor';
import { logActivity, snapshot } from './audit';
import type { z } from 'zod';
import type { createTaskSchema, updateTaskSchema } from '@taskara/shared';
import { serializeTaskAttachment } from './task-attachments';
import { HttpError } from './http';

type CreateTaskInput = z.infer<typeof createTaskSchema>;
type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskInclude = {
  project: {
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      parentId: true,
      team: { select: { id: true, name: true, slug: true } }
    }
  },
  assignee: { select: { id: true, name: true, email: true, mattermostUsername: true } },
  reporter: { select: { id: true, name: true, email: true, mattermostUsername: true } },
  attachments: { orderBy: { createdAt: 'asc' } },
  labels: { include: { label: true } },
  _count: { select: { comments: true, subtasks: true, blockingDependencies: true, attachments: true } }
} satisfies Prisma.TaskInclude;

export async function ensureDefaultProject(workspaceId: string): Promise<{ id: string; keyPrefix: string }> {
  return prisma.project.upsert({
    where: { workspaceId_keyPrefix: { workspaceId, keyPrefix: 'INBOX' } },
    update: {},
    create: {
      workspaceId,
      name: 'Inbox',
      keyPrefix: 'INBOX',
      description: 'Default project for quick capture and untriaged work'
    },
    select: { id: true, keyPrefix: true }
  });
}

export async function createTask(actor: RequestActor, input: CreateTaskInput) {
  const task = await prisma.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: { id: input.projectId, workspaceId: actor.workspace.id },
      select: { id: true, workspaceId: true }
    });

    if (!project) {
      throw new Error('Project not found in this workspace');
    }
    await assertTaskRelations(tx, actor.workspace.id, input, input.projectId);

    const { key, sequence } = await reserveTaskKey(tx, input.projectId);

    const created = await tx.task.create({
      data: {
        workspaceId: actor.workspace.id,
        projectId: input.projectId,
        parentId: input.parentId,
        cycleId: input.cycleId,
        key,
        sequence,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        assigneeId: input.assigneeId,
        reporterId: actor.user.id,
        dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
        source: input.source
      },
      include: taskInclude
    });

    await syncTaskLabels(tx, actor.workspace.id, created.id, input.labels);
    return tx.task.findUniqueOrThrow({ where: { id: created.id }, include: taskInclude });
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'created',
    after: task,
    source: input.source
  });

  if (task.assigneeId && task.assigneeId !== actor.user.id) {
    await prisma.notification.create({
      data: {
        workspaceId: actor.workspace.id,
        userId: task.assigneeId,
        taskId: task.id,
        type: 'task_assigned',
        title: `${task.key}: ${task.title}`,
        body: `${actor.user.name} assigned this task to you.`
      }
    });
  }

  return task;
}

async function reserveTaskKey(
  tx: Prisma.TransactionClient,
  projectId: string
): Promise<{ key: string; sequence: number }> {
  const incrementedProject = await tx.project.update({
    where: { id: projectId },
    data: { nextTaskNumber: { increment: 1 } },
    select: { keyPrefix: true, nextTaskNumber: true }
  });
  const reservedSequence = incrementedProject.nextTaskNumber - 1;

  const highestTaskSequence = await tx.task.aggregate({
    where: { projectId },
    _max: { sequence: true }
  });
  const sequence = Math.max(reservedSequence, (highestTaskSequence._max.sequence ?? 0) + 1);

  if (sequence >= incrementedProject.nextTaskNumber) {
    await tx.project.update({
      where: { id: projectId },
      data: { nextTaskNumber: sequence + 1 },
      select: { id: true }
    });
  }

  return {
    key: `${incrementedProject.keyPrefix}-${sequence}`,
    sequence
  };
}

export async function updateTask(actor: RequestActor, taskId: string, input: UpdateTaskInput) {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: actor.workspace.id },
    include: taskInclude
  });
  if (!existing) throw new Error('Task not found in this workspace');

  const task = await prisma.$transaction(async (tx) => {
    await assertTaskRelations(tx, actor.workspace.id, input, existing.projectId, taskId);

    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        title: input.title,
        description: input.description === undefined ? undefined : input.description,
        status: input.status,
        priority: input.priority,
        assigneeId: input.assigneeId === undefined ? undefined : input.assigneeId,
        parentId: input.parentId === undefined ? undefined : input.parentId,
        cycleId: input.cycleId === undefined ? undefined : input.cycleId,
        dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
        completedAt: input.status === 'DONE' ? new Date() : input.status ? null : undefined,
        version: { increment: 1 }
      },
      include: taskInclude
    });

    if (input.labels) {
      await tx.taskLabel.deleteMany({ where: { taskId } });
      await syncTaskLabels(tx, actor.workspace.id, taskId, input.labels);
    }

    return tx.task.findUniqueOrThrow({ where: { id: updated.id }, include: taskInclude });
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'updated',
    before: existing,
    after: task,
    source: actor.source
  });

  if (input.assigneeId && input.assigneeId !== existing.assigneeId) {
    await prisma.notification.create({
      data: {
        workspaceId: actor.workspace.id,
        userId: input.assigneeId,
        taskId: task.id,
        type: 'task_assigned',
        title: `${task.key}: ${task.title}`,
        body: `${actor.user.name} assigned this task to you.`
      }
    });
  }

  return task;
}

export async function addTaskComment(actor: RequestActor, taskId: string, body: string, source: TaskSource, mattermostPostId?: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId: actor.workspace.id } });
  if (!task) throw new Error('Task not found in this workspace');

  const comment = await prisma.taskComment.create({
    data: {
      taskId,
      authorId: actor.user.id,
      body,
      source,
      mattermostPostId
    },
    include: { author: { select: { id: true, name: true, email: true } } }
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'commented',
    after: comment,
    source
  });

  return comment;
}

export async function findTaskByIdOrKey(workspaceId: string, idOrKey: string): Promise<Task | null> {
  const normalized = idOrKey.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);

  return prisma.task.findFirst({
    where: {
      workspaceId,
      OR: [
        ...(isUuid ? [{ id: normalized }] : []),
        { key: normalized.toUpperCase() }
      ]
    }
  });
}

async function syncTaskLabels(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskId: string,
  rawLabels: string[]
): Promise<void> {
  const names = [...new Set(rawLabels.map((label) => label.trim()).filter(Boolean))];
  for (const name of names) {
    const label = await tx.label.upsert({
      where: { workspaceId_name: { workspaceId, name } },
      update: {},
      create: { workspaceId, name }
    });
    await tx.taskLabel.create({ data: { taskId, labelId: label.id } });
  }
}

async function assertTaskRelations(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  input: { assigneeId?: string | null; parentId?: string | null; cycleId?: string | null },
  projectId: string,
  taskId?: string
): Promise<void> {
  if (input.parentId && input.parentId === taskId) {
    throw new HttpError(400, 'Task cannot be its own parent');
  }

  const [assignee, parent, cycle] = await Promise.all([
    input.assigneeId
      ? tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } },
          select: { id: true }
        })
      : Promise.resolve(null),
    input.parentId
      ? tx.task.findFirst({ where: { id: input.parentId, workspaceId, projectId }, select: { id: true } })
      : Promise.resolve(null),
    input.cycleId
      ? tx.cycle.findFirst({
          where: {
            id: input.cycleId,
            workspaceId,
            OR: [{ projectId }, { projectId: null }]
          },
          select: { id: true }
        })
      : Promise.resolve(null)
  ]);

  if (input.assigneeId && !assignee) throw new HttpError(400, 'Assignee must belong to this workspace');
  if (input.parentId && !parent) throw new HttpError(400, 'Parent task not found in this project');
  if (input.cycleId && !cycle) throw new HttpError(400, 'Cycle not found for this project');
}

export function serializeForJson<T>(value: T): T {
  return snapshot(value) as T;
}

export function serializeTaskForResponse<T extends Record<string, unknown>>(task: T): T {
  if (!Array.isArray(task.attachments)) return task;
  return {
    ...task,
    attachments: task.attachments.map((attachment) =>
      serializeTaskAttachment(attachment as Parameters<typeof serializeTaskAttachment>[0])
    )
  };
}
