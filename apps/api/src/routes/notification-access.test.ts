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
  /** Owns `projectId`. The insider is on it; the outsider is not. */
  teamId: string;
  projectId: string;
  /** A second team, with nobody on it — somewhere a task can be moved out of reach to. */
  farTeamId: string;
  farProjectId: string;
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
  });
});

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

async function createTask(
  title: string,
  projectId: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; key: string; title: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
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
    teamId: team.id,
    projectId: project.id,
    farTeamId: farTeam.id,
    farProjectId: farProject.id,
    openProjectId: openProject.id
  };
}
