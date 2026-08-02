import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { watchTaskKeyWrites } from './task-key-harness';

/**
 * A task key is permanent — issue #27.
 *
 * Moving a task between projects used to re-issue its key, so `CORE-42` became `PLAT-7` and every
 * reference anybody had written down stopped resolving: a commit message, a branch name, another
 * task's body, a bookmarked `/issue/CORE-42`. Nothing announced it and nothing redirected.
 *
 * These tests drive real endpoints and then read the rows those endpoints wrote, so a path that
 * reintroduces a re-key fails here even if it spells things differently. The harness alongside them
 * is the part that covers paths nobody has written yet.
 */

const EMAIL_DOMAIN = 'task-key-immutability.test';
const cleanupWorkspaceIds: string[] = [];

let app: FastifyInstance;

describe('a task key survives a move between projects', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  test('moving a task to another project keeps its key and moves only its sequence', async () => {
    const fixture = await createFixture();
    const watch = watchTaskKeyWrites();

    try {
      const moved = await inject(fixture, {
        method: 'PATCH',
        url: `/tasks/${fixture.task.key}`,
        payload: { projectId: fixture.plat.id }
      });

      expect(moved.statusCode).toBe(200);
      expect(moved.json().key).toBe(fixture.task.key);
      expect(moved.json().project.id).toBe(fixture.plat.id);

      const row = await prisma.task.findUniqueOrThrow({
        where: { id: fixture.task.id },
        select: { key: true, sequence: true, projectId: true }
      });
      expect(row.key).toBe(fixture.task.key);
      expect(row.projectId).toBe(fixture.plat.id);

      // The sequence MUST move. @@unique([projectId, sequence]) means a task carrying 1 cannot
      // enter a project that already has one, and PLAT-1 exists. Asserting this is what stops a
      // later "tidy-up" reuniting key and sequence by leaving the sequence alone, which would
      // reintroduce the collision this re-reservation exists to avoid.
      expect(row.sequence).not.toBe(fixture.task.sequence);
      expect(row.sequence).toBeGreaterThan(1);

      // And the key is now deliberately out of step with prefix-sequence. Pinned, because it looks
      // like a bug to anyone who has just read the creation path.
      expect(row.key).not.toBe(`PLAT-${row.sequence}`);

      expect(watch.violations()).toEqual([]);
      // The drive has to have been seen, or an empty violation list proves nothing.
      expect(watch.writes().length).toBeGreaterThan(0);
    } finally {
      watch.stop();
    }
  });

  test('the old key still resolves, because it was never surrendered', async () => {
    const fixture = await createFixture();

    await inject(fixture, {
      method: 'PATCH',
      url: `/tasks/${fixture.task.key}`,
      payload: { projectId: fixture.plat.id }
    });

    const found = await inject(fixture, { method: 'GET', url: `/tasks/${fixture.task.key}` });
    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe(fixture.task.id);
  });

  test('merging projects keeps keys too, which is the behaviour the move now matches', async () => {
    const fixture = await createFixture();
    const watch = watchTaskKeyWrites();

    try {
      const merged = await inject(fixture, {
        method: 'POST',
        url: '/projects/merge',
        payload: { destinationProjectId: fixture.plat.id, sourceProjectIds: [fixture.core.id] }
      });
      expect(merged.statusCode).toBe(200);

      const row = await prisma.task.findUniqueOrThrow({
        where: { id: fixture.task.id },
        select: { key: true, projectId: true }
      });
      expect(row.key).toBe(fixture.task.key);
      expect(row.projectId).toBe(fixture.plat.id);

      expect(watch.violations()).toEqual([]);
      expect(watch.writes().length).toBeGreaterThan(0);
    } finally {
      watch.stop();
    }
  });

  test('a key is still issued at creation, and still matches its project then', async () => {
    const fixture = await createFixture();

    const created = await inject(fixture, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.plat.id, title: 'Fresh work' }
    });

    expect(created.statusCode).toBe(201);
    const row = await prisma.task.findUniqueOrThrow({
      where: { id: created.json().id },
      select: { key: true, sequence: true }
    });
    expect(row.key).toBe(`PLAT-${row.sequence}`);
  });

  test('the harness catches a key write, so an empty violation list means something', async () => {
    const fixture = await createFixture();
    const watch = watchTaskKeyWrites();

    // The planted regression: exactly what updateTask used to do. Written directly against Prisma
    // rather than through a route, because no route does this any more — which is the point.
    try {
      await prisma.task.update({
        where: { id: fixture.task.id },
        data: { projectId: fixture.plat.id, key: 'PLAT-99', sequence: 99 }
      });

      expect(watch.violations()).toEqual(['task.update set key to "PLAT-99"']);
    } finally {
      watch.stop();
    }
  });

  test('the harness sees a write made inside a transaction', async () => {
    const fixture = await createFixture();
    const watch = watchTaskKeyWrites();

    // Every task write in this API runs in an interactive transaction. A harness that only watched
    // the singleton's delegate would observe nothing and report a clean pass on a broken API, so
    // this asserts the transaction layer is genuinely covered rather than incidentally quiet.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.task.update({ where: { id: fixture.task.id }, data: { key: 'CORE-77' } });
      });

      expect(watch.violations()).toEqual(['task.update set key to "CORE-77"']);
    } finally {
      watch.stop();
    }
  });
});

interface Fixture {
  workspace: { id: string; slug: string };
  owner: { email: string };
  core: { id: string };
  plat: { id: string };
  task: { id: string; key: string; sequence: number };
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const slug = `key-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  const workspace = await prisma.workspace.create({
    data: { name: `Keys ${suffix}`, slug },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const owner = await prisma.user.create({
    data: { email: `owner-${suffix}@${EMAIL_DOMAIN}`.toLowerCase(), name: 'Owner' },
    select: { id: true, email: true }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });

  const core = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Core', keyPrefix: 'CORE', nextTaskNumber: 2 },
    select: { id: true }
  });
  // PLAT already holds sequence 1, so the moved task cannot keep its own and the re-reservation is
  // load-bearing rather than incidental.
  const plat = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Platform', keyPrefix: 'PLAT', nextTaskNumber: 2 },
    select: { id: true }
  });

  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, projectId: core.id, sequence: 1, key: 'CORE-1', title: 'Portable work' },
    select: { id: true, key: true, sequence: true }
  });
  await prisma.task.create({
    data: { workspaceId: workspace.id, projectId: plat.id, sequence: 1, key: 'PLAT-1', title: 'Sitting on one' }
  });

  return { workspace, owner, core, plat, task };
}

function inject(fixture: Fixture, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': fixture.owner.email }
  });
}
