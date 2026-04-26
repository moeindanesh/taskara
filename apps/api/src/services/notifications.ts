import type { Prisma } from '@taskara/db';

export const TASK_ASSIGNED_NOTIFICATION_TYPE = 'task_assigned';

export function assignedInboxNotificationWhere(
  workspaceId: string,
  userId: string,
  options: { unreadOnly?: boolean } = {}
): Prisma.NotificationWhereInput {
  return {
    workspaceId,
    userId,
    type: TASK_ASSIGNED_NOTIFICATION_TYPE,
    task: {
      is: {
        workspaceId,
        assigneeId: userId
      }
    },
    ...(options.unreadOnly ? { readAt: null } : {})
  };
}
