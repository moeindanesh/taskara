import type { Prisma } from '@taskara/db';

export const TASK_ASSIGNED_NOTIFICATION_TYPE = 'task_assigned';
export const TASK_MENTIONED_NOTIFICATION_TYPE = 'task_mentioned';

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
      body: `${input.actorName} mentioned you in this task.`
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
  if (node.type === 'mention' && typeof node.mentionUserId === 'string' && node.mentionUserId) {
    mentionUserIds.add(node.mentionUserId);
  }

  const children = node.children;
  if (Array.isArray(children)) {
    for (const child of children) collectMentionUserIds(child, mentionUserIds);
  }
}
