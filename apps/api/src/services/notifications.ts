import type { Prisma } from '@taskara/db';

export const TASK_ASSIGNED_NOTIFICATION_TYPE = 'task_assigned';
export const TASK_MENTIONED_NOTIFICATION_TYPE = 'task_mentioned';

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
    OR: [
      {
        type: TASK_ASSIGNED_NOTIFICATION_TYPE,
        task: {
          is: {
            workspaceId,
            assigneeId: userId
          }
        }
      },
      {
        type: TASK_MENTIONED_NOTIFICATION_TYPE,
        task: {
          is: {
            workspaceId
          }
        }
      }
    ],
    ...(options.unreadOnly ? { readAt: null } : {})
  };
}

type MentionNotificationTask = {
  id: string;
  key: string;
  title: string;
  description?: string | null;
};

export async function createTaskMentionNotifications(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    actorName: string;
    task: MentionNotificationTask;
    previousDescription?: string | null;
  }
): Promise<void> {
  const currentMentions = extractMentionUserIds(input.task.description);
  if (!currentMentions.length) return;

  const previousMentions = new Set(extractMentionUserIds(input.previousDescription));
  const mentionedUserIds = currentMentions.filter(
    (userId) => userId !== input.actorUserId && !previousMentions.has(userId)
  );
  if (!mentionedUserIds.length) return;

  const workspaceMembers = await tx.workspaceMember.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: { in: mentionedUserIds }
    },
    select: { userId: true }
  });
  const validUserIds = [...new Set(workspaceMembers.map((member) => member.userId))];
  if (!validUserIds.length) return;

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
}

function extractMentionUserIds(description?: string | null): string[] {
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
