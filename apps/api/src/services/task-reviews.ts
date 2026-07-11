import { prisma, type Prisma, type SyncEvent, type TaskReviewRequest } from '@taskara/db';
import type { z } from 'zod';
import type {
  reassignTaskReviewSchema,
  requestTaskReviewSchema,
  taskReviewDecisionSchema
} from '@taskara/shared';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { appendMilestoneProgressSyncEvents, lockMilestonesForUpdate } from './milestones';
import {
  TASK_REVIEW_DECIDED_NOTIFICATION_TYPE,
  TASK_REVIEW_REQUESTED_NOTIFICATION_TYPE,
  subscribeUsersToTask,
  taskReviewApprovedNotificationBody,
  taskReviewChangesRequestedNotificationBody,
  taskReviewRequestedNotificationBody
} from './notifications';
import { appendSyncEvent, publishSyncEvent } from './sync';
import { resolveWorkspaceAccess, taskWhereForAccess } from './team-access';
import { findTaskByIdOrKey, serializeTaskForResponse, taskInclude, updateTask } from './tasks';

type RequestTaskReviewInput = z.infer<typeof requestTaskReviewSchema>;
type ReassignTaskReviewInput = z.infer<typeof reassignTaskReviewSchema>;
type ReviewDecisionInput = z.infer<typeof taskReviewDecisionSchema>;

const taskReviewInclude = {
  task: { include: taskInclude },
  requester: { select: { id: true, name: true, email: true, avatarUrl: true } },
  reviewer: { select: { id: true, name: true, email: true, avatarUrl: true } }
} satisfies Prisma.TaskReviewRequestInclude;

export type TaskReviewWithRelations = Prisma.TaskReviewRequestGetPayload<{ include: typeof taskReviewInclude }>;

const taskReviewAccessSelect = {
  id: true,
  workspaceId: true,
  taskId: true,
  requesterId: true,
  reviewerId: true,
  status: true,
  task: { select: { assigneeId: true, reporterId: true } }
} satisfies Prisma.TaskReviewRequestSelect;

type TaskReviewAccessRecord = Prisma.TaskReviewRequestGetPayload<{ select: typeof taskReviewAccessSelect }>;

export interface SerializedTaskReview {
  id: string;
  workspaceId: string;
  taskId: string;
  requesterId: string | null;
  reviewerId: string;
  status: string;
  requestedAt: string;
  respondedAt: string | null;
  dueAt: string | null;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  requester?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
  reviewer?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
  task?: ReturnType<typeof serializeTaskForResponse>;
}

export async function listMyTaskReviews(actor: RequestActor, input: { status?: string; limit?: number; offset?: number } = {}) {
  const access = await resolveWorkspaceAccess(actor);
  const where: Prisma.TaskReviewRequestWhereInput = {
    workspaceId: actor.workspace.id,
    reviewerId: actor.user.id,
    status: input.status as never,
    task: taskWhereForAccess(access)
  };
  const [items, total] = await Promise.all([
    prisma.taskReviewRequest.findMany({
      where,
      include: taskReviewInclude,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { requestedAt: 'asc' }],
      take: input.limit ?? 50,
      skip: input.offset ?? 0
    }),
    prisma.taskReviewRequest.count({ where })
  ]);

  return {
    items: items.map(serializeTaskReview),
    total,
    limit: input.limit ?? 50,
    offset: input.offset ?? 0
  };
}

export async function listTaskReviews(actor: RequestActor, idOrKey: string): Promise<SerializedTaskReview[]> {
  const task = await requireTaskForReview(actor, idOrKey);
  const rows = await prisma.taskReviewRequest.findMany({
    where: { workspaceId: actor.workspace.id, taskId: task.id },
    include: taskReviewInclude,
    orderBy: [{ requestedAt: 'desc' }]
  });
  return rows.map(serializeTaskReview);
}

export async function requestTaskReview(actor: RequestActor, idOrKey: string, input: RequestTaskReviewInput): Promise<SerializedTaskReview> {
  const task = await requireTaskForReview(actor, idOrKey);
  const reviewer = await requireWorkspaceReviewer(actor.workspace.id, input.reviewerId);
  const existing = await prisma.taskReviewRequest.findFirst({
    where: { workspaceId: actor.workspace.id, taskId: task.id, status: 'REQUESTED' },
    include: taskReviewInclude
  });
  if (existing) {
    throw new HttpError(409, 'Task already has an active review request');
  }

  let syncEvents: SyncEvent[] = [];
  let review: TaskReviewWithRelations;
  try {
    review = await prisma.$transaction(async (tx) => {
      await lockMilestonesForUpdate(tx, actor.workspace.id, [task.milestoneId]);
      await assertTaskStateAfterMilestoneLock(tx, task);
      const beforeTask = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
      const created = await tx.taskReviewRequest.create({
        data: {
          workspaceId: actor.workspace.id,
          taskId: task.id,
          requesterId: actor.user.id,
          reviewerId: reviewer.userId,
          dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
          comment: input.comment || undefined
        },
        include: taskReviewInclude
      });

      await tx.task.update({
        where: { id: task.id },
        data: {
          status: 'IN_REVIEW',
          completedAt: null,
          version: { increment: 1 }
        }
      });
      const afterTask = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
      await subscribeUsersToTask(tx, {
        workspaceId: actor.workspace.id,
        taskId: task.id,
        userIds: [actor.user.id, reviewer.userId]
      });
      if (reviewer.userId !== actor.user.id) {
        await tx.notification.create({
          data: {
            workspaceId: actor.workspace.id,
            userId: reviewer.userId,
            taskId: task.id,
            type: TASK_REVIEW_REQUESTED_NOTIFICATION_TYPE,
            title: `${task.key}: ${task.title}`,
            body: taskReviewRequestedNotificationBody(actor.user.name)
          }
        });
      }
      const taskEvent = await appendSyncEvent(tx, {
        workspaceId: actor.workspace.id,
        entityType: 'task',
        entityId: task.id,
        operation: 'updated',
        entityVersion: afterTask.version,
        actorId: actor.user.id,
        payload: {
          before: serializeTaskForResponse(beforeTask),
          after: serializeTaskForResponse(afterTask),
          changedFields: ['status']
        }
      });
      const reviewEvent = await appendSyncEvent(tx, {
        workspaceId: actor.workspace.id,
        entityType: 'review',
        entityId: created.id,
        operation: 'created',
        actorId: actor.user.id,
        payload: { after: serializeTaskReview(created), changedFields: ['reviewerId', 'status'] }
      });
      syncEvents = [
        taskEvent,
        reviewEvent,
        ...await appendMilestoneProgressSyncEvents(tx, {
          workspaceId: actor.workspace.id,
          actorId: actor.user.id,
          milestoneIds: [afterTask.milestoneId]
        })
      ];
      return created;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new HttpError(409, 'Task already has an active review request');
    }
    throw error;
  }

  for (const event of syncEvents) publishSyncEvent(event);
  await logReviewActivity(actor, 'requested', review);
  return serializeTaskReview(review);
}

export async function reassignTaskReview(actor: RequestActor, reviewId: string, input: ReassignTaskReviewInput): Promise<SerializedTaskReview> {
  const accessRecord = await requireReviewAccessForActor(actor, reviewId);
  if (accessRecord.status !== 'REQUESTED') throw new HttpError(400, 'Only requested reviews can be reassigned');
  assertCanManageTaskReview(actor, accessRecord);
  const current = await loadReviewWithRelations(accessRecord.id);
  const reviewer = await requireWorkspaceReviewer(actor.workspace.id, input.reviewerId);
  const before = serializeTaskReview(current);

  let syncEvent: SyncEvent | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.taskReviewRequest.update({
      where: { id: current.id },
      data: {
        reviewerId: reviewer.userId,
        dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
        comment: input.comment === undefined ? undefined : input.comment
      },
      include: taskReviewInclude
    });
    await subscribeUsersToTask(tx, {
      workspaceId: actor.workspace.id,
      taskId: current.taskId,
      userIds: [reviewer.userId]
    });
    if (reviewer.userId !== actor.user.id) {
      await tx.notification.create({
        data: {
          workspaceId: actor.workspace.id,
          userId: reviewer.userId,
          taskId: current.taskId,
          type: TASK_REVIEW_REQUESTED_NOTIFICATION_TYPE,
          title: `${current.task.key}: ${current.task.title}`,
          body: taskReviewRequestedNotificationBody(actor.user.name)
        }
      });
    }
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'review',
      entityId: row.id,
      operation: 'reassigned',
      actorId: actor.user.id,
      payload: { before, after: serializeTaskReview(row), changedFields: ['reviewerId'] }
    });
    return row;
  });

  if (syncEvent) publishSyncEvent(syncEvent);
  await logReviewActivity(actor, 'reassigned', updated, before);
  return serializeTaskReview(updated);
}

export async function approveTaskReview(actor: RequestActor, reviewId: string, input: ReviewDecisionInput = {}): Promise<SerializedTaskReview> {
  const accessRecord = await requireReviewAccessForActor(actor, reviewId);
  assertReviewer(actor, accessRecord);
  if (accessRecord.status !== 'REQUESTED') throw new HttpError(400, 'Only requested reviews can be approved');
  const current = await loadReviewWithRelations(accessRecord.id);
  const before = serializeTaskReview(current);
  const now = new Date();

  let syncEvents: SyncEvent[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    await lockMilestonesForUpdate(tx, actor.workspace.id, [current.task.milestoneId]);
    await assertTaskStateAfterMilestoneLock(tx, current.task);
    const row = await tx.taskReviewRequest.update({
      where: { id: current.id },
      data: {
        status: 'APPROVED',
        respondedAt: now,
        comment: input.comment === undefined ? current.comment : input.comment
      },
      include: taskReviewInclude
    });
    await tx.task.update({
      where: { id: current.taskId },
      data: {
        status: 'DONE',
        completedAt: now,
        version: { increment: 1 }
      }
    });
    const afterTask = await tx.task.findUniqueOrThrow({ where: { id: current.taskId }, include: taskInclude });
    await notifyRequesterOfDecision(tx, actor, current, taskReviewApprovedNotificationBody(actor.user.name));
    const taskEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: current.taskId,
      operation: 'updated',
      entityVersion: afterTask.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(current.task),
        after: serializeTaskForResponse(afterTask),
        changedFields: ['status', 'completedAt']
      }
    });
    const reviewEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'review',
      entityId: row.id,
      operation: 'approved',
      actorId: actor.user.id,
      payload: { before, after: serializeTaskReview(row), changedFields: ['status', 'respondedAt'] }
    });
    syncEvents = [
      taskEvent,
      reviewEvent,
      ...await appendMilestoneProgressSyncEvents(tx, {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        milestoneIds: [afterTask.milestoneId]
      })
    ];
    return row;
  });

  for (const event of syncEvents) publishSyncEvent(event);
  await logReviewActivity(actor, 'approved', updated, before);
  return serializeTaskReview(updated);
}

export async function requestTaskReviewChanges(actor: RequestActor, reviewId: string, input: ReviewDecisionInput = {}): Promise<SerializedTaskReview> {
  const accessRecord = await requireReviewAccessForActor(actor, reviewId);
  assertReviewer(actor, accessRecord);
  if (accessRecord.status !== 'REQUESTED') throw new HttpError(400, 'Only requested reviews can request changes');
  const current = await loadReviewWithRelations(accessRecord.id);
  const before = serializeTaskReview(current);
  const now = new Date();

  let syncEvents: SyncEvent[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    await lockMilestonesForUpdate(tx, actor.workspace.id, [current.task.milestoneId]);
    await assertTaskStateAfterMilestoneLock(tx, current.task);
    const row = await tx.taskReviewRequest.update({
      where: { id: current.id },
      data: {
        status: 'CHANGES_REQUESTED',
        respondedAt: now,
        comment: input.comment === undefined ? current.comment : input.comment
      },
      include: taskReviewInclude
    });
    await tx.task.update({
      where: { id: current.taskId },
      data: {
        status: 'IN_PROGRESS',
        completedAt: null,
        version: { increment: 1 }
      }
    });
    const afterTask = await tx.task.findUniqueOrThrow({ where: { id: current.taskId }, include: taskInclude });
    await notifyRequesterOfDecision(tx, actor, current, taskReviewChangesRequestedNotificationBody(actor.user.name));
    const taskEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: current.taskId,
      operation: 'updated',
      entityVersion: afterTask.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(current.task),
        after: serializeTaskForResponse(afterTask),
        changedFields: ['status']
      }
    });
    const reviewEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'review',
      entityId: row.id,
      operation: 'changes_requested',
      actorId: actor.user.id,
      payload: { before, after: serializeTaskReview(row), changedFields: ['status', 'respondedAt'] }
    });
    syncEvents = [
      taskEvent,
      reviewEvent,
      ...await appendMilestoneProgressSyncEvents(tx, {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        milestoneIds: [afterTask.milestoneId]
      })
    ];
    return row;
  });

  for (const event of syncEvents) publishSyncEvent(event);
  await logReviewActivity(actor, 'changes_requested', updated, before);
  return serializeTaskReview(updated);
}

export async function cancelTaskReview(actor: RequestActor, reviewId: string, input: ReviewDecisionInput = {}): Promise<SerializedTaskReview> {
  const accessRecord = await requireReviewAccessForActor(actor, reviewId);
  if (accessRecord.status !== 'REQUESTED') throw new HttpError(400, 'Only requested reviews can be canceled');
  if (!canManageTaskReview(actor, accessRecord)) {
    throw new HttpError(403, 'Only requester, reviewer, task owner, or workspace admin can cancel this review');
  }
  const current = await loadReviewWithRelations(accessRecord.id);
  const before = serializeTaskReview(current);
  const now = new Date();

  let syncEvents: SyncEvent[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    await lockMilestonesForUpdate(tx, actor.workspace.id, [current.task.milestoneId]);
    await assertTaskStateAfterMilestoneLock(tx, current.task);
    const row = await tx.taskReviewRequest.update({
      where: { id: current.id },
      data: {
        status: 'CANCELED',
        respondedAt: now,
        comment: input.comment === undefined ? current.comment : input.comment
      },
      include: taskReviewInclude
    });
    await tx.task.update({
      where: { id: current.taskId },
      data: {
        status: 'IN_PROGRESS',
        completedAt: null,
        version: { increment: 1 }
      }
    });
    const afterTask = await tx.task.findUniqueOrThrow({ where: { id: current.taskId }, include: taskInclude });
    const taskEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: current.taskId,
      operation: 'updated',
      entityVersion: afterTask.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(current.task),
        after: serializeTaskForResponse(afterTask),
        changedFields: ['status']
      }
    });
    const reviewEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'review',
      entityId: row.id,
      operation: 'canceled',
      actorId: actor.user.id,
      payload: { before, after: serializeTaskReview(row), changedFields: ['status', 'respondedAt'] }
    });
    syncEvents = [
      taskEvent,
      reviewEvent,
      ...await appendMilestoneProgressSyncEvents(tx, {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        milestoneIds: [afterTask.milestoneId]
      })
    ];
    return row;
  });

  for (const event of syncEvents) publishSyncEvent(event);
  await logReviewActivity(actor, 'canceled', updated, before);
  return serializeTaskReview(updated);
}

async function assertTaskStateAfterMilestoneLock(
  tx: Prisma.TransactionClient,
  task: { id: string; version: number; milestoneId: string | null }
): Promise<void> {
  const current = await tx.task.findUnique({
    where: { id: task.id },
    select: { version: true, milestoneId: true }
  });
  if (!current || current.version !== task.version || current.milestoneId !== task.milestoneId) {
    throw new HttpError(409, 'Task changed on another client');
  }
}

export function serializeTaskReview(review: TaskReviewWithRelations): SerializedTaskReview {
  return {
    id: review.id,
    workspaceId: review.workspaceId,
    taskId: review.taskId,
    requesterId: review.requesterId,
    reviewerId: review.reviewerId,
    status: review.status,
    requestedAt: review.requestedAt.toISOString(),
    respondedAt: review.respondedAt?.toISOString() ?? null,
    dueAt: review.dueAt?.toISOString() ?? null,
    comment: review.comment,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
    requester: review.requester,
    reviewer: review.reviewer,
    task: serializeTaskForResponse(review.task)
  };
}

async function requireTaskForReview(actor: RequestActor, idOrKey: string) {
  const access = await resolveWorkspaceAccess(actor);
  const task = await findTaskByIdOrKey(actor.workspace.id, idOrKey, access);
  if (!task) throw new HttpError(404, 'Task not found');
  return task;
}

async function requireReviewForActor(actor: RequestActor, reviewId: string): Promise<TaskReviewWithRelations> {
  const accessRecord = await requireReviewAccessForActor(actor, reviewId);
  return loadReviewWithRelations(accessRecord.id);
}

async function requireReviewAccessForActor(actor: RequestActor, reviewId: string): Promise<TaskReviewAccessRecord> {
  const access = await resolveWorkspaceAccess(actor);
  const review = await prisma.taskReviewRequest.findFirst({
    where: {
      id: reviewId,
      workspaceId: actor.workspace.id,
      task: taskWhereForAccess(access)
    },
    select: taskReviewAccessSelect
  });
  if (!review) throw new HttpError(404, 'Review request not found');
  return review;
}

async function loadReviewWithRelations(reviewId: string): Promise<TaskReviewWithRelations> {
  return prisma.taskReviewRequest.findUniqueOrThrow({
    where: { id: reviewId },
    include: taskReviewInclude
  });
}

async function requireWorkspaceReviewer(workspaceId: string, userId: string): Promise<{ userId: string }> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { userId: true }
  });
  if (!membership) throw new HttpError(400, 'Reviewer must belong to this workspace');
  return membership;
}

function assertReviewer(actor: RequestActor, review: Pick<TaskReviewRequest, 'reviewerId'>): void {
  if (review.reviewerId !== actor.user.id) {
    throw new HttpError(403, 'Only the assigned reviewer can decide this review');
  }
}

export function canManageTaskReview(
  actor: Pick<RequestActor, 'role' | 'user'>,
  review: Pick<TaskReviewRequest, 'requesterId' | 'reviewerId'> & { task: { assigneeId?: string | null; reporterId?: string | null } }
): boolean {
  if (isWorkspaceAdminRole(actor.role)) return true;
  const actorId = actor.user.id;
  return (
    review.requesterId === actorId ||
    review.reviewerId === actorId ||
    review.task.assigneeId === actorId ||
    review.task.reporterId === actorId
  );
}

function assertCanManageTaskReview(
  actor: RequestActor,
  review: Pick<TaskReviewRequest, 'requesterId' | 'reviewerId'> & { task: { assigneeId?: string | null; reporterId?: string | null } }
): void {
  if (!canManageTaskReview(actor, review)) {
    throw new HttpError(403, 'Only requester, reviewer, task owner, or workspace admin can reassign this review');
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

async function notifyRequesterOfDecision(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  review: TaskReviewWithRelations,
  body: string
): Promise<void> {
  const recipientIds = [...new Set([review.requesterId, review.task.assigneeId].filter((id): id is string => Boolean(id && id !== actor.user.id)))];
  if (!recipientIds.length) return;
  await tx.notification.createMany({
    data: recipientIds.map((userId) => ({
      workspaceId: actor.workspace.id,
      userId,
      taskId: review.taskId,
      type: TASK_REVIEW_DECIDED_NOTIFICATION_TYPE,
      title: `${review.task.key}: ${review.task.title}`,
      body
    }))
  });
}

async function logReviewActivity(
  actor: RequestActor,
  action: string,
  review: TaskReviewWithRelations,
  before?: SerializedTaskReview
): Promise<void> {
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task_review',
    entityId: review.id,
    action,
    before,
    after: serializeTaskReview(review),
    source: actor.source
  }).catch(() => undefined);
}
