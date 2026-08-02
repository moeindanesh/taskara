import { describe, expect, test } from 'bun:test';
import type { Prisma } from '@taskara/db';
import type { ActorAttribution } from './actor-provenance';
import {
  TASK_COMMENTED_NOTIFICATION_TYPE,
  TASK_MENTIONED_NOTIFICATION_TYPE,
  collapseInboxNotificationsByThread,
  createTaskMentionNotifications,
  createTaskSubscriberNotifications,
  inboxNotificationThreadScope,
  notifiableMemberWhere,
  subscribeUsersToTask,
  taskInboxNotificationWhere
} from './notifications';

type WorkspaceMemberFindManyArgs = Parameters<Prisma.TransactionClient['workspaceMember']['findMany']>[0];
type NotificationCreateManyArgs = Parameters<Prisma.TransactionClient['notification']['createMany']>[0];
type TaskSubscriptionCreateManyArgs = Parameters<Prisma.TransactionClient['taskSubscription']['createMany']>[0];
type TaskSubscriptionFindManyArgs = Parameters<Prisma.TransactionClient['taskSubscription']['findMany']>[0];
type TaskMuteFindManyArgs = Parameters<Prisma.TransactionClient['taskMute']['findMany']>[0];

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

function serializedBody(
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

function humanAttribution(actorId: string): ActorAttribution {
  return { actorId, actorType: 'USER', actorRuntime: null };
}

function mockMentionTransaction(
  validWorkspaceUserIds: string[],
  subscribedUserIds: string[] = [],
  mutedUserIds: string[] = []
) {
  let createdNotifications: CreatedNotification[] = [];
  let createdSubscriptions: CreatedSubscription[] = [];
  let createManyCalls = 0;
  let subscriptionCreateManyCalls = 0;

  const tx = {
    // #57 made the mention path ask whether each recipient can open the task. This stub answers
    // with a **teamless** project, which `canReadProject` admits for the whole workspace before it
    // looks at the reader — so the access filter is a pass-through here and these cases keep
    // asserting what they were written to assert: who a body names, and who it names twice.
    //
    // Access itself is not testable at this seam and is deliberately not attempted: it is a
    // property of team and project rows, and a stub that decided it would be asserting its own
    // answer. `routes/notification-access.test.ts` drives it against a real database.
    task: {
      findFirst: async () => ({ project: { id: 'project-1', teamId: null, leadId: null } })
    },
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
    },
    taskMute: {
      findMany: async (args: TaskMuteFindManyArgs) => {
        const where = args?.where as { userId?: { in?: string[] } } | undefined;
        const requestedUserIds = where?.userId?.in || [];
        return mutedUserIds
          .filter((userId) => requestedUserIds.includes(userId))
          .map((userId) => ({ userId }));
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

/** A workspace admin: `resolveWorkspaceAccess` answers `workspaceWide` and no team or project list. */
const workspaceWideAccess = {
  workspaceId: 'workspace-1',
  userId: 'user-1',
  workspaceWide: true,
  teamIds: [],
  projectIds: []
};

describe('task mention notifications', () => {
  test('keeps task, announcement, and meeting notifications in the inbox scope', () => {
    const where = taskInboxNotificationWhere(workspaceWideAccess);

    // The task branch is narrowed to WORK. An effort is a Task, and its subscribers are notified on
    // every revision of a body that is edited continuously, so without this the inbox filled with
    // map churn. Written as a literal rather than by spreading the shared predicate: if the
    // predicate changes, this should fail and be read again, not silently agree with whatever it
    // became.
    expect(where.OR).toContainEqual({ task: { is: { workspaceId: 'workspace-1', kind: 'WORK' } } });
    expect(where.OR).toContainEqual({ announcement: { is: { workspaceId: 'workspace-1' } } });
    expect(where.OR).toContainEqual({ meeting: { is: { workspaceId: 'workspace-1' } } });
  });

  /**
   * #57. The same branch, asked by somebody who cannot read the whole workspace: an access clause
   * appears beside the `kind` one and neither replaces the other.
   *
   * Written as a literal for the reason the test above is — and asserted on the *resolved* object
   * rather than by re-invoking `taskWhereForAccess`, so a change to the access rule surfaces here
   * as a failure to read rather than as two functions agreeing with each other.
   */
  test('narrows the task branch to what the reader can open, without dropping the kind clause', () => {
    const where = taskInboxNotificationWhere({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      workspaceWide: false,
      teamIds: ['team-1'],
      projectIds: ['project-1']
    });

    expect(where.OR).toContainEqual({
      task: {
        is: {
          workspaceId: 'workspace-1',
          project: {
            OR: [
              { teamId: null },
              { leadId: 'user-1' },
              { teamId: { in: ['team-1'] } },
              { id: { in: ['project-1'] } }
            ]
          },
          kind: 'WORK'
        }
      }
    });
    // The other branches are not task-scoped and must not have been narrowed with it. An
    // announcement is addressed to a person directly and has no project to be walled off behind.
    expect(where.OR).toContainEqual({ announcement: { is: { workspaceId: 'workspace-1' } } });
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
      attribution: humanAttribution('user-actor'),
      task: { id: 'task-1', key: 'CORE-12', title: 'Mention notification' },
      body: serializedBody([{ userId: mentionedUserId, name: 'Sara' }])
    });

    expect(mock.createManyCalls).toBe(1);
    expect(mock.createdNotifications).toEqual([
      {
        workspaceId,
        userId: mentionedUserId,
        ...humanAttribution('user-actor'),
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
      attribution: humanAttribution('user-actor'),
      task: { id: 'task-1', key: 'CORE-12', title: 'Mention notification' },
      body: serializedBody([
        { userId: actorUserId, name: 'Raha' },
        { userId: existingMentionUserId, name: 'Sara' },
        { userId: newMentionUserId, name: 'Navid', attrs: true },
        { userId: nonMemberUserId, name: 'Outside' }
      ]),
      previousBody: serializedBody([{ userId: existingMentionUserId, name: 'Sara' }])
    });

    expect(mock.createManyCalls).toBe(1);
    expect(mock.createdNotifications.map((notification) => notification.userId)).toEqual([newMentionUserId]);
  });

  test('with no previous body every mention is new, which is what a comment is', async () => {
    // #55. `previousBody` exists so that re-saving a description does not re-notify everyone still
    // named in it — the body is one revised document. A comment is not: there is no edit route, so
    // each one is its own utterance, and naming the same person in two of them is addressing them
    // twice. Deduplicating a comment against an earlier comment would silently drop the second
    // question somebody asked you.
    const body = serializedBody([{ userId: 'user-sara', name: 'Sara' }]);
    const input = {
      workspaceId: 'workspace-1',
      actorUserId: 'user-actor',
      actorName: 'Raha',
      attribution: humanAttribution('user-actor'),
      task: { id: 'task-1', key: 'CORE-12', title: 'Asked twice' },
      body
    };

    const first = mockMentionTransaction(['user-sara']);
    const second = mockMentionTransaction(['user-sara']);

    expect(await createTaskMentionNotifications(first.tx, input)).toEqual(['user-sara']);
    expect(await createTaskMentionNotifications(second.tx, input)).toEqual(['user-sara']);
  });

  test('does not create notifications when the body has no mention nodes', async () => {
    const mock = mockMentionTransaction(['user-mentioned']);

    await createTaskMentionNotifications(mock.tx, {
      workspaceId: 'workspace-1',
      actorUserId: 'user-actor',
      actorName: 'Raha',
      attribution: humanAttribution('user-actor'),
      task: { id: 'task-1', key: 'CORE-12', title: 'Mention notification' },
      body: 'Plain @Sara text without mention metadata'
    });

    expect(mock.createManyCalls).toBe(0);
    expect(mock.createdNotifications).toEqual([]);
  });

  test('a markdown body mentions nobody, however it spells a person', async () => {
    // #53, and a decision rather than a leftover. A mention is a **node**, written by the rich-text
    // editor when a human picks a colleague out of an autocomplete; a markdown body carries none, so
    // an agent's `@Robin please look` reaches nobody. The alternative — a text syntax — would be a
    // second addressing form that only one client can write and no client renders, and #52 keeps an
    // Effort body markdown, so it would also have a map notifying rows that
    // `taskInboxNotificationWhere` filters out of every inbox read.
    //
    // What ended is the silence, not the rule: `taskara task create/edit/comment` now names the
    // handles it did not reach. This test is the rule's half of that, and it must fail loudly if a
    // text-mode path is ever added here without the surface being told.
    const mentionedUserId = 'user-mentioned';
    const spellings = [
      '@Robin please look at this',
      'ping robin@example.test when the build is green',
      `cc @${mentionedUserId}`,
      `see user ${mentionedUserId}`,
      '- [ ] ask @Sara\n\nand @Navid too'
    ];

    for (const body of spellings) {
      const mock = mockMentionTransaction([mentionedUserId]);
      const recipients = await createTaskMentionNotifications(mock.tx, {
        workspaceId: 'workspace-1',
        actorUserId: 'user-actor',
        actorName: 'Raha',
        attribution: humanAttribution('user-actor'),
        task: { id: 'task-1', key: 'CORE-12', title: 'Written in markdown' },
        body
      });

      expect({ body, recipients, calls: mock.createManyCalls }).toEqual({
        body,
        recipients: [],
        calls: 0
      });
    }
  });

  test('a body that carries mention nodes still notifies, whoever sent it', async () => {
    // The rule is about the nodes, not about the client, and the difference is load-bearing: a
    // session that reads a body with `task view` and writes it back is sending an editor state, and
    // the mentions already in it must survive the round trip rather than being dropped as
    // "not from the web".
    const mock = mockMentionTransaction(['user-sara']);

    const recipients = await createTaskMentionNotifications(mock.tx, {
      workspaceId: 'workspace-1',
      actorUserId: 'user-actor',
      actorName: 'Raha',
      attribution: humanAttribution('user-actor'),
      task: { id: 'task-1', key: 'CORE-12', title: 'Round-tripped body' },
      body: serializedBody([{ userId: 'user-sara', name: 'Sara' }])
    });

    expect(recipients).toEqual(['user-sara']);
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

  test('a member who muted the task is not subscribed to it again', async () => {
    const workspaceId = 'workspace-1';
    const mock = mockMentionTransaction(['user-actor', 'user-quiet'], [], ['user-quiet']);

    const subscribedUserIds = await subscribeUsersToTask(mock.tx, {
      workspaceId,
      taskId: 'task-1',
      userIds: ['user-actor', 'user-quiet']
    });

    // Skipped, not written-and-ignored. #54's whole point is that the automatic path stops offering
    // the row, so the returned list — which callers read to decide who was reached — must not name
    // somebody who was filtered out one line later.
    expect(subscribedUserIds).toEqual(['user-actor']);
    expect(mock.createdSubscriptions).toEqual([{ workspaceId, taskId: 'task-1', userId: 'user-actor' }]);
  });

  test('creates subscriber notifications except for the actor and excluded users', async () => {
    const workspaceId = 'workspace-1';
    const mock = mockMentionTransaction([], ['user-actor', 'user-subscriber', 'user-mentioned']);

    const recipientIds = await createTaskSubscriberNotifications(mock.tx, {
      workspaceId,
      actorUserId: 'user-actor',
      attribution: humanAttribution('user-actor'),
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
        ...humanAttribution('user-actor'),
        taskId: 'task-1',
        type: TASK_COMMENTED_NOTIFICATION_TYPE,
        title: 'CORE-12: Subscriber update',
        body: 'Raha دیدگاهی روی این کار گذاشت.'
      }
    ]);
  });

  test('collapses inbox notifications to the latest item per thread and keeps unread state', () => {
    const collapsed = collapseInboxNotificationsByThread([
      {
        id: 'n-1',
        taskId: 'task-1',
        announcementId: null,
        meetingId: null,
        knowledgePageId: null,
        createdAt: new Date('2026-05-10T10:00:00.000Z'),
        readAt: null
      },
      {
        id: 'n-2',
        taskId: 'task-1',
        announcementId: null,
        meetingId: null,
        knowledgePageId: null,
        createdAt: new Date('2026-05-10T11:00:00.000Z'),
        readAt: new Date('2026-05-10T12:00:00.000Z')
      },
      {
        id: 'n-3',
        taskId: 'task-2',
        announcementId: null,
        meetingId: null,
        knowledgePageId: null,
        createdAt: new Date('2026-05-10T11:30:00.000Z'),
        readAt: null
      }
    ]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]?.latest.id).toBe('n-3');
    expect(collapsed[0]?.hasUnread).toBe(true);
    expect(collapsed[1]?.latest.id).toBe('n-2');
    expect(collapsed[1]?.hasUnread).toBe(true);
  });

  test('builds thread scope by task, announcement, meeting, or fallback notification id', () => {
    expect(inboxNotificationThreadScope({ id: 'n-1', taskId: 'task-1' })).toEqual({ taskId: 'task-1' });
    expect(inboxNotificationThreadScope({ id: 'n-2', announcementId: 'ann-1' })).toEqual({
      announcementId: 'ann-1'
    });
    expect(inboxNotificationThreadScope({ id: 'n-3', meetingId: 'meeting-1' })).toEqual({
      meetingId: 'meeting-1'
    });
    expect(inboxNotificationThreadScope({ id: 'n-4' })).toEqual({ id: 'n-4' });
  });
});

/**
 * Issue #39 — an agent authors work but is not an audience for it. It has no inbox, so a row addressed
 * to one is never read and never cleared.
 *
 * Asserted on the resolved `where` rather than on an outcome, because the outcome depends on what the
 * database holds and the property is about the query. Same reasoning as measured-work-harness.ts.
 */
describe('notification recipients are people', () => {
  function captureRecipientWhere() {
    const seen: Array<Record<string, unknown>> = [];
    const tx = {
      workspaceMember: {
        findMany: async (args: WorkspaceMemberFindManyArgs) => {
          seen.push((args?.where || {}) as Record<string, unknown>);
          return [];
        }
      },
      notification: { createMany: async () => ({ count: 0 }) },
      taskSubscription: { createMany: async () => ({ count: 0 }) }
    } as unknown as Prisma.TransactionClient;
    return { tx, seen };
  }

  test('a task subscription is filtered to human members', async () => {
    const capture = captureRecipientWhere();

    await subscribeUsersToTask(capture.tx, {
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      userIds: ['user-agent', 'user-human']
    });

    expect(capture.seen).toHaveLength(1);
    expect(capture.seen[0]).toMatchObject({ user: { kind: 'HUMAN' } });
  });

  test('a mention is filtered to human members too', async () => {
    const capture = captureRecipientWhere();

    await createTaskMentionNotifications(capture.tx, {
      workspaceId: 'workspace-1',
      actorUserId: 'user-actor',
      actorName: 'Actor',
      attribution: { actorId: 'user-actor', actorType: 'USER', actorRuntime: null } as ActorAttribution,
      task: { id: 'task-1', key: 'CORE-1', title: 'Mentioning somebody' },
      body: serializedBody([{ userId: 'user-agent', name: 'Claude' }])
    });

    expect(capture.seen).toHaveLength(1);
    expect(capture.seen[0]).toMatchObject({ user: { kind: 'HUMAN' } });
  });

  test('the predicate is about kind, never about role — a guest is still a person', () => {
    // measuredMemberWhere drops GUEST because a guest must not move a number a human is judged by.
    // A guest must still be told when work they watch changes, so notifiableMemberWhere must not
    // borrow that clause. #37 is the standing lesson about merging two rules that overlap today.
    expect(notifiableMemberWhere).toEqual({ user: { kind: 'HUMAN' } });
    expect(JSON.stringify(notifiableMemberWhere)).not.toContain('role');
  });
});
