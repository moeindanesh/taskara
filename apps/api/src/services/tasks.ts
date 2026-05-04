import { prisma, type Prisma, type SyncEvent, type Task, type TaskSource } from '@taskara/db';
import type { RequestActor } from './actor';
import { logActivity, snapshot } from './audit';
import type { z } from 'zod';
import type { createTaskSchema, updateTaskSchema } from '@taskara/shared';
import { serializeTaskAttachment } from './task-attachments';
import { HttpError } from './http';
import {
  TASK_ASSIGNED_NOTIFICATION_TYPE,
  TASK_COMMENTED_NOTIFICATION_TYPE,
  TASK_DESCRIPTION_CHANGED_NOTIFICATION_TYPE,
  TASK_STATUS_CHANGED_NOTIFICATION_TYPE,
  createTaskSubscriberNotifications,
  createTaskMentionNotifications,
  subscribeTaskParticipants,
  subscribeUsersToTask,
  taskAssignedNotificationBody,
  taskCommentedNotificationBody,
  taskDescriptionChangedNotificationBody,
  taskStatusChangedNotificationBody
} from './notifications';
import { appendSyncEvent, publishSyncEvent, type SyncMutationMeta } from './sync';

type CreateTaskInput = z.infer<typeof createTaskSchema>;
type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

const progressTaskStatuses = new Set(['IN_PROGRESS', 'IN_REVIEW']);

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
  assignee: { select: { id: true, name: true, email: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  reporter: { select: { id: true, name: true, email: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  attachments: { where: { commentId: null }, orderBy: { createdAt: 'asc' } },
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

export async function createTask(actor: RequestActor, input: CreateTaskInput, syncMutation?: SyncMutationMeta) {
  let syncEvent: SyncEvent | null = null;
  const task = await prisma.$transaction(async (tx) => {
    await assertActorCanAccessProject(tx, actor, input.projectId);
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
        weight: input.weight ?? undefined,
        assigneeId: input.assigneeId,
        reporterId: actor.user.id,
        dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
        source: input.source
      },
      include: taskInclude
    });

    await syncTaskLabels(tx, actor.workspace.id, created.id, input.labels);
    const task = await tx.task.findUniqueOrThrow({ where: { id: created.id }, include: taskInclude });
    await subscribeTaskParticipants(tx, {
      workspaceId: actor.workspace.id,
      task,
      userIds: [actor.user.id]
    });
    await createTaskMentionNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      actorName: actor.user.name,
      task
    });
    if (task.assigneeId && task.assigneeId !== actor.user.id) {
      await tx.notification.create({
        data: {
          workspaceId: actor.workspace.id,
          userId: task.assigneeId,
          taskId: task.id,
          type: TASK_ASSIGNED_NOTIFICATION_TYPE,
          title: `${task.key}: ${task.title}`,
          body: taskAssignedNotificationBody(actor.user.name)
        }
      });
    }
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: task.id,
      operation: 'created',
      entityVersion: task.version,
      actorId: actor.user.id,
      payload: {
        after: serializeTaskForResponse(task),
        changedFields: Object.keys(input)
      },
      mutation: syncMutation
    });
    return task;
  });

  if (syncEvent) publishSyncEvent(syncEvent);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'created',
    after: task,
    source: input.source
  }).catch(() => undefined);

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

export async function updateTask(
  actor: RequestActor,
  taskId: string,
  input: UpdateTaskInput,
  syncMutation?: SyncMutationMeta,
  baseVersion?: number
) {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: actor.workspace.id },
    include: taskInclude
  });
  if (!existing) throw new Error('Task not found in this workspace');
  await assertNoConflictingTaskUpdate(actor.workspace.id, taskId, input, existing.version, baseVersion);

  let syncEvent: SyncEvent | null = null;
  const task = await prisma.$transaction(async (tx) => {
    const targetProjectId = input.projectId ?? existing.projectId;
    const isProjectChange = targetProjectId !== existing.projectId;

    if (isProjectChange) {
      await assertActorCanAccessProject(tx, actor, targetProjectId);
    }

    await assertTaskRelations(tx, actor.workspace.id, input, targetProjectId, taskId);
    const reservedKey = isProjectChange ? await reserveTaskKey(tx, targetProjectId) : null;

    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        projectId: isProjectChange ? targetProjectId : undefined,
        key: reservedKey?.key,
        sequence: reservedKey?.sequence,
        title: input.title,
        description: input.description === undefined ? undefined : input.description,
        status: input.status,
        priority: input.priority,
        weight: input.weight === undefined ? undefined : input.weight,
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

    const task = await tx.task.findUniqueOrThrow({ where: { id: updated.id }, include: taskInclude });
    if (input.assigneeId) {
      await subscribeUsersToTask(tx, {
        workspaceId: actor.workspace.id,
        taskId: task.id,
        userIds: [input.assigneeId]
      });
    }

    if (input.description !== undefined) {
      await subscribeTaskParticipants(tx, {
        workspaceId: actor.workspace.id,
        task
      });
    }

    let mentionedUserIds: string[] = [];
    if (input.description !== undefined) {
      mentionedUserIds = await createTaskMentionNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorUserId: actor.user.id,
        actorName: actor.user.name,
        task,
        previousDescription: existing.description
      });
    }

    if (input.assigneeId && input.assigneeId !== existing.assigneeId && input.assigneeId !== actor.user.id) {
      await tx.notification.create({
        data: {
          workspaceId: actor.workspace.id,
          userId: input.assigneeId,
          taskId: task.id,
          type: TASK_ASSIGNED_NOTIFICATION_TYPE,
          title: `${task.key}: ${task.title}`,
          body: taskAssignedNotificationBody(actor.user.name)
        }
      });
    }

    if (input.status && input.status !== existing.status) {
      await createTaskSubscriberNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorUserId: actor.user.id,
        task,
        type: TASK_STATUS_CHANGED_NOTIFICATION_TYPE,
        body: taskStatusChangedNotificationBody(actor.user.name, existing.status, input.status)
      });
    }

    if (input.description !== undefined && (task.description ?? null) !== (existing.description ?? null)) {
      await createTaskSubscriberNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorUserId: actor.user.id,
        task,
        type: TASK_DESCRIPTION_CHANGED_NOTIFICATION_TYPE,
        body: taskDescriptionChangedNotificationBody(actor.user.name),
        excludeUserIds: mentionedUserIds
      });
    }

    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: task.id,
      operation: 'updated',
      entityVersion: task.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(existing),
        after: serializeTaskForResponse(task),
        changedFields: Object.keys(input)
      },
      mutation: syncMutation
    });
    return task;
  });

  if (syncEvent) publishSyncEvent(syncEvent);

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
  }).catch(() => undefined);

  return task;
}

export async function deleteTask(actor: RequestActor, taskId: string, syncMutation?: SyncMutationMeta) {
  let syncEvent: SyncEvent | null = null;
  const existing = await prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: { id: taskId, workspaceId: actor.workspace.id },
      include: taskInclude
    });
    if (!existing) throw new Error('Task not found in this workspace');

    await tx.task.delete({ where: { id: taskId } });
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: existing.id,
      operation: 'deleted',
      entityVersion: existing.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(existing),
        changedFields: ['deleted']
      },
      mutation: syncMutation
    });
    return existing;
  });

  if (syncEvent) publishSyncEvent(syncEvent);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: existing.id,
    action: 'deleted',
    before: existing,
    source: actor.source
  }).catch(() => undefined);

  return existing;
}

export async function addTaskComment(
  actor: RequestActor,
  taskId: string,
  body: string,
  source: TaskSource,
  mattermostPostId?: string,
  syncMutation?: SyncMutationMeta
) {
  let syncEvent: SyncEvent | null = null;
  const { task, comment } = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, workspaceId: actor.workspace.id } });
    if (!task) throw new Error('Task not found in this workspace');

    const comment = await tx.taskComment.create({
      data: {
        taskId,
        authorId: actor.user.id,
        body,
        source,
        mattermostPostId
      },
      include: {
        author: { select: { id: true, name: true, email: true, avatarUrl: true } },
        attachments: { orderBy: { createdAt: 'asc' } }
      }
    });
    const updatedTask = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    await createTaskSubscriberNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      task: updatedTask,
      type: TASK_COMMENTED_NOTIFICATION_TYPE,
      body: taskCommentedNotificationBody(actor.user.name)
    });
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: task.id,
      operation: 'commented',
      entityVersion: updatedTask.version,
      actorId: actor.user.id,
      payload: {
        comment: serializeForJson(comment),
        after: serializeTaskForResponse(updatedTask),
        changedFields: ['comments']
      },
      mutation: syncMutation
    });
    return { task, comment };
  });

  if (syncEvent) publishSyncEvent(syncEvent);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'commented',
    after: comment,
    source
  }).catch(() => undefined);

  return comment;
}

export async function findTaskByIdOrKey(
  workspaceId: string,
  idOrKey: string,
  accessibleTeamIds: string[] | null = null
): Promise<Task | null> {
  const normalized = idOrKey.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);

  return prisma.task.findFirst({
    where: {
      workspaceId,
      ...(accessibleTeamIds ? { project: { OR: [{ teamId: null }, { teamId: { in: accessibleTeamIds } }] } } : {}),
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

async function assertActorCanAccessProject(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  projectId: string
): Promise<{ id: string; teamId: string | null }> {
  const project = await tx.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspace.id },
    select: { id: true, teamId: true }
  });
  if (!project) throw new HttpError(400, 'Project not found in this workspace');

  if (!project.teamId) return project;

  const membership = await tx.teamMember.findUnique({
    where: {
      teamId_userId: {
        teamId: project.teamId,
        userId: actor.user.id
      }
    },
    select: { id: true }
  });

  if (!membership) throw new HttpError(403, 'Project access denied');
  return project;
}

async function assertNoConflictingTaskUpdate(
  workspaceId: string,
  taskId: string,
  input: UpdateTaskInput,
  currentVersion: number,
  baseVersion?: number
): Promise<void> {
  if (baseVersion === undefined || baseVersion >= currentVersion) return;

  const changedFields = new Set(Object.keys(input));
  if (changedFields.size === 0) return;

  const remoteEvents = await prisma.syncEvent.findMany({
    where: {
      workspaceId,
      entityType: 'task',
      entityId: taskId,
      entityVersion: { gt: baseVersion },
      operation: { in: ['updated', 'deleted'] }
    },
    select: { operation: true, payload: true }
  });

  if (hasTaskFieldConflict([...changedFields], remoteEvents)) {
    throw new HttpError(409, 'Task changed on another client');
  }
}

export function hasTaskFieldConflict(
  localChangedFields: string[],
  remoteEvents: Array<{ operation: string; payload: unknown }>
): boolean {
  const changedFields = new Set(localChangedFields);
  for (const event of remoteEvents) {
    if (event.operation === 'deleted') {
      return true;
    }

    const remoteChangedFields = syncEventChangedFields(event.payload);
    if (remoteChangedFields.some((field) => changedFields.has(field))) {
      return true;
    }
  }
  return false;
}

function syncEventChangedFields(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || !('changedFields' in payload)) return [];
  const changedFields = (payload as { changedFields?: unknown }).changedFields;
  return Array.isArray(changedFields) ? changedFields.filter((field): field is string => typeof field === 'string') : [];
}

export function serializeForJson<T>(value: T): T {
  return snapshot(value) as T;
}

export function serializeTaskForResponse<T extends Record<string, unknown>>(task: T): T {
  const taskRecord = task as Record<string, unknown>;
  const serialized: Record<string, unknown> = { ...taskRecord };

  if (Array.isArray(taskRecord.attachments)) {
    serialized.attachments = taskRecord.attachments.map((attachment) =>
      serializeTaskAttachment(attachment as Parameters<typeof serializeTaskAttachment>[0])
    );
  }
  if (Array.isArray(taskRecord.comments)) {
    serialized.comments = taskRecord.comments.map((comment) => {
      if (!comment || typeof comment !== 'object' || !('attachments' in comment)) return comment;
      const typedComment = comment as Record<string, unknown>;
      if (!Array.isArray(typedComment.attachments)) return comment;
      return {
        ...typedComment,
        attachments: typedComment.attachments.map((attachment) =>
          serializeTaskAttachment(attachment as Parameters<typeof serializeTaskAttachment>[0])
        )
      };
    });
  }
  return serialized as T;
}

type TaskWithProgressTimestamp = Record<string, unknown> & {
  id: string;
  status?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  progressStartedAt?: string | null;
};

export async function addTaskProgressStartedAt<T extends TaskWithProgressTimestamp>(
  workspaceId: string,
  tasks: T[]
): Promise<T[]> {
  const progressTasks = tasks.filter((task) => task.id && isProgressTaskStatus(task.status));
  if (progressTasks.length === 0) {
    return tasks.map((task) => ({ ...task, progressStartedAt: null }));
  }

  const taskIds = progressTasks.map((task) => task.id);
  const startedAtByTaskId = await progressStartedAtByTaskId(workspaceId, taskIds);

  return tasks.map((task) => {
    if (!isProgressTaskStatus(task.status)) return { ...task, progressStartedAt: null };
    return {
      ...task,
      progressStartedAt:
        startedAtByTaskId.get(task.id) ||
        isoString(task.updatedAt) ||
        isoString(task.createdAt) ||
        null
    };
  });
}

async function progressStartedAtByTaskId(workspaceId: string, taskIds: string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();

  const events = await prisma.syncEvent.findMany({
    where: {
      workspaceId,
      entityType: 'task',
      entityId: { in: taskIds },
      operation: { in: ['created', 'updated'] }
    },
    orderBy: { workspaceSeq: 'asc' },
    select: {
      entityId: true,
      operation: true,
      payload: true,
      createdAt: true
    }
  });
  const startedAtByTaskId = new Map<string, string>();

  for (const event of events) {
    const payload = recordValue(event.payload);
    const beforeStatus = taskStatusFromPayload(payload?.before);
    const afterStatus = taskStatusFromPayload(payload?.after);

    if (!afterStatus) continue;

    if (isProgressTaskStatus(afterStatus)) {
      if (event.operation === 'created' || !isProgressTaskStatus(beforeStatus)) {
        startedAtByTaskId.set(event.entityId, event.createdAt.toISOString());
      }
      continue;
    }

    startedAtByTaskId.delete(event.entityId);
  }

  return startedAtByTaskId;
}

function taskStatusFromPayload(value: unknown): string | null {
  const record = recordValue(value);
  const status = record?.status;
  return typeof status === 'string' ? status : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function isProgressTaskStatus(status: unknown): boolean {
  return typeof status === 'string' && progressTaskStatuses.has(status);
}

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
