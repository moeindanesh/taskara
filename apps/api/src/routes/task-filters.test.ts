import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type Prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * The query surface from issue #21, asserted end to end against the real endpoint.
 *
 * The frontier — an Effort's children that are unfinished, unblocked and unassigned — is deliberately
 * NOT an endpoint of its own. It is this composition:
 *
 *   GET /tasks?parentId=<effort>&status=unfinished&assigneeId=none&blockers=none
 *
 * so every clause has to be independently true, and the last test asserts the composition returns
 * exactly the takeable set in one request. Each filter is also exercised alone, because triage and the
 * web list view consume them separately.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspace: { id: string; slug: string };
  ownerEmail: string;
  effortId: string;
  ids: Record<TaskName, string>;
  keys: Record<TaskName, string>;
}

type TaskName =
  | 'effort'
  | 'takeable'
  | 'takeableAfterBlockerDone'
  | 'assigned'
  | 'blocked'
  | 'openBlocker'
  | 'doneBlocker'
  | 'finished'
  | 'canceled'
  | 'orphan';

describe('GET /tasks frontier filters', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspace.id } });
    await prisma.user.deleteMany({ where: { email: fixture.ownerEmail } });
    await app.close();
  });

  test('parentId lists exactly one task’s children, and parentId=none lists only top-level rows', async () => {
    const children = await list({ parentId: fixture.effortId });
    expect(children).toEqual(childrenOfEffort());

    const topLevel = await list({ parentId: 'none' });
    expect(topLevel).toContain(fixture.keys.orphan);
    expect(topLevel).toContain(fixture.keys.openBlocker);
    for (const child of childrenOfEffort()) expect(topLevel).not.toContain(child);
  });

  test('the children of an effort are ordinary work, so excluding efforts never hides them', async () => {
    const response = await inject({ parentId: fixture.effortId });
    const items = response.json().items as Array<{ key: string; kind: string }>;

    // The frontier lists the children of a map, and the map is the one row human-facing task reads
    // deliberately drop (issue #33). These two only coexist because the parent's kind is not the
    // child's: every row here is WORK, so the exclusion has nothing to catch and the frontier
    // needs no way around it.
    expect(items.map((item) => item.key).sort()).toEqual(childrenOfEffort());
    expect([...new Set(items.map((item) => item.kind))]).toEqual(['WORK']);
  });

  test('assigneeId=none selects the unassigned, and an id still selects one person’s work', async () => {
    const unassigned = await list({ parentId: fixture.effortId, assigneeId: 'none' });
    expect(unassigned).not.toContain(fixture.keys.assigned);
    expect(unassigned).toContain(fixture.keys.takeable);

    const owner = await prisma.user.findUniqueOrThrow({ where: { email: fixture.ownerEmail } });
    expect(await list({ parentId: fixture.effortId, assigneeId: owner.id })).toEqual([fixture.keys.assigned]);
  });

  test('status takes one status, a list, or the derived value unfinished', async () => {
    expect(await list({ parentId: fixture.effortId, status: 'DONE' })).toEqual([fixture.keys.finished]);

    expect(await list({ parentId: fixture.effortId, status: 'DONE,CANCELED' }))
      .toEqual([fixture.keys.canceled, fixture.keys.finished].sort());

    const unfinished = await list({ parentId: fixture.effortId, status: 'unfinished' });
    expect(unfinished).not.toContain(fixture.keys.finished);
    expect(unfinished).not.toContain(fixture.keys.canceled);
    expect(unfinished).toContain(fixture.keys.takeable);
  });

  test('an unknown status, and unfinished mixed with a real status, are rejected as 400', async () => {
    expect((await inject({ status: 'OPEN' })).statusCode).toBe(400);
    expect((await inject({ status: 'unfinished,DONE' })).statusCode).toBe(400);
  });

  test('label selects one label’s bucket and label=none selects the unlabelled one', async () => {
    expect(await list({ parentId: fixture.effortId, label: 'wayfinder:task' }))
      .toEqual([fixture.keys.takeable]);

    const unlabelled = await list({ parentId: fixture.effortId, label: 'none' });
    expect(unlabelled).not.toContain(fixture.keys.takeable);
    expect(unlabelled).toContain(fixture.keys.assigned);
  });

  test('blockers=none ignores blockers that are already finished; blockers=any is its complement', async () => {
    const unblocked = await list({ parentId: fixture.effortId, blockers: 'none' });
    // The whole point of the predicate: a task whose only blocker is DONE is takeable. The relation
    // count on the row still says it has one, which is exactly why the filter cannot be a count.
    expect(unblocked).toContain(fixture.keys.takeableAfterBlockerDone);
    expect(unblocked).not.toContain(fixture.keys.blocked);

    const blockedOnes = await list({ parentId: fixture.effortId, blockers: 'any' });
    expect(blockedOnes).toEqual([fixture.keys.blocked]);
  });

  test('sort replaces the default ordering and pages deterministically', async () => {
    const oldestFirst = await listOrdered({ parentId: fixture.effortId, sort: 'createdAt:asc' });
    const newestFirst = await listOrdered({ parentId: fixture.effortId, sort: 'createdAt:desc' });
    expect(oldestFirst).toEqual([...newestFirst].reverse());
    expect(oldestFirst[0]).toBe(fixture.keys.takeable);

    const firstPage = await listOrdered({ parentId: fixture.effortId, sort: 'createdAt:asc', limit: '2' });
    const secondPage = await listOrdered({ parentId: fixture.effortId, sort: 'createdAt:asc', limit: '2', offset: '2' });
    expect([...firstPage, ...secondPage]).toEqual(oldestFirst.slice(0, 4));

    expect((await inject({ sort: 'title:asc' })).statusCode).toBe(400);
  });

  test('the frontier is one request: unfinished, unassigned, unblocked children of the effort', async () => {
    const response = await inject({
      parentId: fixture.effortId,
      status: 'unfinished',
      assigneeId: 'none',
      blockers: 'none',
      sort: 'createdAt:asc'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { key: string }) => item.key))
      .toEqual([fixture.keys.takeable, fixture.keys.takeableAfterBlockerDone]);
    expect(body.total).toBe(2);
  });
});

function childrenOfEffort(): string[] {
  return [
    fixture.keys.takeable,
    fixture.keys.takeableAfterBlockerDone,
    fixture.keys.assigned,
    fixture.keys.blocked,
    fixture.keys.finished,
    fixture.keys.canceled
  ].sort();
}

async function inject(query: Record<string, string>) {
  const search = new URLSearchParams(query).toString();
  return app.inject({
    method: 'GET',
    url: search ? `/tasks?${search}` : '/tasks',
    headers: { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': fixture.ownerEmail }
  });
}

/** Keys, sorted, so a test about *which* rows come back cannot accidentally assert order too. */
async function list(query: Record<string, string>): Promise<string[]> {
  return (await listOrdered(query)).sort();
}

async function listOrdered(query: Record<string, string>): Promise<string[]> {
  const response = await inject(query);
  expect(response.statusCode).toBe(200);
  return response.json().items.map((item: { key: string }) => item.key);
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `frontier-owner-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Frontier owner' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Frontier workspace', slug: `frontier-${suffix}` }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Frontier', keyPrefix: `FR${suffix.slice(0, 3).toUpperCase()}` }
  });

  const ids = {} as Record<TaskName, string>;
  const keys = {} as Record<TaskName, string>;
  let sequence = 0;
  // Fixed, spaced timestamps: the sort assertions are about a caller-chosen order, so they must not
  // depend on how fast the seeding runs.
  const base = Date.parse('2026-01-01T00:00:00.000Z');

  const seed = async (name: TaskName, data: Partial<Prisma.TaskUncheckedCreateInput>) => {
    sequence += 1;
    const key = `${project.keyPrefix}-${sequence}`;
    const created = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        sequence,
        key,
        title: name,
        createdAt: new Date(base + sequence * 60_000),
        ...data
      },
      select: { id: true }
    });
    ids[name] = created.id;
    keys[name] = key;
  };

  await seed('effort', { kind: 'EFFORT', status: 'IN_PROGRESS', title: 'Taskara as the agent issue tracker' });
  const parentId = ids.effort;

  await seed('takeable', { parentId, status: 'TODO' });
  await seed('takeableAfterBlockerDone', { parentId, status: 'TODO' });
  await seed('assigned', { parentId, status: 'TODO', assigneeId: owner.id });
  await seed('blocked', { parentId, status: 'TODO' });
  await seed('finished', { parentId, status: 'DONE', completedAt: new Date(base) });
  await seed('canceled', { parentId, status: 'CANCELED' });
  await seed('openBlocker', { status: 'IN_PROGRESS' });
  await seed('doneBlocker', { status: 'DONE', completedAt: new Date(base) });
  await seed('orphan', { status: 'TODO' });

  await prisma.taskDependency.createMany({
    data: [
      { taskId: ids.blocked, blockedByTaskId: ids.openBlocker },
      { taskId: ids.takeableAfterBlockerDone, blockedByTaskId: ids.doneBlocker }
    ]
  });

  const label = await prisma.label.create({
    data: { workspaceId: workspace.id, name: 'wayfinder:task' }
  });
  await prisma.taskLabel.create({ data: { taskId: ids.takeable, labelId: label.id } });

  return { workspace, ownerEmail, effortId: ids.effort, ids, keys };
}
