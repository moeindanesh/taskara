import type { Prisma, TaskStatus, UserKind } from '@taskara/db';
import { statusLabel } from '@taskara/shared';
import type { ActorAttribution } from './actor-provenance';
import { workTaskWhere } from './measured-work';
import {
  announcementWhereForAccess,
  filterUsersWithTaskAccess,
  knowledgeSpaceWhereForAccess,
  meetingWhereForAccess,
  taskWhereForAccess,
  type WorkspaceAccess
} from './team-access';

/**
 * Who a notification can be delivered to: a person.
 *
 * A notification is a nudge to somebody who will read an inbox. An agent has none — it discovers work
 * by querying the frontier, which is a pull. Rows addressed to one are never read, never cleared, and
 * quietly wrong in any count over Notification.
 *
 * This is **not** `measuredMemberWhere`. That predicate also drops GUEST, because a guest must not move
 * a number a human is judged by — but a guest is still a person who should be told when work they watch
 * changes. The two rules agree on agents and disagree on guests, and #37 is the standing lesson about
 * what happens when overlapping rules get merged into one.
 *
 * Nothing here is about what an agent may *do*. Agents author work, and #38 makes that authorship
 * provable; they simply are not an audience for it.
 */
export const notifiableMemberWhere = { user: { kind: 'HUMAN' } } satisfies Prisma.WorkspaceMemberWhereInput;

/**
 * The same rule as `notifiableMemberWhere`, asked about one user the request already holds.
 *
 * Two forms of one rule rather than two rules: the predicate filters a query, this answers about an
 * actor in hand, and both must widen together if "audience" ever means more than HUMAN. Written as
 * a function so the sites that need it stop spelling `user.kind === 'AGENT'` inline — there were
 * three by the time #54 landed, and finding all of them is not a thing to leave to grep.
 */
export function isNotifiable(user: { kind: UserKind }): boolean {
  return user.kind === notifiableMemberWhere.user.kind;
}

export const TASK_ASSIGNED_NOTIFICATION_TYPE = 'task_assigned';
export const TASK_MENTIONED_NOTIFICATION_TYPE = 'task_mentioned';
export const TASK_STATUS_CHANGED_NOTIFICATION_TYPE = 'task_status_changed';
export const TASK_COMMENTED_NOTIFICATION_TYPE = 'task_commented';
export const TASK_DESCRIPTION_CHANGED_NOTIFICATION_TYPE = 'task_description_changed';
// The web inbox already carries a label for `task_blocked`; nothing had ever written one. Adding a
// blocker is the only event that makes a task un-takeable by someone else's decision, so it is the
// one dependency write that is news. Removing a blocker is deliberately silent: a task also becomes
// unblocked when its blocker is simply finished, and announcing only the manual half of that would
// be a signal people learn to distrust.
export const TASK_BLOCKED_NOTIFICATION_TYPE = 'task_blocked';
export const TASK_REVIEW_REQUESTED_NOTIFICATION_TYPE = 'task_review_requested';
export const TASK_REVIEW_DECIDED_NOTIFICATION_TYPE = 'task_review_decided';
export const ANNOUNCEMENT_PUBLISHED_NOTIFICATION_TYPE = 'announcement_published';
export const MEETING_ASSIGNED_NOTIFICATION_TYPE = 'meeting_assigned';
export const DAILY_REPORT_REMINDER_NOTIFICATION_TYPE = 'daily_report_reminder';
export const DAILY_REPORT_REQUESTED_NOTIFICATION_TYPE = 'daily_report_requested';
export const DAILY_REPORT_DIGEST_NOTIFICATION_TYPE = 'daily_report_digest_ready';

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

export function taskBlockedNotificationBody(actorName: string, blockerKey: string, blockerTitle: string): string {
  return `${actorName} این کار را وابسته به ${blockerKey} («${blockerTitle}») کرد.`;
}

/**
 * The same event, for a recipient who cannot open the blocker (#58).
 *
 * It still says the task became blocked, because that is what the person watching it needs to know
 * and it is a fact about *their* task. What it does not do is name the thing in the way — the same
 * line the issue page now draws, in the same words.
 */
export function taskBlockedByHiddenNotificationBody(actorName: string): string {
  return `${actorName} این کار را وابسته به کاری کرد که دسترسی به آن ندارید.`;
}

export function taskReviewRequestedNotificationBody(actorName: string): string {
  return `${actorName} از شما درخواست بازبینی این کار را کرد.`;
}

export function taskReviewApprovedNotificationBody(actorName: string): string {
  return `${actorName} بازبینی این کار را تایید کرد.`;
}

export function taskReviewChangesRequestedNotificationBody(actorName: string): string {
  return `${actorName} برای این کار درخواست تغییرات داد.`;
}

export function announcementPublishedNotificationBody(actorName: string): string {
  return `${actorName} اطلاعیه‌ای برای شما منتشر کرد.`;
}

export function meetingAssignedNotificationBody(actorName: string): string {
  return `${actorName} شما را به یک جلسه اضافه کرد.`;
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

/**
 * The one gate behind every inbox read — and therefore the one place that decides whether a
 * notification a person holds is a notification they are allowed to have.
 *
 * Behind it: the inbox list, the unread badge, `/notifications/sync`, `PATCH /notifications/:id/read`,
 * `/notifications/read-all`, `/notifications/delivered`, `GET /me` and `PATCH /me`.
 *
 * It takes a **`WorkspaceAccess`** rather than a workspace id and a user id, which is the whole point
 * of the shape: `access` already carries both, so there is no way to reach this function without
 * having decided what its reader may see. An optional access argument would have been forgotten at
 * one of the eight call sites, and that call site would have looked correct.
 *
 * ## Two clauses on the task branch, answering two different questions
 *
 * **Access** (#57) — `taskWhereForAccess`, the same predicate composed into every task read. A
 * notification's title is `KEY: Title` and the inbox hydrates the task beside it, so delivering one
 * for work behind a team wall discloses the work whether or not the link then 404s. The recipient
 * was resolved against workspace membership at write time; this is where that becomes a read the
 * reader is entitled to. It also answers the case no write-side check can see — a task that *moves*
 * out of reach after the row was written, when the project changes or its team is reassigned. The
 * row stays; it stops being delivered; if the task comes back within reach, so does it.
 *
 * **Measurement** (#33) — effort excluded. Not a Task query, which is why it is easy to miss and why
 * no Task-level mechanism reaches it.
 *
 * The two are spread in that order and are independent: an effort a reader *can* open is still
 * excluded, and a work task they cannot open is still hidden. Neither clause implies the other.
 *
 * ## The other three branches, which #57 left and #60 closed
 *
 * The argument that fixed the task branch was never about tasks. It was that **a notification row
 * outlives the reach it was written under**: the recipient was resolved at write time, and the
 * entity can move afterwards. A task changes project; a meeting drops a participant; a knowledge
 * page's space is a PROJECT space whose project's team is reassigned; an announcement's recipient
 * list is edited. Every one of those leaves a row that goes on delivering a title, and only a read
 * gate catches it.
 *
 * So each branch now composes that entity's own rule from the shared module — `meetingWhereForAccess`,
 * `announcementWhereForAccess`, `knowledgeSpaceWhereForAccess`. None is restated here.
 *
 * The first branch is the one worth reading twice. It admits a notification that points at nothing —
 * a daily-report reminder, a digest — and it did not name `knowledgePageId`, so **every**
 * knowledge-page notification matched it and the branch below was dead. That is why gating the
 * knowledge branch alone would have changed nothing.
 */
export function taskInboxNotificationWhere(
  access: WorkspaceAccess,
  options: { unreadOnly?: boolean } = {}
): Prisma.NotificationWhereInput {
  const { workspaceId, userId } = access;
  return {
    workspaceId,
    userId,
    OR: [
      { taskId: null, announcementId: null, meetingId: null, knowledgePageId: null },
      { task: { is: { ...taskWhereForAccess(access), ...workTaskWhere } } },
      { announcement: { is: announcementWhereForAccess(access) } },
      { meeting: { is: { workspaceId, ...meetingWhereForAccess(access) } } },
      { knowledgePage: { is: { workspaceId, space: { is: knowledgeSpaceWhereForAccess(access) } } } }
    ],
    ...(options.unreadOnly ? { readAt: null } : {})
  };
}

type InboxNotificationThreadEntity = {
  id: string;
  taskId?: string | null;
  announcementId?: string | null;
  meetingId?: string | null;
  knowledgePageId?: string | null;
};

export type InboxNotificationThreadRecord = InboxNotificationThreadEntity & {
  createdAt: Date | string;
  readAt?: Date | string | null;
};

export type CollapsedInboxNotificationThread<T extends InboxNotificationThreadRecord = InboxNotificationThreadRecord> = {
  threadKey: string;
  latest: T;
  hasUnread: boolean;
};

export function collapseInboxNotificationsByThread<T extends InboxNotificationThreadRecord>(
  notifications: T[]
): Array<CollapsedInboxNotificationThread<T>> {
  const sorted = [...notifications].sort(compareInboxNotificationsByRecency);
  const threadMap = new Map<string, CollapsedInboxNotificationThread<T>>();

  for (const notification of sorted) {
    const threadKey = inboxNotificationThreadKey(notification);
    const existing = threadMap.get(threadKey);

    if (!existing) {
      threadMap.set(threadKey, {
        threadKey,
        latest: notification,
        hasUnread: !notification.readAt
      });
      continue;
    }

    if (!notification.readAt) existing.hasUnread = true;
  }

  return [...threadMap.values()];
}

export function inboxNotificationThreadScope(
  notification: InboxNotificationThreadEntity
): Prisma.NotificationWhereInput {
  if (notification.taskId) return { taskId: notification.taskId };
  if (notification.announcementId) return { announcementId: notification.announcementId };
  if (notification.meetingId) return { meetingId: notification.meetingId };
  if (notification.knowledgePageId) return { knowledgePageId: notification.knowledgePageId };
  return { id: notification.id };
}

function inboxNotificationThreadKey(notification: InboxNotificationThreadEntity): string {
  if (notification.taskId) return `task:${notification.taskId}`;
  if (notification.announcementId) return `announcement:${notification.announcementId}`;
  if (notification.meetingId) return `meeting:${notification.meetingId}`;
  if (notification.knowledgePageId) return `knowledge:${notification.knowledgePageId}`;
  return `notification:${notification.id}`;
}

function compareInboxNotificationsByRecency(
  left: InboxNotificationThreadRecord,
  right: InboxNotificationThreadRecord
): number {
  const leftTime = notificationTimestamp(left.createdAt);
  const rightTime = notificationTimestamp(right.createdAt);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.id.localeCompare(left.id);
}

function notificationTimestamp(value: Date | string): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** What the automatic path needs off a task to know who is already involved in it. */
type ParticipantNotificationTask = {
  id: string;
  description?: string | null;
  assigneeId?: string | null;
  reporterId?: string | null;
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

  // Filtered by kind, and deliberately NOT by measuredMemberWhere: that predicate also drops GUEST,
  // and a guest is a person who should still be told when work they watch changes. Two rules that
  // overlap today are still two rules — see #37, where merging them is what went wrong.
  //
  // measured-people:allow — Task watchers: a delivery list, not a measurement.
  const workspaceMembers = await tx.workspaceMember.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: { in: requestedUserIds },
      ...notifiableMemberWhere
    },
    select: { userId: true }
  });
  const memberUserIds = [...new Set(workspaceMembers.map((member) => member.userId))];
  if (!memberUserIds.length) return [];

  // #54: a person who unsubscribed is not offered again. This is the ONE place the automatic path
  // consults a mute, and it is what turns unsubscribe from a button into a decision — without it,
  // the next mention or assignment silently re-adds them. Everything that auto-subscribes anybody
  // funnels through this function, which is why one check is enough. Spelled here rather than
  // imported from `./task-subscriptions`, which imports this file: one caller does not justify a
  // helper that would make the two import each other.
  const mutes = await tx.taskMute.findMany({
    where: { taskId: input.taskId, userId: { in: memberUserIds } },
    select: { userId: true }
  });
  const muted = new Set(mutes.map((mute) => mute.userId));
  const validUserIds = memberUserIds.filter((userId) => !muted.has(userId));
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
    task: ParticipantNotificationTask;
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
    attribution: ActorAttribution;
    task: SubscriberNotificationTask;
    type: string;
    body: string;
    /**
     * A **second** task the body names, and what to say instead to whoever cannot open it.
     *
     * `task_blocked` is the only body that does this today — it carries the blocker's key and
     * title on top of the blocked task's own in the title. #57 left it naming the blocker, on the
     * ground that it disclosed nothing the recipient could not already fetch from
     * `GET /tasks/:idOrKey`; #58 closed that route, so the justification went with it.
     *
     * Declared here rather than solved at the one call site because a body naming a second task is
     * a *shape*, not an incident: the next one will be written by somebody who never read this,
     * and an argument that lives in a parameter gets asked. The notification itself is never
     * dropped — watching a task that became blocked is the recipient's business either way; only
     * the name of the thing in the way is withheld.
     */
    namedTask?: { taskId: string; bodyWithout: string };
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
  const subscriberIds = [...new Set(subscriptions.map((subscription) => subscription.userId))];
  // #57. Every way onto this list is gated at the moment somebody joins it — but a task **moves**.
  // A project change, or a project reassigned to another team, takes work away from a subscriber
  // whose subscription was entirely legitimate when it was made, and no check on the way in can see
  // that coming. Re-asked here, per event, so the ambient stream stops at the wall rather than
  // narrating walled-off work to somebody who now 404s on it.
  //
  // The subscription row is deliberately left alone. A move is not a decision about attention, and
  // deleting it would silently discard a watch that comes back the moment the task does.
  const recipientIds = await filterUsersWithTaskAccess(tx, {
    workspaceId: input.workspaceId,
    taskId: input.task.id,
    userIds: subscriberIds
  });
  if (!recipientIds.length) return [];

  // The same question, asked about the other task. Reading the task a notification is *about* says
  // nothing about the one its body names, and the two need not share a project at all.
  const namedTaskReaders = input.namedTask
    ? new Set(await filterUsersWithTaskAccess(tx, {
        workspaceId: input.workspaceId,
        taskId: input.namedTask.taskId,
        userIds: recipientIds
      }))
    : null;

  await tx.notification.createMany({
    data: recipientIds.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      ...input.attribution,
      taskId: input.task.id,
      type: input.type,
      title: `${input.task.key}: ${input.task.title}`,
      body: namedTaskReaders && !namedTaskReaders.has(userId)
        ? (input.namedTask as { bodyWithout: string }).bodyWithout
        : input.body
    }))
  });

  return recipientIds;
}

/**
 * Tell whoever a body names that they were named.
 *
 * The subject is the **body**, not the task's description — #55. A task has two of them: the
 * description, which is revised, and a comment, which is written once. Both are bodies a person can
 * be addressed in, and passing the text explicitly is what lets one rule serve both rather than one
 * rule serving the field it happened to be written for.
 *
 * `previousBody` is what that same text said before this write, so re-saving a description does not
 * re-notify everyone still named in it. A comment has no previous version — there is no edit route
 * — so it omits the argument and every mention in it is new, which is right: a second comment
 * naming you is a second time you were addressed.
 */
export async function createTaskMentionNotifications(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    actorName: string;
    attribution: ActorAttribution;
    task: SubscriberNotificationTask;
    body?: string | null;
    previousBody?: string | null;
  }
): Promise<string[]> {
  const currentMentions = extractTaskMentionUserIds(input.body);
  if (!currentMentions.length) return [];

  const previousMentions = new Set(extractTaskMentionUserIds(input.previousBody));
  const mentionedUserIds = currentMentions.filter(
    (userId) => userId !== input.actorUserId && !previousMentions.has(userId)
  );
  if (!mentionedUserIds.length) return [];

  // measured-people:allow — Resolves @-mentions to real members before notifying them. An agent has no
  // inbox, so a mention of one produces no row; it is still visible in the body a human reads.
  const workspaceMembers = await tx.workspaceMember.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: { in: mentionedUserIds },
      ...notifiableMemberWhere
    },
    select: { userId: true }
  });
  const notifiableUserIds = [...new Set(workspaceMembers.map((member) => member.userId))];
  // #57. Membership in the workspace was never the question — being able to open the task is. The
  // title of the row about to be written is `KEY: Title`, so notifying somebody who then gets a 404
  // discloses the work by delivering it. Silently, like every other way a mention resolves to
  // nobody: naming a non-member and naming an agent already write no row, and a body is a place
  // people write freely rather than a form with a validation message.
  const validUserIds = await filterUsersWithTaskAccess(tx, {
    workspaceId: input.workspaceId,
    taskId: input.task.id,
    userIds: notifiableUserIds
  });
  if (!validUserIds.length) return [];

  await tx.notification.createMany({
    data: validUserIds.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      ...input.attribution,
      taskId: input.task.id,
      type: TASK_MENTIONED_NOTIFICATION_TYPE,
      title: `${input.task.key}: ${input.task.title}`,
      body: taskMentionedNotificationBody(input.actorName)
    }))
  });

  return validUserIds;
}

/**
 * The people a body mentions: whoever its **mention nodes** name, and nobody else.
 *
 * A mention is a node the rich-text editor writes when a human picks a colleague out of an
 * autocomplete. It is not a spelling, which is why a markdown body mentions nobody however it
 * writes a person — `@Robin`, an email, a bare uuid, all nothing. #53 settled that this stays so:
 *
 * - A text syntax would be a **second addressing form** that only one client can write and no
 *   client renders. The web editor loads a markdown body as plain paragraphs and saves it back as
 *   an editor state, so a text mention would stop being one the next time a human touched the task
 *   — the same client-dependence in a new place. Meanwhile a mention node cannot be typed by
 *   accident, and a syntax can: an agent pasting a log or a review would notify a real person.
 * - #52 keeps an Effort body markdown, and `taskInboxNotificationWhere` filters efforts out of
 *   every inbox read. So a text mention in a map would write rows no inbox ever shows.
 *
 * The rule is about the nodes and not about the client: a session that reads a body with
 * `task view` and writes it back is sending an editor state, and the mentions in it still fire.
 *
 * **What was silent is not.** `taskara task create/edit/comment` names the handles a body appears
 * to address and says none of them was told — see `core/mentions.ts` in the agent plugin. A rule
 * this file enforces and no surface states is the bug #53 was filed about.
 */
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
