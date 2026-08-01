import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { hasNoOpenBlockerWhere, openBlockerEdgeWhere } from '../services/blockers';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];

const EMAIL_DOMAIN = 'task-dependencies.test';

/**
 * A dependency edge is the one write in Taskara that used to be irreversible. There was no DELETE,
 * and the only cycle refused was a task blocking itself — so `A blocks B blocks A` was accepted and
 * then unremovable except by deleting a task and losing its comments, history and key.
 *
 * These tests are written against the two halves of that together, because either alone is a
 * half-measure: a cycle check with no DELETE still strands whatever slipped through before it
 * existed, and a DELETE with no cycle check invites the mess it then has to clean up.
 */
describe('dependency edges can be removed', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await app.close();
  });

  test('an edge added by mistake is removed, and the blocked task reopens', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Work that got a wrong blocker');
    const blocker = await seedTask(fixture, 'Not actually a blocker');

    const added = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${blocked.key}/dependencies`,
      payload: { blockedBy: blocker.key }
    });
    expect(added.statusCode).toBe(201);
    expect(await openBlockerCount(blocked.id)).toBe(1);

    const removed = await injectAs(fixture, 'member', {
      method: 'DELETE',
      url: `/tasks/${blocked.key}/dependencies/${blocker.key}`
    });

    expect(removed.statusCode).toBe(204);
    expect(await openBlockerCount(blocked.id)).toBe(0);
    expect(await isOnFrontier(fixture, blocked.id)).toBe(true);
  });

  // The point of a DELETE route at all: the old workaround was to delete a task, which took its
  // comments and its key with it. Removing the edge must leave both endpoints entirely intact.
  test('removing an edge destroys neither task, and keeps their comments and keys', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Blocked but commented on');
    const blocker = await seedTask(fixture, 'Blocker with a history');
    await prisma.taskComment.create({
      data: { taskId: blocked.id, authorId: fixture.member.id, body: 'Context worth keeping' }
    });

    await addDependency(fixture, blocked.key, blocker.key);
    const removed = await injectAs(fixture, 'member', {
      method: 'DELETE',
      url: `/tasks/${blocked.key}/dependencies/${blocker.key}`
    });

    expect(removed.statusCode).toBe(204);
    const survivors = await prisma.task.findMany({
      where: { id: { in: [blocked.id, blocker.id] } },
      select: { id: true, key: true, _count: { select: { comments: true } } },
      orderBy: { key: 'asc' }
    });
    expect(survivors).toHaveLength(2);
    expect(survivors.find((task) => task.id === blocked.id)?._count.comments).toBe(1);
    expect(survivors.find((task) => task.id === blocked.id)?.key).toBe(blocked.key);
  });

  // The fault this ticket exists for, reproduced from the wrong side: rows written before the cycle
  // check existed are already in the database. A refusal on new writes does nothing for them, so
  // the recovery path has to work on a graph the route would now refuse to create.
  test('a cycle planted directly in the database is repairable over HTTP', async () => {
    const fixture = await createFixture();
    const first = await seedTask(fixture, 'First of a planted cycle');
    const second = await seedTask(fixture, 'Second of a planted cycle');
    await prisma.taskDependency.createMany({
      data: [
        { taskId: first.id, blockedByTaskId: second.id },
        { taskId: second.id, blockedByTaskId: first.id }
      ]
    });
    expect(await isOnFrontier(fixture, first.id)).toBe(false);
    expect(await isOnFrontier(fixture, second.id)).toBe(false);

    const removed = await injectAs(fixture, 'member', {
      method: 'DELETE',
      url: `/tasks/${first.key}/dependencies/${second.key}`
    });

    expect(removed.statusCode).toBe(204);
    expect(await isOnFrontier(fixture, first.id)).toBe(true);
  });

  test('removing an edge that is not there is a 404, not a silent success', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Never blocked');
    const other = await seedTask(fixture, 'Never a blocker');

    const response = await injectAs(fixture, 'member', {
      method: 'DELETE',
      url: `/tasks/${blocked.key}/dependencies/${other.key}`
    });

    expect(response.statusCode).toBe(404);
  });

  test('an edge is only removable through the task that carries it, not its blocker', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'The blocked end');
    const blocker = await seedTask(fixture, 'The blocking end');
    await addDependency(fixture, blocked.key, blocker.key);

    // Same pair, stated backwards. The edge is directed, so this names an edge that does not exist.
    const response = await injectAs(fixture, 'member', {
      method: 'DELETE',
      url: `/tasks/${blocker.key}/dependencies/${blocked.key}`
    });

    expect(response.statusCode).toBe(404);
    expect(await openBlockerCount(blocked.id)).toBe(1);
  });

  test('a task in another workspace is not a removable blocker', async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    const blocked = await seedTask(fixture, 'Local task');
    const foreign = await seedTask(other, 'Foreign task');

    const response = await injectAs(fixture, 'member', {
      method: 'DELETE',
      url: `/tasks/${blocked.key}/dependencies/${foreign.id}`
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('dependency edges cannot form a cycle', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await app.close();
  });

  test('a task still cannot block itself', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Self-blocking candidate');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${task.key}/dependencies`,
      payload: { blockedBy: task.key }
    });

    expect(response.statusCode).toBe(400);
  });

  test('the two-task cycle the old route accepted is refused', async () => {
    const fixture = await createFixture();
    const a = await seedTask(fixture, 'A');
    const b = await seedTask(fixture, 'B');
    await addDependency(fixture, a.key, b.key);

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${b.key}/dependencies`,
      payload: { blockedBy: a.key }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/cycle/i);
    // The refusal must not be a partial write: B stays takeable.
    expect(await prisma.taskDependency.count({ where: { taskId: b.id } })).toBe(0);
    expect(await isOnFrontier(fixture, b.id)).toBe(true);
  });

  test('a cycle closed through four tasks is refused too', async () => {
    const fixture = await createFixture();
    const a = await seedTask(fixture, 'A of a long chain');
    const b = await seedTask(fixture, 'B of a long chain');
    const c = await seedTask(fixture, 'C of a long chain');
    const d = await seedTask(fixture, 'D of a long chain');
    // a <- b <- c <- d: d must finish first, then c, then b, then a.
    await addDependency(fixture, a.key, b.key);
    await addDependency(fixture, b.key, c.key);
    await addDependency(fixture, c.key, d.key);

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${d.key}/dependencies`,
      payload: { blockedBy: a.key }
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.taskDependency.count({ where: { taskId: d.id } })).toBe(0);
  });

  // A cycle check that refuses any already-seen node would also refuse this, and a diamond is a
  // perfectly ordinary shape: two independent blockers that share a prerequisite.
  test('a diamond is not a cycle and is accepted', async () => {
    const fixture = await createFixture();
    const top = await seedTask(fixture, 'Top of the diamond');
    const left = await seedTask(fixture, 'Left arm');
    const right = await seedTask(fixture, 'Right arm');
    const bottom = await seedTask(fixture, 'Shared prerequisite');

    await addDependency(fixture, top.key, left.key);
    await addDependency(fixture, top.key, right.key);
    await addDependency(fixture, left.key, bottom.key);
    const last = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${right.key}/dependencies`,
      payload: { blockedBy: bottom.key }
    });

    expect(last.statusCode).toBe(201);
    expect(await openBlockerCount(top.id)).toBe(2);
  });

  // The check has to survive the data the missing check already produced, without hanging.
  test('an existing cycle does not hang the check for a new edge', async () => {
    const fixture = await createFixture();
    const a = await seedTask(fixture, 'A in an existing cycle');
    const b = await seedTask(fixture, 'B in an existing cycle');
    const outsider = await seedTask(fixture, 'Outsider');
    await prisma.taskDependency.createMany({
      data: [
        { taskId: a.id, blockedByTaskId: b.id },
        { taskId: b.id, blockedByTaskId: a.id }
      ]
    });

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${outsider.key}/dependencies`,
      payload: { blockedBy: a.key }
    });

    expect(response.statusCode).toBe(201);
  });

  test('re-adding an edge that already exists stays idempotent', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Blocked once');
    const blocker = await seedTask(fixture, 'Blocker');
    await addDependency(fixture, blocked.key, blocker.key);

    const again = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${blocked.key}/dependencies`,
      payload: { blockedBy: blocker.key }
    });

    expect(again.statusCode).toBe(201);
    expect(await prisma.taskDependency.count({ where: { taskId: blocked.id } })).toBe(1);
  });
});

describe('the parent link cannot form a cycle either', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await app.close();
  });

  test('a task still cannot be its own parent', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Self-parenting candidate');

    const response = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${task.key}`,
      payload: { parentId: task.id }
    });

    expect(response.statusCode).toBe(400);
  });

  test('a task cannot be reparented under its own child', async () => {
    const fixture = await createFixture();
    const parent = await seedTask(fixture, 'Parent');
    const child = await seedTask(fixture, 'Child');
    await prisma.task.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const response = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${parent.key}`,
      payload: { parentId: child.id }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/descendant|cycle/i);
    const unchanged = await prisma.task.findUniqueOrThrow({ where: { id: parent.id }, select: { parentId: true } });
    expect(unchanged.parentId).toBeNull();
  });

  test('a task cannot be reparented under a grandchild either', async () => {
    const fixture = await createFixture();
    const grandparent = await seedTask(fixture, 'Grandparent');
    const parent = await seedTask(fixture, 'Middle');
    const child = await seedTask(fixture, 'Leaf');
    await prisma.task.update({ where: { id: parent.id }, data: { parentId: grandparent.id } });
    await prisma.task.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const response = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${grandparent.key}`,
      payload: { parentId: child.id }
    });

    expect(response.statusCode).toBe(400);
  });

  test('an ordinary reparent under an unrelated task still works', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Movable');
    const newParent = await seedTask(fixture, 'Unrelated parent');

    const response = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${task.key}`,
      payload: { parentId: newParent.id }
    });

    expect(response.statusCode).toBe(200);
    const moved = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, select: { parentId: true } });
    expect(moved.parentId).toBe(newParent.id);
  });

  // An ancestor chain that is already a cycle must not spin the walk forever.
  test('a parent chain that is already a cycle is refused rather than hanging', async () => {
    const fixture = await createFixture();
    const a = await seedTask(fixture, 'A of a parent cycle');
    const b = await seedTask(fixture, 'B of a parent cycle');
    const mover = await seedTask(fixture, 'Task looking for a parent');
    await prisma.task.update({ where: { id: a.id }, data: { parentId: b.id } });
    await prisma.$executeRawUnsafe(
      'UPDATE "Task" SET "parentId" = $1::uuid WHERE "id" = $2::uuid',
      a.id,
      b.id
    );

    const response = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${mover.key}`,
      payload: { parentId: a.id }
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('a blocker that is finished does not block', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await app.close();
  });

  test('the open-blocker count drops when the blocker is DONE and returns when it reopens', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Waiting on one thing');
    const blocker = await seedTask(fixture, 'The one thing');
    await addDependency(fixture, blocked.key, blocker.key);
    expect(await taskCountFromApi(fixture, blocked.key)).toBe(1);

    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'DONE' } });
    expect(await taskCountFromApi(fixture, blocked.key)).toBe(0);
    expect(await isOnFrontier(fixture, blocked.id)).toBe(true);

    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'TODO' } });
    expect(await taskCountFromApi(fixture, blocked.key)).toBe(1);
    expect(await isOnFrontier(fixture, blocked.id)).toBe(false);
  });

  test('a CANCELED blocker does not block, because it will never be done', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Waiting on an abandoned thing');
    const blocker = await seedTask(fixture, 'Abandoned');
    await addDependency(fixture, blocked.key, blocker.key);

    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'CANCELED' } });

    expect(await taskCountFromApi(fixture, blocked.key)).toBe(0);
  });

  // The count is the predicate; the edge list is the record. Filtering both would erase the reason
  // a task was ever blocked, which is exactly what someone reading the task's page wants to see.
  test('the finished blocker is still listed on the task it blocked', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Was blocked');
    const blocker = await seedTask(fixture, 'Now finished');
    await addDependency(fixture, blocked.key, blocker.key);
    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'DONE' } });

    const response = await injectAs(fixture, 'member', { method: 'GET', url: `/tasks/${blocked.key}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body._count.blockingDependencies).toBe(0);
    expect(body.blockingDependencies).toHaveLength(1);
    expect(body.blockingDependencies[0].blockedByTask.id).toBe(blocker.id);
  });

  // Three includes carry `_count.blockingDependencies` into the sync stream — the task one, the
  // attachment one and the milestone one. Filtering only the first would work until the next
  // attachment or milestone edit re-broadcast the raw number and put the badge back.
  test('an attachment write broadcasts the open count, not every edge ever drawn', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Blocked once, now finished');
    const blocker = await seedTask(fixture, 'Finished blocker');
    await addDependency(fixture, blocked.key, blocker.key);
    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'DONE' } });

    const attached = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${blocked.key}/attachments`,
      payload: { object: 'note.png', name: 'note.png', mimeType: 'image/png' }
    });

    expect(attached.statusCode).toBe(201);
    const synced = await latestSyncedTask(fixture, blocked.id);
    expect((synced._count as { blockingDependencies: number }).blockingDependencies).toBe(0);
  });

  test('a milestone disposition broadcasts the open count too', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'In a milestone, once blocked');
    const blocker = await seedTask(fixture, 'Finished blocker');
    await addDependency(fixture, blocked.key, blocker.key);
    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'DONE' } });

    // Milestone planning is a project-lead capability; the fixture's member is an ordinary one.
    await prisma.project.update({ where: { id: fixture.project.id }, data: { leadId: fixture.member.id } });
    const milestone = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/milestones',
      payload: { projectId: fixture.project.id, name: 'Dependency milestone', kind: 'FEATURE' }
    });
    expect(milestone.statusCode).toBe(201);
    const milestoneId = milestone.json().id as string;
    await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${blocked.key}`,
      payload: { milestoneId }
    });

    // Cancelling with UNASSIGN rewrites every unfinished task in the milestone and emits a task
    // event for each — through the milestone include, not the task one.
    const canceled = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${milestoneId}/cancel`,
      payload: { unfinishedTaskPolicy: 'UNASSIGN' }
    });

    expect(canceled.statusCode).toBe(200);
    const synced = await latestSyncedTask(fixture, blocked.id);
    expect((synced._count as { blockingDependencies: number }).blockingDependencies).toBe(0);
  });

  test('a blocker in any open status still blocks', async () => {
    const fixture = await createFixture();
    for (const status of ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] as const) {
      const fresh = await createFixture();
      const blocked = await seedTask(fresh, `Blocked by a ${status} task`);
      const blocker = await seedTask(fresh, `A ${status} blocker`, { status });
      await addDependency(fresh, blocked.key, blocker.key);
      expect(await openBlockerCount(blocked.id)).toBe(1);
    }
    expect(fixture.workspace.id).toBeTruthy();
  });

  // The live bug named in the ticket: the daily plan reports work as blocked forever.
  test('the daily plan puts a task whose only blocker is DONE in focus, not blocked', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Actually takeable', { assigneeId: fixture.member.id });
    const blocker = await seedTask(fixture, 'Finished prerequisite');
    await addDependency(fixture, task.key, blocker.key);
    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'DONE' } });

    const response = await injectAs(fixture, 'member', { method: 'POST', url: '/agent/daily-plan' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.blocked.map((row: { id: string }) => row.id)).not.toContain(task.id);
    expect(body.focus.map((row: { id: string }) => row.id)).toContain(task.id);
  });

  test('the daily plan still reports a task whose blocker is open', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Genuinely blocked', { assigneeId: fixture.member.id });
    const blocker = await seedTask(fixture, 'Unfinished prerequisite');
    await addDependency(fixture, task.key, blocker.key);

    const response = await injectAs(fixture, 'member', { method: 'POST', url: '/agent/daily-plan' });

    const body = response.json();
    expect(body.blocked.map((row: { id: string }) => row.id)).toContain(task.id);
    expect(body.focus.map((row: { id: string }) => row.id)).not.toContain(task.id);
  });

  // The same predicate, written out a third time, in the daily report draft a human is shown.
  test('the daily report draft does not offer a finished blocker as a blocker', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Draft candidate', { assigneeId: fixture.member.id });
    const blocker = await seedTask(fixture, 'Draft blocker');
    await addDependency(fixture, task.key, blocker.key);
    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocker.key}`, payload: { status: 'DONE' } });

    const response = await injectAs(fixture, 'member', { method: 'GET', url: '/check-ins/draft' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.blockedTasks.map((row: { taskId: string }) => row.taskId)).not.toContain(task.id);
    expect(body.planCandidates.map((row: { taskId: string }) => row.taskId)).toContain(task.id);
  });
});

describe('the dependency request body is validated', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await app.close();
  });

  test('an empty object is a 400, not a 500 with a leaked TypeError', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Target of a bad request');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${task.key}/dependencies`,
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('Validation failed');
  });

  test('a non-string blockedBy is a 400', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Target of a typed-wrong request');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${task.key}/dependencies`,
      payload: { blockedBy: 42 }
    });

    expect(response.statusCode).toBe(400);
  });

  test('a blank blockedBy is a 400 rather than a lookup for the empty string', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Target of a blank request');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${task.key}/dependencies`,
      payload: { blockedBy: '   ' }
    });

    expect(response.statusCode).toBe(400);
  });

  test('a missing body is a 400', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Target of an empty request');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${task.key}/dependencies`
    });

    expect(response.statusCode).toBe(400);
  });

  test('an unknown blocker is still a 404', async () => {
    const fixture = await createFixture();
    const task = await seedTask(fixture, 'Target of an unknown blocker');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${task.key}/dependencies`,
      payload: { blockedBy: 'NOPE-9999' }
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('a dependency write tells the rest of the system', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await app.close();
  });

  test('adding an edge writes an activity log entry, a sync event and a notification', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Newly blocked');
    const blocker = await seedTask(fixture, 'The new blocker');
    await prisma.taskSubscription.create({
      data: { workspaceId: fixture.workspace.id, taskId: blocked.id, userId: fixture.watcher.id }
    });

    await addDependency(fixture, blocked.key, blocker.key);

    const activity = await prisma.activityLog.findMany({
      where: { workspaceId: fixture.workspace.id, entityId: blocked.id, action: 'dependency_added' }
    });
    expect(activity).toHaveLength(1);

    const events = await prisma.syncEvent.findMany({
      where: { workspaceId: fixture.workspace.id, entityType: 'task', entityId: blocked.id }
    });
    expect(events.length).toBeGreaterThan(0);
    const payload = events.at(-1)?.payload as { after?: { _count?: { blockingDependencies?: number } } };
    expect(payload.after?._count?.blockingDependencies).toBe(1);

    const notifications = await prisma.notification.findMany({
      where: { workspaceId: fixture.workspace.id, taskId: blocked.id, userId: fixture.watcher.id }
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('task_blocked');
  });

  test('the actor is not notified about their own edge', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Blocked by its own watcher');
    const blocker = await seedTask(fixture, 'A blocker');
    await prisma.taskSubscription.create({
      data: { workspaceId: fixture.workspace.id, taskId: blocked.id, userId: fixture.member.id }
    });

    await addDependency(fixture, blocked.key, blocker.key);

    expect(await prisma.notification.count({
      where: { workspaceId: fixture.workspace.id, taskId: blocked.id, userId: fixture.member.id }
    })).toBe(0);
  });

  test('removing an edge writes an activity log entry and a sync event carrying the reopened count', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'About to be unblocked');
    const blocker = await seedTask(fixture, 'About to stop blocking');
    await addDependency(fixture, blocked.key, blocker.key);

    await injectAs(fixture, 'member', {
      method: 'DELETE',
      url: `/tasks/${blocked.key}/dependencies/${blocker.key}`
    });

    const activity = await prisma.activityLog.findMany({
      where: { workspaceId: fixture.workspace.id, entityId: blocked.id, action: 'dependency_removed' }
    });
    expect(activity).toHaveLength(1);

    const events = await prisma.syncEvent.findMany({
      where: { workspaceId: fixture.workspace.id, entityType: 'task', entityId: blocked.id },
      orderBy: { workspaceSeq: 'asc' }
    });
    const payload = events.at(-1)?.payload as { after?: { _count?: { blockingDependencies?: number } } };
    expect(payload.after?._count?.blockingDependencies).toBe(0);
  });

  // The sync stream derives progressStartedAt from the status *transition* and reads a missing
  // `before` as a fresh start. An edge write that omitted it would restart the progress clock on
  // every in-progress task that gained a blocker — a wrong number in the person sheet and on the
  // graph, produced by a write that did not touch the task at all.
  test('the emitted event does not restart the progress clock of an in-progress task', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Already underway');
    const blocker = await seedTask(fixture, 'A late-arriving blocker');

    // Positive control: a real transition into IN_PROGRESS does stamp the clock, so a test that
    // saw no stamp because the field had been dropped from the stream entirely cannot pass.
    await injectAs(fixture, 'member', { method: 'PATCH', url: `/tasks/${blocked.key}`, payload: { status: 'IN_PROGRESS' } });
    expect(await latestSyncedTask(fixture, blocked.id)).toHaveProperty('progressStartedAt', expect.any(String));

    await addDependency(fixture, blocked.key, blocker.key);

    // Nothing about the task's progress changed, so the event must carry no stamp of its own and
    // leave whatever the client already had in place.
    expect((await latestSyncedTask(fixture, blocked.id)).progressStartedAt).toBeUndefined();
  });

  // A dependency edge is not a column on the task row, so bumping the row's version would make an
  // unrelated in-flight edit fail its optimistic-concurrency check for no reason.
  test('a dependency write does not bump the task version', async () => {
    const fixture = await createFixture();
    const blocked = await seedTask(fixture, 'Version-stable');
    const blocker = await seedTask(fixture, 'Blocker');
    const before = await prisma.task.findUniqueOrThrow({ where: { id: blocked.id }, select: { version: true } });

    await addDependency(fixture, blocked.key, blocker.key);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: blocked.id }, select: { version: true } });
    expect(after.version).toBe(before.version);
  });
});

type Persona = 'member' | 'watcher';

interface Fixture {
  workspace: { id: string; slug: string };
  project: { id: string; keyPrefix: string };
  member: { id: string; email: string };
  watcher: { id: string; email: string };
  nextSequence: () => number;
}

async function cleanup(): Promise<void> {
  while (cleanupWorkspaceIds.length) {
    const workspaceId = cleanupWorkspaceIds.pop();
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
}

/**
 * Issue #51 — an Effort is a map, not work. An edge touching one would put it in a human's
 * dependencies list and count it toward their open-blocker total, which is the failure `kind`
 * exists to prevent.
 */
describe('a blocking edge cannot touch an effort', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(cleanup);
  afterAll(async () => {
    await app.close();
  });

  test('refuses an effort as the blocker, naming it', async () => {
    const fixture = await createFixture();
    const work = await seedTask(fixture, 'Real work');
    const effort = await seedEffort(fixture, 'A map');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${work.key}/dependencies`,
      payload: { blockedBy: effort.key }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain(effort.key);
    expect(response.json().message).toContain('effort');
    expect(await prisma.taskDependency.count({ where: { taskId: work.id } })).toBe(0);
  });

  test('refuses an effort as the blocked task too, because the edge is wrong in both directions', async () => {
    const fixture = await createFixture();
    const work = await seedTask(fixture, 'Real work');
    const effort = await seedEffort(fixture, 'A map');

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${effort.key}/dependencies`,
      payload: { blockedBy: work.key }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain(effort.key);
  });

  test('an edge that predates the guard is hidden from the read', async () => {
    const fixture = await createFixture();
    const work = await seedTask(fixture, 'Real work');
    const effort = await seedEffort(fixture, 'A map');
    // Written straight to the table: no route creates this any more, which is the point — the
    // filter covers history rather than a path anybody can still take.
    await prisma.taskDependency.create({ data: { taskId: work.id, blockedByTaskId: effort.id } });

    const response = await injectAs(fixture, 'member', { method: 'GET', url: `/tasks/${work.key}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().blockingDependencies).toEqual([]);
    // The count filters on blocker STATUS, not kind, so it still sees the row. Pinned as the known
    // edge of this fix rather than left for somebody to trip over.
    expect(response.json()._count.blockingDependencies).toBe(1);
  });

  test('an ordinary work blocker is still accepted', async () => {
    const fixture = await createFixture();
    const work = await seedTask(fixture, 'Real work');
    const blocker = await seedTask(fixture, 'Its prerequisite');

    await addDependency(fixture, work.key, blocker.key);

    const response = await injectAs(fixture, 'member', { method: 'GET', url: `/tasks/${work.key}` });
    expect(response.json().blockingDependencies).toHaveLength(1);
  });
});

async function seedEffort(fixture: Fixture, title: string): Promise<{ id: string; key: string }> {
  const sequence = fixture.nextSequence();
  return prisma.task.create({
    data: {
      workspaceId: fixture.workspace.id,
      projectId: fixture.project.id,
      sequence,
      key: `${fixture.project.keyPrefix}-${sequence}`,
      title,
      kind: 'EFFORT',
      status: 'IN_PROGRESS',
      reporterId: fixture.member.id
    },
    select: { id: true, key: true }
  });
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Task dependencies ${suffix}`,
      slug: `task-dependencies-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const member = await prisma.user.create({
    data: { email: uniqueEmail('member'), name: 'Member' },
    select: { id: true, email: true }
  });
  const watcher = await prisma.user.create({
    data: { email: uniqueEmail('watcher'), name: 'Watcher' },
    select: { id: true, email: true }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: member.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: watcher.id, role: 'MEMBER' }
    ]
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Dependencies',
      keyPrefix: `TD${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
    },
    select: { id: true, keyPrefix: true }
  });

  let sequence = 0;
  return { workspace, project, member, watcher, nextSequence: () => (sequence += 1) };
}

async function seedTask(
  fixture: Fixture,
  title: string,
  overrides: { status?: 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'BLOCKED' | 'DONE' | 'CANCELED'; assigneeId?: string } = {}
): Promise<{ id: string; key: string }> {
  const sequence = fixture.nextSequence();
  return prisma.task.create({
    data: {
      workspaceId: fixture.workspace.id,
      projectId: fixture.project.id,
      sequence,
      key: `${fixture.project.keyPrefix}-${sequence}`,
      title,
      status: overrides.status ?? 'TODO',
      assigneeId: overrides.assigneeId,
      reporterId: fixture.member.id
    },
    select: { id: true, key: true }
  });
}

async function addDependency(fixture: Fixture, taskKey: string, blockerKey: string): Promise<void> {
  const response = await injectAs(fixture, 'member', {
    method: 'POST',
    url: `/tasks/${taskKey}/dependencies`,
    payload: { blockedBy: blockerKey }
  });
  if (response.statusCode !== 201) {
    throw new Error(`Expected the dependency to be accepted, got ${response.statusCode}: ${response.body}`);
  }
}

/** The predicate in its `_count` form, read straight from the database. */
async function openBlockerCount(taskId: string): Promise<number> {
  const row = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { _count: { select: { blockingDependencies: { where: openBlockerEdgeWhere } } } }
  });
  return row._count.blockingDependencies;
}

/** The same predicate in its `where` form — the shape a frontier query composes. */
async function isOnFrontier(fixture: Fixture, taskId: string): Promise<boolean> {
  const match = await prisma.task.findFirst({
    where: { workspaceId: fixture.workspace.id, id: taskId, ...hasNoOpenBlockerWhere },
    select: { id: true }
  });
  return Boolean(match);
}

/** The most recent form of a task as the sync stream would hand it to a client. */
async function latestSyncedTask(
  fixture: Fixture,
  taskId: string
): Promise<Record<string, unknown> & { progressStartedAt?: string | null }> {
  const response = await injectAs(fixture, 'member', { method: 'GET', url: '/sync/pull?cursor=0' });
  if (response.statusCode !== 200) throw new Error(`Expected a sync pull, got ${response.statusCode}`);
  const events = (response.json().events as Array<{ task?: Record<string, unknown> & { id?: string } }>)
    .filter((event) => event.task?.id === taskId);
  const latest = events.at(-1)?.task;
  if (!latest) throw new Error('Expected the task to appear in the sync stream');
  return latest;
}

async function taskCountFromApi(fixture: Fixture, key: string): Promise<number> {
  const response = await injectAs(fixture, 'member', { method: 'GET', url: `/tasks/${key}` });
  if (response.statusCode !== 200) throw new Error(`Expected the task, got ${response.statusCode}`);
  return response.json()._count.blockingDependencies as number;
}

async function injectAs(fixture: Fixture, persona: Persona, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      'x-workspace-slug': fixture.workspace.slug,
      'x-user-email': fixture[persona].email,
      ...(options.headers || {})
    }
  });
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@${EMAIL_DOMAIN}`.toLowerCase();
}
