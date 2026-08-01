import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Additive label mutation, asserted at the HTTP boundary.
 *
 * `labels` is a whole-array replacement and `PATCH /tasks/:idOrKey` has no concurrency control, so
 * two agents relabelling one task each read `[a]`, write `[a,x]` and `[a,y]`, and one write vanishes.
 * `addLabels` / `removeLabels` move the add into the server so the two writes commute. The
 * replacement stays exactly as it was for the web client, which sends the whole set on purpose.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerEmail: string;
  projectId: string;
}

describe('PATCH /tasks/:idOrKey label mutation', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({ where: { email: fixture.ownerEmail } });
    await app.close();
  });

  test('addLabels adds to what is already there instead of replacing it', async () => {
    const task = await createTask('keeps its existing labels', ['keep-me']);

    const response = await patch(task.key, { addLabels: ['added'] });

    expect(response.statusCode).toBe(200);
    expect(await labelsOf(task.key)).toEqual(['added', 'keep-me']);
  });

  test('two agents relabelling the same task concurrently both survive', async () => {
    const task = await createTask('relabelled by two agents at once', ['shared']);

    // The exact scenario from #25: both start from `[shared]`, one wants `x`, the other wants `y`.
    // Sent as `labels` these are `[shared,x]` and `[shared,y]` and the later write erases the other
    // agent's label with no error anywhere. Sent as `addLabels` neither carries the set, so there is
    // nothing to erase.
    const [first, second] = await Promise.all([
      patch(task.key, { addLabels: ['from-agent-x'] }),
      patch(task.key, { addLabels: ['from-agent-y'] })
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(await labelsOf(task.key)).toEqual(['from-agent-x', 'from-agent-y', 'shared']);
  });

  test('the replacement idiom is what loses a concurrent write, and it is left untouched', async () => {
    const task = await createTask('relabelled the old way', ['shared']);

    // Not a bug report — a pin. The web client sends the whole set deliberately and keeps this
    // behaviour, so the fix had to be a second idiom rather than a change to this one. If this
    // ever starts merging, `labels` has silently stopped meaning "replace".
    await Promise.all([
      patch(task.key, { labels: ['shared', 'from-agent-x'] }),
      patch(task.key, { labels: ['shared', 'from-agent-y'] })
    ]);

    const survivors = await labelsOf(task.key);
    expect(survivors).toContain('shared');
    expect(survivors).not.toEqual(['from-agent-x', 'from-agent-y', 'shared']);
  });

  test('removeLabels takes labels away and leaves the rest, and a delta may do both at once', async () => {
    const task = await createTask('has a label swapped', ['needs-triage', 'keep-me']);

    const response = await patch(task.key, {
      addLabels: ['wayfinder:task'],
      removeLabels: ['needs-triage']
    });

    expect(response.statusCode).toBe(200);
    expect(await labelsOf(task.key)).toEqual(['keep-me', 'wayfinder:task']);
  });

  test('adding a label the task already carries is a no-op, not a duplicate or a 500', async () => {
    const task = await createTask('already labelled', ['wayfinder:task']);

    const response = await patch(task.key, { addLabels: ['wayfinder:task'] });

    expect(response.statusCode).toBe(200);
    expect(await labelsOf(task.key)).toEqual(['wayfinder:task']);
  });

  test('removing a label the task never had is a no-op, not a 404', async () => {
    const task = await createTask('never had it', ['keep-me']);

    const response = await patch(task.key, { removeLabels: ['was-never-here'] });

    expect(response.statusCode).toBe(200);
    expect(await labelsOf(task.key)).toEqual(['keep-me']);
  });

  test('replacing and adding in the same request is refused rather than merged in some order', async () => {
    const task = await createTask('sent both idioms', ['keep-me']);

    const response = await patch(task.key, { labels: ['replaced'], addLabels: ['added'] });

    expect(response.statusCode).toBe(400);
    expect(await labelsOf(task.key)).toEqual(['keep-me']);
  });

  test('the twelve-label cap binds on the result, not just on one request', async () => {
    const task = await createTask('close to the cap', ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);

    // Under the input-array cap alone this would pass: six is well under twelve. The set it
    // produces is thirteen, which is the number that matters.
    const response = await patch(task.key, {
      addLabels: ['l7', 'l8', 'l9', 'l10', 'l11', 'l12', 'l13']
    });

    expect(response.statusCode).toBe(400);
    expect(await labelsOf(task.key)).toHaveLength(6);
  });
});

async function labelsOf(key: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/tasks/${key}`,
    headers: headers()
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { labels?: Array<{ label?: { name: string }; name?: string }> };
  return (body.labels ?? [])
    .map((entry) => entry.label?.name ?? entry.name ?? '')
    .sort();
}

function patch(key: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/tasks/${key}`,
    headers: headers(),
    payload: body
  });
}

function headers(): Record<string, string> {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail };
}

async function createTask(title: string, labels: string[]): Promise<{ id: string; key: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: headers(),
    payload: { projectId: fixture.projectId, title, labels }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `labels-owner-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Labels owner' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Labels workspace', slug: `labels-${suffix}` }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Labels', keyPrefix: `LB${suffix.slice(0, 3).toUpperCase()}` }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    projectId: project.id
  };
}
