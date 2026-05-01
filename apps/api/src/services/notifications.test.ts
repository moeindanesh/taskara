import { describe, expect, test } from 'bun:test';
import type { Prisma } from '@taskara/db';
import { TASK_MENTIONED_NOTIFICATION_TYPE, createTaskMentionNotifications } from './notifications';

type WorkspaceMemberFindManyArgs = Parameters<Prisma.TransactionClient['workspaceMember']['findMany']>[0];
type NotificationCreateManyArgs = Parameters<Prisma.TransactionClient['notification']['createMany']>[0];

type CreatedNotification = {
  workspaceId: string;
  userId: string;
  taskId: string;
  type: string;
  title: string;
  body?: string | null;
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

function mockMentionTransaction(validWorkspaceUserIds: string[]) {
  let createdNotifications: CreatedNotification[] = [];
  let createManyCalls = 0;

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
        createdNotifications = data as CreatedNotification[];
        return { count: data.length };
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
    }
  };
}

describe('task mention notifications', () => {
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
});
