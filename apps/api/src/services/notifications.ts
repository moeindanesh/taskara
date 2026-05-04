import type { Prisma, TaskStatus } from '@taskara/db';
import { statusLabel } from '@taskara/shared';

export const TASK_ASSIGNED_NOTIFICATION_TYPE = 'task_assigned';
export const TASK_MENTIONED_NOTIFICATION_TYPE = 'task_mentioned';
export const TASK_STATUS_CHANGED_NOTIFICATION_TYPE = 'task_status_changed';
export const TASK_COMMENTED_NOTIFICATION_TYPE = 'task_commented';
export const TASK_DESCRIPTION_CHANGED_NOTIFICATION_TYPE = 'task_description_changed';

export type NotificationCursor = {
  createdAt: Date;
  id: string;
};

export function taskAssignedNotificationBody(actorName: string): string {
  return `${actorName} این کار را به شما واگذار کرد.`;
}

export function taskMentionedNotificationBody(actorName: string): string {
  return `${actorName} شما را در این کار منشن کرد.`;
}

export function taskStatusChangedNotificationBody(
  actorName: string,
  beforeStatus: TaskStatus,
  afterStatus: TaskStatus
): string {
  return `${actorName} وضعیت کار را از ${statusLabel(beforeStatus)} به ${statusLabel(afterStatus)} تغییر داد.`;
}

export function taskCommentedNotificationBody(actorName: string): string {
  return `${actorName} دیدگاهی روی این کار گذاشت.`;
}

export function taskDescriptionChangedNotificationBody(actorName: string): string {
  return `${actorName} توضیحات این کار را به‌روزرسانی کرد.`;
}

export function encodeNotificationCursor(input: { createdAt: Date; id: string }): string {
  return `${input.createdAt.toISOString()}|${input.id}`;
}

export function parseNotificationCursor(cursor?: string): NotificationCursor | null {
  if (!cursor) return null;

  const separatorIndex = cursor.lastIndexOf('|');
  if (separatorIndex <= 0 || separatorIndex === cursor.length - 1) return null;

  const createdAtRaw = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 1).trim();
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;

  return { createdAt, id };
}

export function taskInboxNotificationWhere(
  workspaceId: string,
  userId: string,
  options: { unreadOnly?: boolean } = {}
): Prisma.NotificationWhereInput {
  return {
    workspaceId,
    userId,
    OR: [{ taskId: null }, { task: { is: { workspaceId } } }],
    ...(options.unreadOnly ? { readAt: null } : {})
  };
}

type MentionNotificationTask = {
  id: string;
  key: string;
  title: string;
  description?: string | null;
};

type SubscriberNotificationTask = {
  id: string;
  key: string;
  title: string;
};

export async function subscribeUsersToTask(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    taskId: string;
    userIds: Array<string | null | undefined>;
  }
): Promise<string[]> {
  const requestedUserIds = [...new Set(input.userIds.filter((userId): userId is string => Boolean(userId)))];
  if (!requestedUserIds.length) return [];

  const workspaceMembers = await tx.workspaceMember.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: { in: requestedUserIds }
    },
    select: { userId: true }
  });
  const validUserIds = [...new Set(workspaceMembers.map((member) => member.userId))];
  if (!validUserIds.length) return [];

  await tx.taskSubscription.createMany({
    data: validUserIds.map((userId) => ({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      userId
    })),
    skipDuplicates: true
  });

  return validUserIds;
}

export async function subscribeTaskParticipants(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    task: MentionNotificationTask & { assigneeId?: string | null; reporterId?: string | null };
    userIds?: Array<string | null | undefined>;
  }
): Promise<string[]> {
  return subscribeUsersToTask(tx, {
    workspaceId: input.workspaceId,
    taskId: input.task.id,
    userIds: [
      input.task.reporterId,
      input.task.assigneeId,
      ...extractTaskMentionUserIds(input.task.description),
      ...(input.userIds || [])
    ]
  });
}

export async function createTaskSubscriberNotifications(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    task: SubscriberNotificationTask;
    type: string;
    body: string;
    excludeUserIds?: string[];
  }
): Promise<string[]> {
  const excludedUserIds = [...new Set([input.actorUserId, ...(input.excludeUserIds || [])])];
  const subscriptions = await tx.taskSubscription.findMany({
    where: {
      workspaceId: input.workspaceId,
      taskId: input.task.id,
      userId: { notIn: excludedUserIds }
    },
    select: { userId: true }
  });
  const recipientIds = [...new Set(subscriptions.map((subscription) => subscription.userId))];
  if (!recipientIds.length) return [];

  await tx.notification.createMany({
    data: recipientIds.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      taskId: input.task.id,
      type: input.type,
      title: `${input.task.key}: ${input.task.title}`,
      body: input.body
    }))
  });

  return recipientIds;
}

export async function createTaskMentionNotifications(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    actorName: string;
    task: MentionNotificationTask;
    previousDescription?: string | null;
  }
): Promise<string[]> {
  const currentMentions = extractTaskMentionUserIds(input.task.description);
  if (!currentMentions.length) return [];

  const previousMentions = new Set(extractTaskMentionUserIds(input.previousDescription));
  const mentionedUserIds = currentMentions.filter(
    (userId) => userId !== input.actorUserId && !previousMentions.has(userId)
  );
  if (!mentionedUserIds.length) return [];

  const workspaceMembers = await tx.workspaceMember.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: { in: mentionedUserIds }
    },
    select: { userId: true }
  });
  const validUserIds = [...new Set(workspaceMembers.map((member) => member.userId))];
  if (!validUserIds.length) return [];

  await tx.notification.createMany({
    data: validUserIds.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      taskId: input.task.id,
      type: TASK_MENTIONED_NOTIFICATION_TYPE,
      title: `${input.task.key}: ${input.task.title}`,
      body: taskMentionedNotificationBody(input.actorName)
    }))
  });

  return validUserIds;
}

export function extractTaskMentionUserIds(description?: string | null): string[] {
  if (!description?.trim().startsWith('{')) return [];

  try {
    const parsed = JSON.parse(description) as unknown;
    const mentionUserIds = new Set<string>();
    collectMentionUserIds(parsed, mentionUserIds);
    return [...mentionUserIds];
  } catch {
    return [];
  }
}

function collectMentionUserIds(value: unknown, mentionUserIds: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectMentionUserIds(item, mentionUserIds);
    return;
  }

  const node = value as Record<string, unknown>;
  const mentionUserId = mentionUserIdFromNode(node);
  if (mentionUserId) mentionUserIds.add(mentionUserId);

  for (const childContainer of [node.root, node.children, node.content]) {
    if (Array.isArray(childContainer)) {
      for (const child of childContainer) collectMentionUserIds(child, mentionUserIds);
    } else if (childContainer && typeof childContainer === 'object') {
      collectMentionUserIds(childContainer, mentionUserIds);
    }
  }
}

function mentionUserIdFromNode(node: Record<string, unknown>): string | null {
  if (node.type !== 'mention') return null;
  if (typeof node.mentionUserId === 'string' && node.mentionUserId) return node.mentionUserId;

  const attrs = node.attrs;
  if (!attrs || typeof attrs !== 'object') return null;
  const attrRecord = attrs as Record<string, unknown>;
  if (typeof attrRecord.mentionUserId === 'string' && attrRecord.mentionUserId) return attrRecord.mentionUserId;
  if (typeof attrRecord.userId === 'string' && attrRecord.userId) return attrRecord.userId;
  return null;
}
