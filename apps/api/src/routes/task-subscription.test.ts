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
      where: { email: { in: [fixture.reporterEmail, fixture.watcherEmail] } }
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

    const response = await unsubscribe(task.key, fixture.watcherEmail);

    expect(response.statusCode).toBe(204);
    expect(await subscriptionCount(task.id)).toBe(0);

    await comment(task.key, fixture.reporterEmail, 'something the watcher no longer cares about');
    expect(await notificationCount(task.id, 'task_commented')).toBe(1);
  });

  test('the next assignment does not re-subscribe somebody who unsubscribed', async () => {
    const task = await createTask('handed back and forth', { assigneeId: fixture.watcherId });
    expect((await unsubscribe(task.key, fixture.watcherEmail)).statusCode).toBe(204);

    // Away and back again, so this is unambiguously "the next time they are assigned" and not one
    // PATCH that happened to restate the assignee it already had.
    await patch(task.key, { assigneeId: fixture.reporterId });
    await patch(task.key, { assigneeId: fixture.watcherId });

    expect(await subscriptionCount(task.id)).toBe(0);
    await comment(task.key, fixture.reporterEmail, 'and still they hear nothing');
    expect(await notificationCount(task.id, 'task_commented')).toBe(0);
  });
});

function unsubscribe(idOrKey: string, email: string) {
  return app.inject({
    method: 'DELETE',
    url: `/tasks/${idOrKey}/subscription`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
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
  const reporter = await prisma.user.create({ data: { email: reporterEmail, name: 'Reporter' } });
  const watcher = await prisma.user.create({ data: { email: watcherEmail, name: 'Watcher' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Subscription workspace', slug: `sub-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: reporter.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: watcher.id, role: 'MEMBER' }
    ]
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Subs', keyPrefix: `SB${suffix.slice(0, 3).toUpperCase()}` }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    reporterEmail,
    reporterId: reporter.id,
    watcherEmail,
    watcherId: watcher.id,
    projectId: project.id
  };
}
