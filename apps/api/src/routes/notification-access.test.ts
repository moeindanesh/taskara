import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * A notification may not name a task its recipient cannot open.
 *
 * Issue #57. A notification's title is `KEY: Title` and the inbox hydrates the task beside it, so a
 * delivered row is a disclosure whether or not the link works. Two people are needed to test this
 * at all: an **insider**, on the project's team, and an **outsider**, a full workspace member on no
 * team. Every test below asserts the outsider is not reached *and* the insider still is — a filter
 * that reaches nobody would pass the first half on its own, which is how a fix like this quietly
 * turns the inbox off.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerEmail: string;
  ownerId: string;
  /** On the project's team: can read the work, so must still be notified about it. */
  insiderEmail: string;
  insiderId: string;
  /** A workspace member on no team: cannot open the work, so must hear nothing about it. */
  outsiderEmail: string;
  outsiderId: string;
  /** Owned by a team the insider is on and the outsider is not. */
  projectId: string;
  /** Owned by a team nobody is on: unreachable to everyone but an admin. */
  farProjectId: string;
  /** On the far team, but **led** by the outsider: reachable without any team membership. */
  ledProjectId: string;
  /** On the far team, with the outsider an explicit `ProjectMember`: the other way in. */
  memberProjectId: string;
  /** Teamless, so every workspace member can read it. The control for "still reaches people". */
  openProjectId: string;
}

describe('notification task access', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: { email: { in: [fixture.ownerEmail, fixture.insiderEmail, fixture.outsiderEmail] } }
    });
    await app.close();
  });

  /**
   * The read half, tested against rows put straight into the table.
   *
   * Seeded rather than provoked on purpose: this is the population a write-side fix cannot reach —
   * everything already written before the gate existed. If the read gate were skipped, these rows
   * would keep being delivered forever.
   */
  test('the inbox hides a notification whose task the reader cannot open', async () => {
    const task = await createTask('work behind a team wall', fixture.projectId);
    await seedNotification(task, fixture.outsiderId);
    await seedNotification(task, fixture.insiderId);

    expect(await inboxKeys(fixture.outsiderEmail)).not.toContain(task.key);
    expect(await inboxKeys(fixture.insiderEmail)).toContain(task.key);
  });

  test('the unread badge does not count what the inbox will not show', async () => {
    const task = await createTask('counted by nobody who cannot read it', fixture.projectId);
    const outsiderBefore = await unreadBadge(fixture.outsiderEmail);
    const insiderBefore = await unreadBadge(fixture.insiderEmail);

    await seedNotification(task, fixture.outsiderId);
    await seedNotification(task, fixture.insiderId);

    expect(await unreadBadge(fixture.outsiderEmail)).toBe(outsiderBefore);
    expect(await unreadBadge(fixture.insiderEmail)).toBe(insiderBefore + 1);
  });

  test('a sync client is told about the same rows the inbox lists, and no others', async () => {
    const task = await createTask('synced only to people who can open it', fixture.projectId);
    await seedNotification(task, fixture.outsiderId);
    await seedNotification(task, fixture.insiderId);

    expect(await syncKeys(fixture.outsiderEmail)).not.toContain(task.key);
    expect(await syncKeys(fixture.insiderEmail)).toContain(task.key);
  });

  /**
   * The gate decides what a reader may *touch*, not only what they may see. Marking a hidden row
   * read would be a second way to learn it exists — a 200 where a stranger gets a 404 — and it
   * would let a caller clear a badge it was never counted in.
   */
  test('a hidden notification cannot be marked read through its own id', async () => {
    const task = await createTask('unreadable, and unmarkable', fixture.projectId);
    const hidden = await seedNotification(task, fixture.outsiderId);
    const visible = await seedNotification(task, fixture.insiderId);

    expect((await markRead(hidden.id, fixture.outsiderEmail)).statusCode).toBe(404);
    expect((await markRead(visible.id, fixture.insiderEmail)).statusCode).toBe(200);
  });

  test('a teamless project still reaches every member, which is what the gate must not break', async () => {
    const task = await createTask('open to the whole workspace', fixture.openProjectId);
    await seedNotification(task, fixture.outsiderId);

    expect(await inboxKeys(fixture.outsiderEmail)).toContain(task.key);
  });

  test('a workspace admin reads an inbox for work in a team they never joined', async () => {
    const task = await createTask('admin sees everything, as everywhere else', fixture.farProjectId);
    await seedNotification(task, fixture.ownerId);

    expect(await inboxKeys(fixture.ownerEmail)).toContain(task.key);
  });

  /**
   * The write half, asserted against the **table** and never through the inbox.
   *
   * Reading these back through `GET /notifications` would prove nothing once the gate above exists:
   * the row would be hidden either way, and the test would pass with no write-side filter at all.
   * A row that is written and never shown is still a row — countable, exportable, and there for
   * whatever reads `Notification` next.
   */
  describe('the row is not written in the first place', () => {
    test('a mention in a description does not notify somebody who cannot open the task', async () => {
      const task = await createTask('named in a body they cannot read', fixture.projectId, {
        description: mentionBody([fixture.outsiderId, fixture.insiderId])
      });

      expect(await mentionRowCount(task.id, fixture.outsiderId)).toBe(0);
      expect(await mentionRowCount(task.id, fixture.insiderId)).toBe(1);
    });

    test('a mention in a comment does not notify somebody who cannot open the task', async () => {
      const task = await createTask('named in a comment they cannot read', fixture.projectId);

      await comment(task.key, mentionBody([fixture.outsiderId, fixture.insiderId]));

      expect(await mentionRowCount(task.id, fixture.outsiderId)).toBe(0);
      expect(await mentionRowCount(task.id, fixture.insiderId)).toBe(1);
    });

    test('a mention on a teamless task still reaches every member', async () => {
      const task = await createTask('named where everyone can read', fixture.openProjectId, {
        description: mentionBody([fixture.outsiderId])
      });

      expect(await mentionRowCount(task.id, fixture.outsiderId)).toBe(1);
    });

    /**
     * The third question on the ticket, and the one that decides the shape of the whole fix: a task
     * that moves out of reach after somebody legitimately started watching it.
     *
     * Nothing at the point of subscription was wrong — a teamless task is readable by the whole
     * workspace, and both of these people subscribed to one. Moving it into a team is what takes it
     * away from one of them, and no check on the way in can see that coming.
     *
     * Both people are moved together so the two halves cannot be satisfied by an off switch: one
     * subscriber must stop hearing about it and the other must not.
     */
    test('a task that moves out of reach stops writing to the people it left behind', async () => {
      const task = await createTask('watched, then walled off', fixture.openProjectId);
      await subscribe(task.key, fixture.insiderEmail);
      await subscribe(task.key, fixture.outsiderEmail);

      // The control. Without it the assertion after the move could pass because nothing was ever
      // listening — which is how a fan-out test goes vacuous.
      await comment(task.key, 'while it was still everyone\'s');
      expect(await commentedRowCount(task.id, fixture.insiderId)).toBe(1);
      expect(await commentedRowCount(task.id, fixture.outsiderId)).toBe(1);

      await moveToProject(task.key, fixture.projectId);
      await comment(task.key, 'after it moved behind a wall');

      expect(await commentedRowCount(task.id, fixture.insiderId)).toBe(2);
      expect(await commentedRowCount(task.id, fixture.outsiderId)).toBe(1);
      // And the row from before the move — legitimate when it was written, and not deletable on
      // that basis — stops being delivered. This is the half a write-side filter cannot reach.
      expect(await inboxKeys(fixture.outsiderEmail)).not.toContain(task.key);
      expect(await inboxKeys(fixture.insiderEmail)).toContain(task.key);
    });

    /**
     * The other path that names one person by hand, and the one place this ticket refuses rather
     * than drops.
     *
     * A mention is dropped silently because a body is somewhere people write freely. A review
     * request is not: it creates a `TaskReviewRequest` row pointing at that person and moves the
     * task to IN_REVIEW. Notifying nobody would leave a task parked in review under a reviewer who
     * was never told and could not open it if they had been — a broken state reported as success.
     *
     * 400 is also what assignment already does one file over: `assertTaskRelations` rejects an
     * assignee who is not on the project's team. Two named-recipient writes, one answer.
     */
    test('a review cannot be requested from somebody who cannot open the task', async () => {
      const task = await createTask('reviewed by someone who could not read it', fixture.projectId);

      const refused = await requestReview(task.key, fixture.outsiderId);

      expect(refused.statusCode).toBe(400);
      expect((refused.json() as { message: string }).message).toContain('read this task');
      // The task did not move to IN_REVIEW behind the refusal, and no row was written for them.
      expect(await prisma.taskReviewRequest.count({ where: { taskId: task.id } })).toBe(0);
      expect(await reviewRowCount(task.id, fixture.outsiderId)).toBe(0);

      const accepted = await requestReview(task.key, fixture.insiderId);
      expect(accepted.statusCode).toBe(201);
      expect(await reviewRowCount(task.id, fixture.insiderId)).toBe(1);
    });

    test('a review cannot be reassigned to somebody who cannot open the task', async () => {
      const task = await createTask('handed to a stranger', fixture.projectId);
      const created = await requestReview(task.key, fixture.insiderId);
      expect(created.statusCode).toBe(201);
      const reviewId = (created.json() as { id: string }).id;

      const refused = await app.inject({
        method: 'PATCH',
        url: `/reviews/${reviewId}/reassign`,
        headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
        payload: { reviewerId: fixture.outsiderId }
      });

      expect(refused.statusCode).toBe(400);
      expect(await reviewRowCount(task.id, fixture.outsiderId)).toBe(0);
    });

    /**
     * The decision half of a review, which does not go through the fan-out: it addresses the
     * requester and the assignee by name. Both were in reach when they took those roles, and a move
     * between the request and the decision is enough to make one of them a stranger.
     */
    test('a review decision does not report back to a requester the task moved away from', async () => {
      const task = await createTask('decided after it moved', fixture.openProjectId);
      const created = await app.inject({
        method: 'POST',
        url: `/tasks/${task.key}/reviews`,
        headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.outsiderEmail },
        payload: { reviewerId: fixture.insiderId }
      });
      expect(created.statusCode).toBe(201);
      const reviewId = (created.json() as { id: string }).id;

      await moveToProject(task.key, fixture.projectId);
      const approved = await app.inject({
        method: 'POST',
        url: `/reviews/${reviewId}/approve`,
        headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.insiderEmail },
        payload: {}
      });
      expect(approved.statusCode).toBe(200);

      expect(await decidedRowCount(task.id, fixture.outsiderId)).toBe(0);
    });

    test('a review decision does still report back to a requester who can read the task', async () => {
      const task = await createTask('decided while everyone could read it', fixture.openProjectId);
      const created = await app.inject({
        method: 'POST',
        url: `/tasks/${task.key}/reviews`,
        headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.outsiderEmail },
        payload: { reviewerId: fixture.insiderId }
      });
      expect(created.statusCode).toBe(201);
      const reviewId = (created.json() as { id: string }).id;

      const approved = await app.inject({
        method: 'POST',
        url: `/reviews/${reviewId}/approve`,
        headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.insiderEmail },
        payload: {}
      });
      expect(approved.statusCode).toBe(200);

      expect(await decidedRowCount(task.id, fixture.outsiderId)).toBe(1);
    });

    test('a status change on a walled-off task writes nothing to a stale subscriber', async () => {
      const task = await createTask('moved, then progressed', fixture.openProjectId);
      await subscribe(task.key, fixture.outsiderEmail);
      await subscribe(task.key, fixture.insiderEmail);
      await moveToProject(task.key, fixture.projectId);

      await patch(task.key, { status: 'IN_PROGRESS' });

      expect(await statusRowCount(task.id, fixture.outsiderId)).toBe(0);
      expect(await statusRowCount(task.id, fixture.insiderId)).toBe(1);
    });

    /**
     * The blocker row, pinned separately from the other three that share its code path — because
     * it is the only one whose **body** names a second task, key and title, on top of the one in
     * its title. A stale subscriber getting this one would learn about two.
     *
     * (What the blocker's own reachability implies is a different surface: `GET /tasks/:idOrKey`
     * already returns `blockingDependencies` with the whole far-end task and no access filter on
     * it, so anybody who can read the blocked task can already read the blocker's key and title
     * there. That is a dependency-read question, not a notification one.)
     */
    test('a blocker on a walled-off task names neither task to a stale subscriber', async () => {
      const task = await createTask('moved, then blocked', fixture.openProjectId);
      await subscribe(task.key, fixture.outsiderEmail);
      await subscribe(task.key, fixture.insiderEmail);
      await moveToProject(task.key, fixture.projectId);
      const blocker = await createTask('the thing in the way', fixture.projectId);

      const linked = await app.inject({
        method: 'POST',
        url: `/tasks/${task.key}/dependencies`,
        headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
        payload: { blockedBy: blocker.key }
      });
      expect(linked.statusCode).toBe(201);

      expect(await blockedRowCount(task.id, fixture.outsiderId)).toBe(0);
      expect(await blockedRowCount(task.id, fixture.insiderId)).toBe(1);
    });

    /**
     * Assignment, which this ticket found already correct and pins rather than changes.
     *
     * `assertTaskRelations` has always refused an assignee who is not on the project's team, so the
     * `task_assigned` row could never name a task its recipient could not open. That rule is
     * stricter than read access — a project member who is not on the team can read the work and
     * still cannot be assigned it — and it is a rule about who may hold work rather than about
     * disclosure, which is why it was not folded into this ticket's helper. Pinned here so the
     * notification property does not quietly depend on a check that could be relaxed for unrelated
     * reasons.
     */
    test('assignment already refuses somebody who cannot open the task', async () => {
      const task = await createTask('assigned across a wall', fixture.projectId);

      const refused = await app.inject({
        method: 'PATCH',
        url: `/tasks/${task.key}`,
        headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
        payload: { assigneeId: fixture.outsiderId }
      });

      expect(refused.statusCode).toBe(400);
      expect(await prisma.notification.count({
        where: { taskId: task.id, userId: fixture.outsiderId, type: 'task_assigned' }
      })).toBe(0);

      await patch(task.key, { assigneeId: fixture.insiderId });
      expect(await prisma.notification.count({
        where: { taskId: task.id, userId: fixture.insiderId, type: 'task_assigned' }
      })).toBe(1);
    });
  });

  /**
   * The other half, and the reason this ticket is not just a filter.
   *
   * Team membership is only one of the four ways `canReadProject` lets somebody in. A fix that
   * checked it and nothing else would quietly stop notifying a workspace admin, a project lead and
   * an explicit project member about work they can open every day — a regression that shows up as
   * "the inbox went quiet" weeks later and reads like nothing to do with access. One test per way
   * in, so which one broke is legible from the failure.
   */
  describe('and still reaches everybody who can read the work', () => {
    test('a workspace admin, who is on no team at all', async () => {
      const task = await createTaskAs(fixture.insiderEmail, 'named by somebody on the team', fixture.projectId, {
        description: mentionBody([fixture.ownerId])
      });

      expect(await mentionRowCount(task.id, fixture.ownerId)).toBe(1);
    });

    test('the lead of the project, without being on its team', async () => {
      const task = await createTask('named on work they lead', fixture.ledProjectId, {
        description: mentionBody([fixture.outsiderId])
      });

      expect(await mentionRowCount(task.id, fixture.outsiderId)).toBe(1);
    });

    test('an explicit project member, without being on its team', async () => {
      const task = await createTask('named on a project they joined', fixture.memberProjectId, {
        description: mentionBody([fixture.outsiderId])
      });

      expect(await mentionRowCount(task.id, fixture.outsiderId)).toBe(1);
    });
  });
});

async function subscribe(idOrKey: string, email: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${idOrKey}/subscription`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: {}
  });
  expect(response.statusCode).toBe(200);
}

async function patch(idOrKey: string, body: Record<string, unknown>): Promise<void> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/tasks/${idOrKey}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: body
  });
  expect(response.statusCode).toBe(200);
}

/** The move itself, asserted to have happened — a silently rejected PATCH would fake every result. */
async function moveToProject(idOrKey: string, projectId: string): Promise<void> {
  await patch(idOrKey, { projectId });
  const moved = await prisma.task.findFirstOrThrow({ where: { key: idOrKey }, select: { projectId: true } });
  expect(moved.projectId).toBe(projectId);
}

function commentedRowCount(taskId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { taskId, userId, type: 'task_commented' } });
}

function statusRowCount(taskId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { taskId, userId, type: 'task_status_changed' } });
}

function blockedRowCount(taskId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { taskId, userId, type: 'task_blocked' } });
}

function decidedRowCount(taskId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { taskId, userId, type: 'task_review_decided' } });
}

function reviewRowCount(taskId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { taskId, userId, type: 'task_review_requested' } });
}

function requestReview(idOrKey: string, reviewerId: string) {
  return app.inject({
    method: 'POST',
    url: `/tasks/${idOrKey}/reviews`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { reviewerId }
  });
}

async function comment(idOrKey: string, body: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${idOrKey}/comments`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { body }
  });
  expect(response.statusCode).toBe(201);
}

function mentionRowCount(taskId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { taskId, userId, type: 'task_mentioned' } });
}

/**
 * A body carrying `@`-mentions, in the editor's serialized form.
 *
 * Lexical JSON rather than markdown because `extractTaskMentionUserIds` bails unless the body starts
 * with `{` — a markdown `@name` mentions nobody, and a test written that way would assert zero rows
 * for a reason that has nothing to do with access.
 */
function mentionBody(userIds: string[]): string {
  return JSON.stringify({
    root: {
      type: 'root',
      children: [{
        type: 'paragraph',
        children: userIds.map((userId) => ({
          type: 'mention', version: 1, text: '@Someone', mentionUserId: userId
        }))
      }]
    }
  });
}

async function inboxKeys(email: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/notifications?limit=100',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { items: Array<{ task: { key: string } | null }> };
  return body.items.map((item) => item.task?.key).filter((key): key is string => Boolean(key));
}

async function syncKeys(email: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/notifications/sync?limit=100',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { items: Array<{ task: { key: string } | null }> };
  return body.items.map((item) => item.task?.key).filter((key): key is string => Boolean(key));
}

async function unreadBadge(email: string): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { unreadNotifications: number }).unreadNotifications;
}

function markRead(id: string, email: string) {
  return app.inject({
    method: 'PATCH',
    url: `/notifications/${id}/read`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
}

/**
 * A row put straight into the table, standing in for one written before the gate existed.
 *
 * Shaped exactly like the real thing — the title is what every task-scoped write site produces —
 * because the title *is* the disclosure this ticket is about.
 */
function seedNotification(task: { id: string; key: string; title: string }, userId: string) {
  return prisma.notification.create({
    data: {
      workspaceId: fixture.workspaceId,
      userId,
      actorId: fixture.ownerId,
      actorType: 'USER',
      taskId: task.id,
      type: 'task_mentioned',
      title: `${task.key}: ${task.title}`,
      body: 'seeded before the gate existed'
    },
    select: { id: true }
  });
}

function createTask(
  title: string,
  projectId: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; key: string; title: string }> {
  return createTaskAs(fixture.ownerEmail, title, projectId, extra);
}

/** Filed by somebody other than the owner, for the cases where the owner is the one being named. */
async function createTaskAs(
  email: string,
  title: string,
  projectId: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; key: string; title: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: { projectId, title, ...extra }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string; title: string };
  return { id: body.id, key: body.key, title: body.title };
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `na-owner-${suffix}@example.test`;
  const insiderEmail = `na-insider-${suffix}@example.test`;
  const outsiderEmail = `na-outsider-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Owner' } });
  const insider = await prisma.user.create({ data: { email: insiderEmail, name: 'Insider' } });
  const outsider = await prisma.user.create({ data: { email: outsiderEmail, name: 'Outsider' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Notification access workspace', slug: `na-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: insider.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: outsider.id, role: 'MEMBER' }
    ]
  });

  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Near', slug: `near-${suffix}` }
  });
  const farTeam = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Far', slug: `far-${suffix}` }
  });
  await prisma.teamMember.create({
    data: { teamId: team.id, userId: insider.id, role: 'MEMBER' }
  });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: team.id, name: 'Near work', keyPrefix: `NR${prefix}` }
  });
  const farProject = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: farTeam.id, name: 'Far work', keyPrefix: `FR${prefix}` }
  });
  const ledProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: farTeam.id,
      leadId: outsider.id,
      name: 'Led work',
      keyPrefix: `LD${prefix}`
    }
  });
  const memberProject = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: farTeam.id, name: 'Member work', keyPrefix: `MB${prefix}` }
  });
  await prisma.projectMember.create({
    data: { projectId: memberProject.id, userId: outsider.id, role: 'MEMBER' }
  });
  const openProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Open work', keyPrefix: `OP${prefix}` }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    ownerId: owner.id,
    insiderEmail,
    insiderId: insider.id,
    outsiderEmail,
    outsiderId: outsider.id,
    projectId: project.id,
    farProjectId: farProject.id,
    ledProjectId: ledProject.id,
    memberProjectId: memberProject.id,
    openProjectId: openProject.id
  };
}
