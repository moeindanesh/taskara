import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Watching a task, and deliberately not watching it.
 *
 * Issue #54: `subscribeTaskParticipants` added the reporter, the assignee and everyone mentioned,
 * permanently — the only `taskSubscription.deleteMany` in the codebase was workspace-membership
 * removal, so the only way to stop hearing about a task was to leave the team.
 *
 * The whole difficulty is stickiness, and it is asserted here rather than argued: an unsubscribe
 * that the next mention undoes is a button that does not work, so every test below that unsubscribes
 * then goes on to *re-trigger the auto-subscribe* and checks that nothing came back.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  reporterEmail: string;
  reporterId: string;
  watcherEmail: string;
  watcherId: string;
  agentEmail: string;
  agentId: string;
  /** Agent Users cannot authenticate by email — #29 requires a credential, so the fixture mints one. */
  agentToken: string;
  /** Added, removed and re-added by one test; named here only so the teardown can find the row. */
  leaverEmail: string;
  projectId: string;
}

describe('task subscription', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: {
        email: { in: [fixture.reporterEmail, fixture.watcherEmail, fixture.agentEmail, fixture.leaverEmail] }
      }
    });
    await app.close();
  });

  test('unsubscribing stops the notifications an assignee was getting', async () => {
    const task = await createTask('assigned, and then unwanted', { assigneeId: fixture.watcherId });
    // The state the ticket describes: assignment subscribed them and nothing could undo it.
    expect(await subscriptionCount(task.id)).toBe(1);

    // The control. Without it the assertion below could pass because this task never notified
    // anybody — which is exactly how a subscription test goes vacuous.
    await comment(task.key, fixture.reporterEmail, 'while they were still watching');
    expect(await notificationCount(task.id, 'task_commented')).toBe(1);

    const response = await unsubscribe(task.key, { email: fixture.watcherEmail });

    expect(response.statusCode).toBe(200);
    expect(await subscriptionCount(task.id)).toBe(0);

    await comment(task.key, fixture.reporterEmail, 'something the watcher no longer cares about');
    expect(await notificationCount(task.id, 'task_commented')).toBe(1);
  });

  test('the next assignment does not re-subscribe somebody who unsubscribed', async () => {
    const task = await createTask('handed back and forth', { assigneeId: fixture.watcherId });
    expect((await unsubscribe(task.key, { email: fixture.watcherEmail })).statusCode).toBe(200);

    // Away and back again, so this is unambiguously "the next time they are assigned" and not one
    // PATCH that happened to restate the assignee it already had.
    await patch(task.key, { assigneeId: fixture.reporterId });
    await patch(task.key, { assigneeId: fixture.watcherId });

    expect(await subscriptionCount(task.id)).toBe(0);
    await comment(task.key, fixture.reporterEmail, 'and still they hear nothing');
    expect(await notificationCount(task.id, 'task_commented')).toBe(0);
  });

  /**
   * What a mute is, and what it deliberately is not.
   *
   * It governs the **subscriber fan-out** — the ambient stream of comments, status changes and body
   * edits on a task you are merely watching. It does not govern being spoken to. Assignment, a
   * review request and an `@`-mention each write a notification addressed to one person by name, and
   * silencing those would turn "stop telling me about this task" into "never contact me about this
   * task again", which nobody asked for and nobody could discover they had done.
   *
   * The two halves are pinned together on purpose: the message still arrives, **and** it still does
   * not put the person back on the fan-out list.
   */
  test('a mention still reaches somebody who muted, and still does not re-subscribe them', async () => {
    const task = await createTask('muted, then mentioned');
    expect((await unsubscribe(task.key, { email: fixture.watcherEmail })).statusCode).toBe(200);

    await patch(task.key, { description: mentionBody(fixture.watcherId) });

    expect(await notificationCount(task.id, 'task_mentioned')).toBe(1);
    expect(await subscriptionCount(task.id)).toBe(0);

    // And the fan-out really is still silent for them: somebody else commenting reaches nobody.
    await comment(task.key, fixture.reporterEmail, 'ambient chatter they opted out of');
    expect(await notificationCount(task.id, 'task_commented')).toBe(0);
  });

  /**
   * Issue #55 — the same question, asked about the other body a task has.
   *
   * `addTaskComment` never scanned the comment body, so a mention there notified nobody in any
   * client. These live here rather than in a file of their own because every question #55 had to
   * answer is a question about *watching*: whether being named puts you on the list, and whether a
   * mute you already recorded survives being named. The description twin is directly above, and a
   * refactor that breaks one should break both without having to find two files.
   */
  describe('a mention in a comment', () => {
    test('reaches the person it names', async () => {
      const task = await createTask('a question for somebody not yet involved');

      await comment(task.key, fixture.reporterEmail, mentionBody(fixture.watcherId));

      expect(await notificationCount(task.id, 'task_mentioned')).toBe(1);
    });

    /**
     * One comment is one event, so it is one row — and the mention is the row that survives.
     *
     * Both would arrive at the same instant: `createdAt` defaults to `now()`, which in Postgres is
     * the transaction's start time, so two rows written by one comment carry the *identical*
     * timestamp. `collapseInboxNotificationsByThread` then keys both to `task:<id>` and breaks the
     * tie on id — so without this the inbox would show "commented" or "mentioned" at random for the
     * same event, and the unread badge would count it twice.
     *
     * The mention wins because it is the more specific truth: being named is why this comment is
     * yours to read. Same rule, and the same `excludeUserIds` mechanism, that a description edit
     * already applies to `task_description_changed`.
     */
    test('supersedes the task_commented row rather than arriving beside it', async () => {
      const task = await createTask('already watching, and now named', { assigneeId: fixture.watcherId });

      // The control. A plain comment on this same task is exactly one ambient row — so if the
      // assertion below saw zero, it would be because the mention path suppressed it and not
      // because nothing was listening.
      await comment(task.key, fixture.reporterEmail, 'ordinary chatter first');
      expect(await notificationCount(task.id, 'task_commented')).toBe(1);

      await comment(task.key, fixture.reporterEmail, mentionBody(fixture.watcherId));

      expect(await notificationCount(task.id, 'task_mentioned')).toBe(1);
      expect(await notificationCount(task.id, 'task_commented')).toBe(1);
    });
  });

  test('being assigned a muted task still tells you, because that is addressed to you', async () => {
    const task = await createTask('muted, then handed over');
    expect((await unsubscribe(task.key, { email: fixture.watcherEmail })).statusCode).toBe(200);

    await patch(task.key, { assigneeId: fixture.watcherId });

    expect(await notificationCount(task.id, 'task_assigned')).toBe(1);
    expect(await subscriptionCount(task.id)).toBe(0);
  });

  test('subscribing again is the way back, and it clears the decision not to watch', async () => {
    const task = await createTask('muted, then wanted again', { assigneeId: fixture.watcherId });
    expect((await unsubscribe(task.key, { email: fixture.watcherEmail })).statusCode).toBe(200);
    expect(await muteCount(task.id)).toBe(1);

    const response = await subscribe(task.key, { email: fixture.watcherEmail });

    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({ state: 'watching' });
    // The mute is gone rather than shadowed. A mute left behind would be a row saying the opposite
    // of the subscription beside it, and the next reader would have to know which one wins.
    expect(await muteCount(task.id)).toBe(0);
    expect(await subscriptionCount(task.id)).toBe(1);

    await comment(task.key, fixture.reporterEmail, 'and they hear it again');
    expect(await notificationCount(task.id, 'task_commented')).toBe(1);
  });

  test('the list answers both questions: what am I watching, and what did I mute', async () => {
    const watched = await createTask('still watching this one', { assigneeId: fixture.watcherId });
    const muted = await createTask('muted this one', { assigneeId: fixture.watcherId });
    // Never touched by this person at all — the third state, and the one that must appear in
    // neither list. Without it both filters could be returning "every task" and still look right.
    const untouched = await createTask('nothing to do with them');
    expect((await unsubscribe(muted.key, { email: fixture.watcherEmail })).statusCode).toBe(200);

    const watching = await listKeys('subscription=watching', fixture.watcherEmail);
    expect(watching).toContain(watched.key);
    expect(watching).not.toContain(muted.key);
    expect(watching).not.toContain(untouched.key);

    // Not an exact list: earlier tests in this file share the fixture and left their own mutes
    // behind, and asserting the whole set would be asserting the order this file happens to run in.
    const silenced = await listKeys('subscription=muted', fixture.watcherEmail);
    expect(silenced).toContain(muted.key);
    expect(silenced).not.toContain(watched.key);
    expect(silenced).not.toContain(untouched.key);

    // Per caller, not per task. The reporter watches everything they filed, and none of it is
    // theirs to have muted — including the row the watcher just muted.
    expect(await listKeys('subscription=muted', fixture.reporterEmail)).toEqual([]);
    expect(await listKeys('subscription=watching', fixture.reporterEmail)).toContain(untouched.key);
  });

  /**
   * The one place the effort exclusion must not apply.
   *
   * An Effort's body is a living document that every resolving session appends to, and #33's own
   * note in `notifications.ts` says every revision of it fans out to all its subscribers — so an
   * effort is the *heaviest* thing a person can be subscribed to, and the likeliest thing they want
   * to mute. Hiding it from this list would make a muted effort unfindable forever, which is the
   * failure the ticket names: "or the unsubscribe has nothing to aim at".
   */
  test('an effort is visible in the subscription lists, unlike everywhere else', async () => {
    const effort = await createTask('a map with a living body', { kind: 'EFFORT', status: 'IN_PROGRESS' });
    expect((await subscribe(effort.key, { email: fixture.watcherEmail })).statusCode).toBe(200);

    expect(await listKeys('subscription=watching', fixture.watcherEmail)).toContain(effort.key);

    // And the exclusion is untouched everywhere it belongs: the plain list is still work only.
    expect(await listKeys('', fixture.watcherEmail)).not.toContain(effort.key);

    expect((await unsubscribe(effort.key, { email: fixture.watcherEmail })).statusCode).toBe(200);
    expect(await listKeys('subscription=muted', fixture.watcherEmail)).toContain(effort.key);
  });

  test('unsubscribing answers with the state it actually left behind', async () => {
    const task = await createTask('answered honestly');

    const response = await unsubscribe(task.key, { email: fixture.watcherEmail });

    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({ state: 'muted' });
  });

  test('claiming a task you once muted is your own act, so it puts you back on the list', async () => {
    const task = await createTask('muted, then taken');
    expect((await unsubscribe(task.key, { email: fixture.watcherEmail })).statusCode).toBe(200);

    const claimed = await app.inject({
      method: 'POST',
      url: `/tasks/${task.key}/claim`,
      headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.watcherEmail },
      payload: {}
    });

    expect(claimed.statusCode).toBe(200);
    // Stickiness protects a decision from *other people's* writes. Taking the work is the muter's
    // own deliberate act, and holding a task while hearing nothing about it is not what they asked
    // for — so this withdraws the mute, exactly as an explicit subscribe does.
    expect(await muteCount(task.id)).toBe(0);
    expect(await subscriptionCount(task.id)).toBe(1);

    await comment(task.key, fixture.reporterEmail, 'a question about work they now hold');
    expect(await notificationCount(task.id, 'task_commented')).toBe(1);
  });

  test('the filter composes with the rest of the query rather than replacing it', async () => {
    const open = await createTask('watched and unfinished', { assigneeId: fixture.watcherId });
    const done = await createTask('watched and finished', { assigneeId: fixture.watcherId });
    await patch(done.key, { status: 'DONE' });

    const keys = await listKeys('subscription=watching&status=unfinished', fixture.watcherEmail);

    expect(keys).toContain(open.key);
    expect(keys).not.toContain(done.key);
  });

  test('a member who leaves and comes back is not still silently muted', async () => {
    const leaver = await addMember(fixture.leaverEmail);
    const task = await createTask('muted by somebody on their way out', { assigneeId: leaver.id });
    expect((await unsubscribe(task.key, { email: leaver.email })).statusCode).toBe(200);

    await removeMember(leaver.id);
    await addMember(leaver.email);

    // The same reasoning that already deleted their subscriptions on the way out. A mute that
    // outlives the membership is a decision about a workspace they had left, and it comes back into
    // force against tasks they would have no memory of having muted.
    await patch(task.key, { assigneeId: fixture.reporterId });
    await patch(task.key, { assigneeId: leaver.id });
    expect(await prisma.taskSubscription.count({ where: { taskId: task.id, userId: leaver.id } })).toBe(1);
  });

  /**
   * #39 settled that an agent is not an audience for notifications. That does not make the verb a
   * special case at the call site — an agent tidying up runs the same command a person does — but it
   * does decide what the two writes are allowed to leave behind.
   */
  describe('an agent, which is not an audience', () => {
    test('cannot start watching, and is told why rather than quietly succeeding', async () => {
      const task = await createTask('not for an agent to watch');

      const response = await subscribe(task.key, { token: fixture.agentToken });

      expect(response.statusCode).toBe(400);
      expect((response.json() as { message: string }).message).toContain('no notifications');
      expect(await prisma.taskSubscription.count({ where: { taskId: task.id, userId: fixture.agentId } })).toBe(0);
    });

    test('unsubscribing succeeds and writes no mute, because there is nothing to keep quiet', async () => {
      const task = await createTask('an agent tidying up after itself');

      const response = await unsubscribe(task.key, { token: fixture.agentToken });

      // The verb works, so a script does not need to know who is running it — and it answers with
      // the state it really left, which for an agent is "no decision recorded" rather than "muted".
      expect(response.statusCode).toBe(200);
      expect(response.json() as unknown).toEqual({ state: 'none' });
      // And leaves nothing behind. `subscribeUsersToTask` already refuses to subscribe an agent, so
      // a mute for one would be a row that can never change any outcome — the bookkeeping #39
      // removed, reintroduced one table over.
      expect(await prisma.taskMute.count({ where: { taskId: task.id, userId: fixture.agentId } })).toBe(0);
    });
  });
});

function unsubscribe(idOrKey: string, who: Identity) {
  return app.inject({
    method: 'DELETE',
    url: `/tasks/${idOrKey}/subscription`,
    headers: identify(who)
  });
}

function subscribe(idOrKey: string, who: Identity) {
  return app.inject({
    method: 'POST',
    url: `/tasks/${idOrKey}/subscription`,
    headers: identify(who),
    payload: {}
  });
}

/** An email for a person, a bearer token for an agent — the two ways to be somebody here. */
type Identity = { email: string } | { token: string };

function identify(who: Identity): Record<string, string> {
  const headers: Record<string, string> = { 'x-workspace-slug': fixture.workspaceSlug };
  if ('token' in who) headers.authorization = `Bearer ${who.token}`;
  else headers['x-user-email'] = who.email;
  return headers;
}

async function comment(idOrKey: string, email: string, body: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${idOrKey}/comments`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: { body }
  });
  expect(response.statusCode).toBe(201);
}

/**
 * A description carrying one `@`-mention, in the editor's serialized form.
 *
 * Written as Lexical JSON rather than markdown because `extractTaskMentionUserIds` bails unless the
 * body starts with `{` — the gap #53 owns. A markdown `@name` would yield no mention at all, and
 * this test would pass without exercising anything.
 */
function mentionBody(userId: string): string {
  return JSON.stringify({
    root: {
      type: 'root',
      children: [{
        type: 'paragraph',
        children: [{ type: 'mention', version: 1, text: '@Watcher', mentionUserId: userId }]
      }]
    }
  });
}

async function addMember(email: string): Promise<{ id: string; email: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.reporterEmail },
    payload: { email, name: 'Leaver' }
  });
  expect([200, 201]).toContain(response.statusCode);
  return { id: (response.json() as { id: string }).id, email };
}

async function removeMember(userId: string): Promise<void> {
  const response = await app.inject({
    method: 'DELETE',
    url: `/users/${userId}/membership`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.reporterEmail }
  });
  expect(response.statusCode).toBe(204);
}

async function listKeys(query: string, email: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/tasks?${query}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: Array<{ key: string }> }).items.map((item) => item.key);
}

async function patch(idOrKey: string, body: Record<string, unknown>): Promise<void> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/tasks/${idOrKey}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.reporterEmail },
    payload: body
  });
  expect(response.statusCode).toBe(200);
}

function subscriptionCount(taskId: string): Promise<number> {
  return prisma.taskSubscription.count({ where: { taskId, userId: fixture.watcherId } });
}

function muteCount(taskId: string): Promise<number> {
  return prisma.taskMute.count({ where: { taskId, userId: fixture.watcherId } });
}

/**
 * Counted by type, not in total. Creating a task assigned to somebody already sends them a
 * `task_assigned` row, so a bare count over the task would be 1 before the interesting write ever
 * happened — and a test that starts at 1 and asserts 1 is a test that passes when nothing works.
 */
function notificationCount(taskId: string, type: string): Promise<number> {
  return prisma.notification.count({ where: { taskId, userId: fixture.watcherId, type } });
}

async function createTask(
  title: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; key: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.reporterEmail },
    payload: { projectId: fixture.projectId, title, ...extra }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const reporterEmail = `sub-reporter-${suffix}@example.test`;
  const watcherEmail = `sub-watcher-${suffix}@example.test`;
  const agentEmail = `sub-agent-${suffix}@example.test`;
  const reporter = await prisma.user.create({ data: { email: reporterEmail, name: 'Reporter' } });
  const watcher = await prisma.user.create({ data: { email: watcherEmail, name: 'Watcher' } });
  // An ordinary MEMBER, marked as an agent by kind. Role says what it may do; kind says what it is.
  const agent = await prisma.user.create({
    data: { email: agentEmail, name: 'Claude', kind: 'AGENT', operatorId: reporter.id }
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'Subscription workspace', slug: `sub-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: reporter.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: watcher.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
    ]
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Subs', keyPrefix: `SB${suffix.slice(0, 3).toUpperCase()}` }
  });

  // Minted through the route an operator uses, so these tests authenticate the way an agent really
  // does rather than through a hand-built row that skips the check under test.
  const issued = await app.inject({
    method: 'POST',
    url: '/agent-credentials',
    headers: { 'x-workspace-slug': workspace.slug, 'x-user-email': reporterEmail },
    payload: { userId: agent.id, name: 'Subscription test' }
  });
  expect(issued.statusCode).toBe(201);

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    reporterEmail,
    reporterId: reporter.id,
    watcherEmail,
    watcherId: watcher.id,
    agentEmail,
    agentId: agent.id,
    agentToken: (issued.json() as { token: string }).token,
    leaverEmail: `sub-leaver-${suffix}@example.test`,
    projectId: project.id
  };
}
