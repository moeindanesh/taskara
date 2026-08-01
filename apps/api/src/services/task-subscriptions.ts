import { prisma, type Prisma } from '@taskara/db';
import type { RequestActor } from './actor';

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
 * Nothing imports from `./notifications` here, so that `subscribeUsersToTask` can import
 * `mutedUserIds` without the two files forming a cycle. The deliberate writes need no
 * `notifiableMemberWhere`: they act on the request actor, who is a member of the workspace by the
 * time `getRequestActor` has returned.
 */

/**
 * Stop watching, and record that it was deliberate.
 *
 * One transaction, because the two writes are one decision: a crash between them would leave a
 * person unsubscribed but not muted, which is the pre-#54 behaviour — silently re-subscribed by the
 * next mention.
 *
 * An **agent** gets the delete and no mute row. #39 settled that an agent is not an audience, so
 * `subscribeUsersToTask` already refuses to subscribe one; a mute for a party that can never be
 * subscribed is a row with no reader, which is the same bookkeeping #39 removed. The verb still
 * succeeds, so an agent tidying up after itself is not a special case at the call site.
 */
export async function unsubscribeFromTask(actor: RequestActor, taskId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.taskSubscription.deleteMany({
      where: { workspaceId: actor.workspace.id, taskId, userId: actor.user.id }
    });
    if (actor.user.kind === 'AGENT') return;
    await tx.taskMute.upsert({
      where: { taskId_userId: { taskId, userId: actor.user.id } },
      create: { workspaceId: actor.workspace.id, taskId, userId: actor.user.id },
      update: {}
    });
  });
}

/**
 * Which of these people have decided not to watch this task.
 *
 * The one read of `TaskMute` on the automatic path. Returns a Set rather than a filtered list so the
 * caller keeps its own ordering — `subscribeUsersToTask` returns the ids it subscribed and callers
 * compare against them.
 */
export async function mutedUserIds(
  tx: Prisma.TransactionClient,
  input: { taskId: string; userIds: string[] }
): Promise<Set<string>> {
  if (!input.userIds.length) return new Set();
  const mutes = await tx.taskMute.findMany({
    where: { taskId: input.taskId, userId: { in: input.userIds } },
    select: { userId: true }
  });
  return new Set(mutes.map((mute) => mute.userId));
}
