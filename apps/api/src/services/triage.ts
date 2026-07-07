import { prisma, type Prisma, type TaskSource } from '@taskara/db';
import type { z } from 'zod';
import type {
  triageAcceptSchema,
  triageDeclineSchema,
  triageDuplicateSchema,
  triageRequestInfoSchema,
  triageSplitSchema,
  triageSnoozeSchema
} from '@taskara/shared';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import { resolveWorkspaceAccess } from './team-access';
import {
  addTaskComment,
  findTaskByIdOrKey,
  serializeTaskForResponse,
  taskInclude,
  serializeForJson,
  updateTask
} from './tasks';
import { appendSyncEvent, publishSyncEvent } from './sync';
import { logActivity } from './audit';

type TriageAcceptInput = z.infer<typeof triageAcceptSchema>;
type TriageRequestInfoInput = z.infer<typeof triageRequestInfoSchema>;
type TriageDeclineInput = z.infer<typeof triageDeclineSchema>;
type TriageDuplicateInput = z.infer<typeof triageDuplicateSchema>;
type TriageSnoozeInput = z.infer<typeof triageSnoozeSchema>;
type TriageSplitInput = z.infer<typeof triageSplitSchema>;

export function canTriageTaskStatus(status: string): boolean {
  return status === 'BACKLOG';
}

export async function acceptBacklogTask(actor: RequestActor, idOrKey: string, input: TriageAcceptInput) {
  const task = await requireBacklogTask(actor, idOrKey);
  const updated = await updateTask(actor, task.id, {
    status: 'TODO',
    assigneeId: input.assigneeId === undefined ? undefined : input.assigneeId,
    priority: input.priority,
    weight: input.weight,
    dueAt: input.dueAt,
    projectId: input.projectId
  });

  const notes = [
    input.unassignedReason?.trim() ? `علت بی‌مسئول ماندن: ${input.unassignedReason.trim()}` : null,
    input.comment?.trim() ? input.comment.trim() : null
  ].filter((item): item is string => Boolean(item));
  if (notes.length) {
    await addTaskComment(actor, updated.id, `تصمیم تریاژ: کار پذیرفته شد.\n${notes.join('\n')}`, actor.source as TaskSource);
  }

  return serializeTaskForResponse(updated);
}

export async function requestBacklogTaskInfo(actor: RequestActor, idOrKey: string, input: TriageRequestInfoInput) {
  const task = await requireBacklogTask(actor, idOrKey);
  const requestedInfo = input.comment.trim();
  await prisma.taskTriageState.upsert({
    where: { taskId: task.id },
    create: {
      workspaceId: actor.workspace.id,
      taskId: task.id,
      status: 'WAITING_FOR_INFO',
      requestedInfo,
      reason: null,
      snoozedUntil: null,
      decidedById: actor.user.id
    },
    update: {
      status: 'WAITING_FOR_INFO',
      requestedInfo,
      reason: null,
      snoozedUntil: null,
      decidedById: actor.user.id
    }
  });
  await addTaskComment(actor, task.id, `درخواست اطلاعات برای تریاژ:\n${input.comment.trim()}`, actor.source as TaskSource);
  return fetchTaskForTriageResponse(task.id);
}

export async function snoozeBacklogTask(actor: RequestActor, idOrKey: string, input: TriageSnoozeInput, now = new Date()) {
  const task = await requireBacklogTask(actor, idOrKey);
  const snoozedUntil = new Date(input.snoozedUntil);
  if (Number.isNaN(snoozedUntil.getTime())) throw new HttpError(400, 'Invalid snooze date');
  if (snoozedUntil.getTime() <= now.getTime()) throw new HttpError(400, 'Snooze date must be in the future');

  const reason = input.reason.trim();
  await prisma.taskTriageState.upsert({
    where: { taskId: task.id },
    create: {
      workspaceId: actor.workspace.id,
      taskId: task.id,
      status: 'SNOOZED',
      requestedInfo: null,
      reason,
      snoozedUntil,
      decidedById: actor.user.id
    },
    update: {
      status: 'SNOOZED',
      requestedInfo: null,
      reason,
      snoozedUntil,
      decidedById: actor.user.id
    }
  });
  await addTaskComment(
    actor,
    task.id,
    `تصمیم تریاژ: کار تا ${snoozedUntil.toISOString()} تعویق شد.\nعلت: ${reason}`,
    actor.source as TaskSource
  );
  return fetchTaskForTriageResponse(task.id);
}

export async function declineBacklogTask(actor: RequestActor, idOrKey: string, input: TriageDeclineInput) {
  const task = await requireBacklogTask(actor, idOrKey);
  const updated = await updateTask(actor, task.id, { status: 'CANCELED' });
  await addTaskComment(actor, updated.id, `تصمیم تریاژ: کار رد شد.\nعلت: ${input.reason.trim()}`, actor.source as TaskSource);
  return serializeTaskForResponse(updated);
}

export async function markBacklogTaskDuplicate(actor: RequestActor, idOrKey: string, input: TriageDuplicateInput) {
  const task = await requireBacklogTask(actor, idOrKey);
  const access = await resolveWorkspaceAccess(actor);
  const canonicalTask = await findTaskByIdOrKey(actor.workspace.id, input.canonicalTaskIdOrKey, access);
  if (!canonicalTask) throw new HttpError(404, 'Canonical task not found');
  if (canonicalTask.id === task.id) throw new HttpError(400, 'Task cannot be marked duplicate of itself');

  const updated = await updateTask(actor, task.id, { status: 'CANCELED' });
  const reason = input.reason?.trim() ? `\nعلت: ${input.reason.trim()}` : '';
  await addTaskComment(
    actor,
    updated.id,
    `تصمیم تریاژ: این کار تکراری است.\nکار اصلی: ${canonicalTask.key} - ${canonicalTask.title}${reason}`,
    actor.source as TaskSource
  );
  return serializeTaskForResponse(updated);
}

export async function splitBacklogTask(actor: RequestActor, idOrKey: string, input: TriageSplitInput) {
  const task = await requireBacklogTask(actor, idOrKey);
  const createdTasks: Array<Awaited<ReturnType<typeof fetchTaskForTriageResponse>>> = [];
  let canceledTask: Awaited<ReturnType<typeof fetchTaskForTriageResponse>> | null = null;
  const syncEvents = await prisma.$transaction(async (tx) => {
    const before = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    const events = [];

    for (const item of input.items) {
      const { key, sequence } = await reserveSplitTaskKey(tx, task.projectId);
      const created = await tx.task.create({
        data: {
          workspaceId: actor.workspace.id,
          projectId: task.projectId,
          parentId: task.id,
          key,
          sequence,
          title: item.title.trim(),
          description: item.description?.trim() || null,
          status: 'BACKLOG',
          priority: 'NO_PRIORITY',
          reporterId: actor.user.id,
          source: actor.source as TaskSource
        },
        include: taskInclude
      });
      createdTasks.push(serializeTaskForResponse(created));
      events.push(await appendSyncEvent(tx, {
        workspaceId: actor.workspace.id,
        entityType: 'task',
        entityId: created.id,
        operation: 'created',
        entityVersion: created.version,
        actorId: actor.user.id,
        payload: {
          after: serializeTaskForResponse(created),
          changedFields: ['title', 'description', 'status', 'parentId', 'source']
        }
      }));
    }

    const updated = await tx.task.update({
      where: { id: task.id },
      data: {
        status: 'CANCELED',
        version: { increment: 1 }
      },
      include: taskInclude
    });
    canceledTask = serializeTaskForResponse(updated);
    const childList = createdTasks.map((child) => `${child.key} - ${child.title}`).join('\n');
    const reason = input.reason?.trim() ? `\nعلت: ${input.reason.trim()}` : '';
    const comment = await tx.taskComment.create({
      data: {
        taskId: task.id,
        authorId: actor.user.id,
        body: `تصمیم تریاژ: این ورودی به کارهای کوچک‌تر تقسیم شد.\n${childList}${reason}`,
        source: actor.source as TaskSource
      },
      include: {
        author: { select: { id: true, name: true, email: true, avatarUrl: true } },
        attachments: { orderBy: { createdAt: 'asc' } }
      }
    });

    events.push(await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: updated.id,
      operation: 'updated',
      entityVersion: updated.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(before),
        after: serializeTaskForResponse(updated),
        changedFields: ['status']
      }
    }));
    events.push(await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: updated.id,
      operation: 'commented',
      entityVersion: updated.version,
      actorId: actor.user.id,
      payload: {
        comment: serializeForJson(comment),
        after: serializeTaskForResponse(updated),
        changedFields: ['comments']
      }
    }));

    return events;
  });

  for (const event of syncEvents) publishSyncEvent(event);

  if (canceledTask) {
    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'task',
      entityId: task.id,
      action: 'triage.split',
      before: task,
      after: {
        task: canceledTask,
        children: createdTasks
      },
      source: actor.source
    }).catch(() => undefined);
  }

  return {
    task: canceledTask,
    items: createdTasks
  };
}

async function requireBacklogTask(actor: RequestActor, idOrKey: string) {
  const access = await resolveWorkspaceAccess(actor);
  const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
  if (!task) throw new HttpError(404, 'Task not found');
  if (!canTriageTaskStatus(task.status)) {
    throw new HttpError(409, 'Only backlog tasks can be triaged');
  }
  return task;
}

async function fetchTaskForTriageResponse(taskId: string) {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: taskInclude
  });
  return serializeTaskForResponse(task);
}

async function reserveSplitTaskKey(tx: Prisma.TransactionClient, projectId: string): Promise<{ key: string; sequence: number }> {
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
  return { key: `${incrementedProject.keyPrefix}-${sequence}`, sequence };
}
