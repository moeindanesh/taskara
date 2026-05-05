import { describe, expect, test } from 'bun:test';
import type { Prisma } from '@taskara/db';
import {
  TASK_COMMENTED_NOTIFICATION_TYPE,
  TASK_MENTIONED_NOTIFICATION_TYPE,
  createTaskMentionNotifications,
  createTaskSubscriberNotifications,
  subscribeUsersToTask,
  taskInboxNotificationWhere
} from './notifications';

type WorkspaceMemberFindManyArgs = Parameters<Prisma.TransactionClient['workspaceMember']['findMany']>[0];
type NotificationCreateManyArgs = Parameters<Prisma.TransactionClient['notification']['createMany']>[0];
type TaskSubscriptionCreateManyArgs = Parameters<Prisma.TransactionClient['taskSubscription']['createMany']>[0];
type TaskSubscriptionFindManyArgs = Parameters<Prisma.TransactionClient['taskSubscription']['findMany']>[0];

type CreatedNotification = {
  workspaceId: string;
  userId: string;
  taskId: string;
  type: string;
  title: string;
  body?: string | null;
};

type CreatedSubscription = {
  workspaceId: string;
  taskId: string;
  userId: string;
};

function serializedDescription(
  mentions: Array<{ userId: string; name?: string; attrs?: boolean }>
): string {
  return JSON.stringify({
    root: {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: mentions.map((mention) => ({
            type: 'mention',
            version: 1,
            text: `@${mention.name || mention.userId}`,
            mentionName: mention.name || mention.userId,
            ...(mention.attrs
              ? { attrs: { userId: mention.userId } }
              : { mentionUserId: mention.userId })
          }))
        }
      ]
    }
  });
}

function mockMentionTransaction(validWorkspaceUserIds: string[], subscribedUserIds: string[] = []) {
  let createdNotifications: CreatedNotification[] = [];
  let createdSubscriptions: CreatedSubscription[] = [];
  let createManyCalls = 0;
  let subscriptionCreateManyCalls = 0;

  const tx = {
    workspaceMember: {
      findMany: async (args: WorkspaceMemberFindManyArgs) => {
        const where = args?.where as { userId?: { in?: string[] } } | undefined;
        const requestedUserIds = where?.userId?.in || [];
        return validWorkspaceUserIds
          .filter((userId) => requestedUserIds.includes(userId))
          .map((userId) => ({ userId }));
      }
    },
    notification: {
      createMany: async (args: NotificationCreateManyArgs) => {
        if (!args) throw new Error('createMany args are required');
        createManyCalls += 1;
        const data = Array.isArray(args.data) ? args.data : [args.data];
        createdNotifications = [...createdNotifications, ...(data as CreatedNotification[])];
        return { count: data.length };
      }
    },
    taskSubscription: {
      createMany: async (args: TaskSubscriptionCreateManyArgs) => {
        if (!args) throw new Error('task subscription createMany args are required');
        subscriptionCreateManyCalls += 1;
        const data = Array.isArray(args.data) ? args.data : [args.data];
        createdSubscriptions = [...createdSubscriptions, ...(data as CreatedSubscription[])];
        return { count: data.length };
      },
      findMany: async (args: TaskSubscriptionFindManyArgs) => {
        const where = args?.where as { userId?: { notIn?: string[] } } | undefined;
        const excludedUserIds = new Set(where?.userId?.notIn || []);
        return subscribedUserIds.filter((userId) => !excludedUserIds.has(userId)).map((userId) => ({ userId }));
      }
    }
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    get createManyCalls() {
      return createManyCalls;
    },
    get createdNotifications() {
      return createdNotifications;
    },
    get subscriptionCreateManyCalls() {
      return subscriptionCreateManyCalls;
    },
    get createdSubscriptions() {
      return createdSubscriptions;
    }
  };
}

describe('task mention notifications', () => {
  test('keeps task, announcement, and meeting notifications in the inbox scope', () => {
    const where = taskInboxNotificationWhere('workspace-1', 'user-1');

    expect(where.OR).toContainEqual({ task: { is: { workspaceId: 'workspace-1' } } });
    expect(where.OR).toContainEqual({ announcement: { is: { workspaceId: 'workspace-1' } } });
    expect(where.OR).toContainEqual({ meeting: { is: { workspaceId: 'workspace-1' } } });
  });

  test('creates inbox notifications for mentioned workspace members', async () => {
    const workspaceId = 'workspace-1';
    const actorUserId = 'user-actor';
    const mentionedUserId = 'user-mentioned';
    const mock = mockMentionTransaction([actorUserId, mentionedUserId]);

    await createTaskMentionNotifications(mock.tx, {
      workspaceId,
      actorUserId,
      actorName: 'Raha',
      task: {
        id: 'task-1',
        key: 'CORE-12',
        title: 'Mention notification',
        description: serializedDescription([{ userId: mentionedUserId, name: 'Sara' }])
      }
    });

    expect(mock.createManyCalls).toBe(1);
    expect(mock.createdNotifications).toEqual([
      {
        workspaceId,
        userId: mentionedUserId,
        taskId: 'task-1',
        type: TASK_MENTIONED_NOTIFICATION_TYPE,
        title: 'CORE-12: Mention notification',
        body: 'Raha شما را در این کار منشن کرد.'
      }
    ]);
  });

  test('only notifies newly mentioned users and never notifies the actor', async () => {
    const workspaceId = 'workspace-1';
    const actorUserId = 'user-actor';
    const existingMentionUserId = 'user-existing';
    const newMentionUserId = 'user-new';
    const nonMemberUserId = 'user-outside-workspace';
    const mock = mockMentionTransaction([actorUserId, existingMentionUserId, newMentionUserId]);

    await createTaskMentionNotifications(mock.tx, {
      workspaceId,
      actorUserId,
      actorName: 'Raha',
      task: {
        id: 'task-1',
        key: 'CORE-12',
        title: 'Mention notification',
        description: serializedDescription([
          { userId: actorUserId, name: 'Raha' },
          { userId: existingMentionUserId, name: 'Sara' },
          { userId: newMentionUserId, name: 'Navid', attrs: true },
          { userId: nonMemberUserId, name: 'Outside' }
        ])
      },
      previousDescription: serializedDescription([{ userId: existingMentionUserId, name: 'Sara' }])
    });

    expect(mock.createManyCalls).toBe(1);
    expect(mock.createdNotifications.map((notification) => notification.userId)).toEqual([newMentionUserId]);
  });

  test('does not create notifications when the description has no mention nodes', async () => {
    const mock = mockMentionTransaction(['user-mentioned']);

    await createTaskMentionNotifications(mock.tx, {
      workspaceId: 'workspace-1',
      actorUserId: 'user-actor',
      actorName: 'Raha',
      task: {
        id: 'task-1',
        key: 'CORE-12',
        title: 'Mention notification',
        description: 'Plain @Sara text without mention metadata'
      }
    });

    expect(mock.createManyCalls).toBe(0);
    expect(mock.createdNotifications).toEqual([]);
  });

  test('subscribes only workspace members to a task', async () => {
    const workspaceId = 'workspace-1';
    const mock = mockMentionTransaction(['user-actor', 'user-assignee']);

    const subscribedUserIds = await subscribeUsersToTask(mock.tx, {
      workspaceId,
      taskId: 'task-1',
      userIds: ['user-actor', 'user-assignee', 'user-assignee', 'user-outside-workspace', null]
    });

    expect(subscribedUserIds).toEqual(['user-actor', 'user-assignee']);
    expect(mock.subscriptionCreateManyCalls).toBe(1);
    expect(mock.createdSubscriptions).toEqual([
      { workspaceId, taskId: 'task-1', userId: 'user-actor' },
      { workspaceId, taskId: 'task-1', userId: 'user-assignee' }
    ]);
  });

  test('creates subscriber notifications except for the actor and excluded users', async () => {
    const workspaceId = 'workspace-1';
    const mock = mockMentionTransaction([], ['user-actor', 'user-subscriber', 'user-mentioned']);

    const recipientIds = await createTaskSubscriberNotifications(mock.tx, {
      workspaceId,
      actorUserId: 'user-actor',
      task: { id: 'task-1', key: 'CORE-12', title: 'Subscriber update' },
      type: TASK_COMMENTED_NOTIFICATION_TYPE,
      body: 'Raha دیدگاهی روی این کار گذاشت.',
      excludeUserIds: ['user-mentioned']
    });

    expect(recipientIds).toEqual(['user-subscriber']);
    expect(mock.createdNotifications).toEqual([
      {
        workspaceId,
        userId: 'user-subscriber',
        taskId: 'task-1',
        type: TASK_COMMENTED_NOTIFICATION_TYPE,
        title: 'CORE-12: Subscriber update',
        body: 'Raha دیدگاهی روی این کار گذاشت.'
      }
    ]);
  });
});
