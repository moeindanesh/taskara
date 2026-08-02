import { prisma, type Prisma } from '@taskara/db';
import type { RequestActor } from './actor';
import { isNotifiable } from './notifications';

/**
 * Watching a task, and deliberately not watching it — the two deliberate states, and the writes
 * that move between them.
 *
 * Auto-subscribe lives next door in `services/notifications.ts`, because it is a side effect of
 * notifying. This file is the *deliberate* half: what a person chose, which is the half that has to
 * survive the automatic one.
 *
 * ## The three states, and what absence means
 *
 * | rows                    | meaning                                                    |
 * |-------------------------|------------------------------------------------------------|
 * | neither                 | nobody has decided anything — auto-subscribe may fill this |
 * | `TaskSubscription`      | watching: notify this person                                |
 * | `TaskMute`              | deliberately not watching: never auto-subscribe them again  |
 *
 * Absence from `TaskSubscription` still means exactly what it meant before this file existed — do
 * not deliver — so no existing reader had to learn anything. What is new is that absence is no
 * longer the *only* way to be un-notified, and only a mute row is a decision.
 *
 * ## What a mute governs, and what it does not
 *
 * It governs the **subscriber fan-out**: the ambient stream of comments, status changes and body
 * edits on a task you are merely watching. It does not govern being spoken to. Assignment, a review
 * request and an `@`-mention each write a notification addressed to one person by name, through
 * `notification.create` rather than `createTaskSubscriberNotifications`, and none of them consults
 * this. Silencing those would turn "stop telling me about this task" into "never contact me about
 * this task again" — a much larger promise, made by accident, that the person could not discover
 * they had made. Pinned by tests in `routes/task-subscription.test.ts`, because the boundary is one
 * a later refactor could erase by routing an assignment through the fan-out.
 *
 * ## Not written to the activity log
 *
 * Deliberately. Every other write here logs, but a task's activity feed is read by the whole team,
 * and "Sara stopped watching this" is a private decision about attention rather than a change to
 * the work. The person who made it can see it in `?subscription=muted`; nobody else needs to.
 *
 * The dependency runs one way, this file → `./notifications`, and it is kept that way on purpose.
 * The mute lookup on the automatic path is spelled inline in `subscribeUsersToTask` rather than
 * exported from here: it has exactly one caller, and a helper reaching back across the seam would
 * make the two files import each other.
 */

/** The three states, named. The wire and the database agree on these words. */
export type TaskWatchState = 'watching' | 'muted' | 'none';

/**
 * Stop watching, and record that it was deliberate. Answers with the state it actually left.
 *
 * One transaction, because the two writes are one decision: a crash between them would leave a
 * person unsubscribed but not muted, which is the pre-#54 behaviour — silently re-subscribed by the
 * next mention.
 *
 * An **agent** gets the delete and no mute row, and is told `none` rather than `muted`. #39 settled
 * that an agent is not an audience, so `subscribeUsersToTask` already refuses to subscribe one; a
 * mute for a party that can never be subscribed is a row with no reader, which is the same
 * bookkeeping #39 removed. The verb still succeeds, so an agent tidying up after itself is not a
 * special case at the call site — but it is told the truth, because a caller that then reads
 * `?subscription=muted` must not find the answer contradicted.
 */
export async function unsubscribeFromTask(actor: RequestActor, taskId: string): Promise<TaskWatchState> {
  return prisma.$transaction(async (tx) => {
    await tx.taskSubscription.deleteMany({
      where: { workspaceId: actor.workspace.id, taskId, userId: actor.user.id }
    });
    if (!isNotifiable(actor.user)) return 'none';
    await tx.taskMute.upsert({
      where: { taskId_userId: { taskId, userId: actor.user.id } },
      create: { workspaceId: actor.workspace.id, taskId, userId: actor.user.id },
      update: {}
    });
    return 'muted';
  });
}

/**
 * Start watching, deliberately — and withdraw any earlier decision not to.
 *
 * The mute is deleted rather than left beside the new subscription: two rows saying opposite things
 * would oblige every later reader to know which one wins, and there is no good answer to give them.
 *
 * The counterpart of the automatic path, and unlike it this one does not care whether the person was
 * ever a participant — asking to watch is the whole justification.
 *
 * `tx` is taken rather than assumed, because `claimTask` calls this **inside** its own transaction:
 * taking a task and being put back on its list is one act, and a nested `prisma.$transaction` would
 * open a second connection that cannot see the claim it is reacting to.
 */
export async function subscribeToTask(
  actor: RequestActor,
  taskId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<TaskWatchState> {
  await tx.taskMute.deleteMany({ where: { taskId, userId: actor.user.id } });
  await tx.taskSubscription.createMany({
    data: [{ workspaceId: actor.workspace.id, taskId, userId: actor.user.id }],
    skipDuplicates: true
  });
  return 'watching';
}

