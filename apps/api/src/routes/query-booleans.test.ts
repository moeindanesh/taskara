import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Issue #42: a boolean query parameter must read the word it was given.
 *
 * `z.coerce.boolean()` is `Boolean(string)`, so every non-empty value is `true` and there is no
 * spelling of "off" at all — `?mine=false` means the same as `?mine=true`. The caller gets a
 * narrower list than it asked for and no error to notice it by, which for the agent surface (it
 * builds every query from strings) is a wrong frontier reported as a success.
 *
 * The rule this file pins, for every boolean parameter on every endpoint: `true` and `false` are the
 * only accepted spellings, they mean themselves, and anything else is a 400 rather than a guess.
 * `false` is the case none of these parameters covered before.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerEmail: string;
  otherEmail: string;
  ownerTaskKey: string;
  otherTaskKey: string;
  ownerArchivedTaskKey: string;
  otherArchivedTaskKey: string;
}

describe('boolean query parameters read the word they were given', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({ where: { email: { in: [fixture.ownerEmail, fixture.otherEmail] } } });
    await app.close();
  });

  describe('GET /tasks?mine', () => {
    test('mine=false is the whole team, not just me', async () => {
      const keys = await listTaskKeys({ mine: 'false' });
      expect(keys).toContain(fixture.ownerTaskKey);
      expect(keys).toContain(fixture.otherTaskKey);
    });

    test('mine=true is still only mine', async () => {
      const keys = await listTaskKeys({ mine: 'true' });
      expect(keys).toContain(fixture.ownerTaskKey);
      expect(keys).not.toContain(fixture.otherTaskKey);
    });

    test('a value that is neither true nor false is a 400, not a guess', async () => {
      for (const value of ['banana', '0', '1', 'yes', 'no', 'FALSE', '']) {
        expect((await getTasks({ mine: value })).statusCode).toBe(400);
      }
    });
  });

  /**
   * `listAttentionItems` reads `query.generate !== false`, so the opt-out was written and then made
   * unreachable by the schema in front of it: no query string could produce `false`, and every
   * listing paid for a full attention sweep. Fixing the parse is what connects the two.
   */
  describe('GET /attention?generate', () => {
    test('generate=false skips the sweep, so nothing is generated', async () => {
      const body = await getJson('/attention', { generate: 'false' });
      expect(body.generatedAt).toBeNull();
    });

    test('generate=true still sweeps', async () => {
      const body = await getJson('/attention', { generate: 'true' });
      expect(body.generatedAt).not.toBeNull();
    });

    test('an unparseable generate or includeSnoozed is a 400', async () => {
      expect((await get('/attention', { generate: 'banana' })).statusCode).toBe(400);
      expect((await get('/attention', { includeSnoozed: '1' })).statusCode).toBe(400);
    });
  });

  /**
   * `knowledgePageWhereForQuery` branches three ways on `verified` — verified, unverified, and no
   * filter at all — and the middle one had no reachable input. "Show me the pages nobody has
   * verified" is the question the field exists to answer and the one it could not be asked.
   */
  describe('GET /knowledge/pages?verified', () => {
    test('verified=false selects the unverified pages, not the verified ones', async () => {
      const titles = await pageTitles({ verified: 'false' });
      expect(titles).toEqual(['Unverified page']);
    });

    test('verified=true still selects the verified ones', async () => {
      expect(await pageTitles({ verified: 'true' })).toEqual(['Verified page']);
    });

    test('omitting verified filters on neither', async () => {
      expect(await pageTitles({})).toEqual(['Unverified page', 'Verified page']);
    });

    test('an unparseable verified, expired or mine is a 400', async () => {
      expect((await get('/knowledge/pages', { verified: 'banana' })).statusCode).toBe(400);
      expect((await get('/knowledge/pages', { expired: '1' })).statusCode).toBe(400);
      expect((await get('/knowledge/pages', { mine: 'no' })).statusCode).toBe(400);
    });
  });

  /**
   * `active` is handed straight to Prisma as a `where` clause, so the coercion did not merely ignore
   * `false` — it inverted it, answering "the retired series" with the running ones.
   */
  describe('GET /one-on-ones?active', () => {
    test('active=false selects the retired series, not the running one', async () => {
      expect(await seriesTitles({ active: 'false' })).toEqual(['Retired series']);
    });

    test('active=true still selects the running one', async () => {
      expect(await seriesTitles({ active: 'true' })).toEqual(['Running series']);
    });

    test('an unparseable active is a 400', async () => {
      expect((await get('/one-on-ones', { active: 'banana' })).statusCode).toBe(400);
    });
  });

  /**
   * The remaining sites all narrow a list when the flag is on, so `false` has to mean the unnarrowed
   * list — the same thing omitting the parameter means, and the thing every one of them used to
   * refuse to say. Each is asserted against the parameter's own endpoint rather than its schema,
   * because a route file holding its own copy of the query shape is exactly how these drifted apart.
   */
  describe('the filters that narrow a list are off when told false', () => {
    test('GET /tasks/archive?mine=false is the whole team', async () => {
      const all = await keysOf('/tasks/archive', { mine: 'false' });
      const onlyMine = await keysOf('/tasks/archive', { mine: 'true' });
      expect(all).toContain(fixture.otherArchivedTaskKey);
      expect(onlyMine).toEqual([fixture.ownerArchivedTaskKey]);
      expect((await get('/tasks/archive', { mine: 'banana' })).statusCode).toBe(400);
    });

    test('GET /sync/bootstrap?mine=false seeds the cache with the whole team', async () => {
      const keys = (body: { tasks: Array<{ key: string }> }) => body.tasks.map((task) => task.key);
      expect(keys(await getJson('/sync/bootstrap', { mine: 'false' }))).toContain(fixture.otherTaskKey);
      expect(keys(await getJson('/sync/bootstrap', { mine: 'true' }))).not.toContain(fixture.otherTaskKey);
      expect((await get('/sync/bootstrap', { mine: 'banana' })).statusCode).toBe(400);
    });

    test('GET /announcements?unread=false is everything, read or not', async () => {
      const all = await getJson('/announcements', { unread: 'false' });
      const unreadOnly = await getJson('/announcements', { unread: 'true' });
      expect(all.items.length).toBeGreaterThan(unreadOnly.items.length);
      expect((await get('/announcements', { unread: 'banana' })).statusCode).toBe(400);
    });

    test('GET /notifications?unread=false is everything, read or not', async () => {
      const all = await getJson('/notifications', { unread: 'false' });
      const unreadOnly = await getJson('/notifications', { unread: 'true' });
      expect(all.items.length).toBeGreaterThan(unreadOnly.items.length);
      expect((await get('/notifications', { unread: 'banana' })).statusCode).toBe(400);
    });

    test('GET /meetings?mine=false is the whole team', async () => {
      const all = await getJson('/meetings', { mine: 'false' });
      const onlyMine = await getJson('/meetings', { mine: 'true' });
      const titles = (body: { items: Array<{ title: string }> }) => body.items.map((item) => item.title);
      expect(titles(all)).toContain('Someone else’s meeting');
      expect(titles(onlyMine)).not.toContain('Someone else’s meeting');
      expect((await get('/meetings', { mine: 'banana' })).statusCode).toBe(400);
    });
  });
});

async function keysOf(path: string, query: Record<string, string>): Promise<string[]> {
  const body = await getJson(path, query);
  return body.items.map((item: { key: string }) => item.key).sort();
}

async function seriesTitles(query: Record<string, string>): Promise<string[]> {
  const body = await getJson('/one-on-ones', query);
  return body.items.map((item: { title: string | null }) => item.title ?? '').sort();
}

async function pageTitles(query: Record<string, string>): Promise<string[]> {
  const body = await getJson('/knowledge/pages', query);
  return body.items.map((item: { title: string }) => item.title).sort();
}

async function get(path: string, query: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: `${path}?${new URLSearchParams(query).toString()}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail }
  });
}

async function getJson(path: string, query: Record<string, string>) {
  const response = await get(path, query);
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function getTasks(query: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: `/tasks?${new URLSearchParams(query).toString()}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail }
  });
}

async function listTaskKeys(query: Record<string, string>): Promise<string[]> {
  const response = await getTasks(query);
  expect(response.statusCode).toBe(200);
  return response.json().items.map((item: { key: string }) => item.key).sort();
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `bool-owner-${suffix}@example.test`;
  const otherEmail = `bool-other-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Bool owner' } });
  const other = await prisma.user.create({ data: { email: otherEmail, name: 'Bool other' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Bool workspace', slug: `bool-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: other.id, role: 'MEMBER' }
    ]
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Bool',
      keyPrefix: `BL${suffix.slice(0, 3).toUpperCase()}`
    }
  });

  const ownerTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: 1,
      key: `${project.keyPrefix}-1`,
      title: 'Mine',
      status: 'TODO',
      assigneeId: owner.id
    }
  });
  const otherTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: 2,
      key: `${project.keyPrefix}-2`,
      title: 'Theirs',
      status: 'TODO',
      assigneeId: other.id
    }
  });

  const space = await prisma.knowledgeSpace.create({
    data: {
      workspaceId: workspace.id,
      type: 'WORKSPACE',
      key: `bool-space-${suffix}`,
      name: 'Bool space'
    }
  });
  // One verified, one not: `verified=false` is only meaningful if the two are distinguishable, and a
  // fixture of a single page would let a broken filter pass by returning everything.
  await prisma.knowledgePage.create({
    data: {
      workspaceId: workspace.id,
      spaceId: space.id,
      slug: 'verified-page',
      path: 'verified-page',
      title: 'Verified page',
      content: {},
      contentText: '',
      status: 'PUBLISHED',
      verifiedAt: new Date('2026-01-01T00:00:00.000Z')
    }
  });
  await prisma.knowledgePage.create({
    data: {
      workspaceId: workspace.id,
      spaceId: space.id,
      slug: 'unverified-page',
      path: 'unverified-page',
      title: 'Unverified page',
      content: {},
      contentText: '',
      status: 'PUBLISHED'
    }
  });

  // The archive is what finished more than five days ago, so these need a real, old completedAt.
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ownerArchived = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: 3,
      key: `${project.keyPrefix}-3`,
      title: 'Mine, archived',
      status: 'DONE',
      assigneeId: owner.id,
      completedAt: longAgo
    }
  });
  const otherArchived = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: 4,
      key: `${project.keyPrefix}-4`,
      title: 'Theirs, archived',
      status: 'DONE',
      assigneeId: other.id,
      completedAt: longAgo
    }
  });

  // One read and one unread of each, so `unread=false` has something extra to return and cannot
  // pass by returning the same list twice.
  for (const [title, readAt] of [['Read announcement', longAgo], ['Unread announcement', null]] as const) {
    const announcement = await prisma.announcement.create({
      data: {
        workspaceId: workspace.id,
        title,
        status: 'PUBLISHED',
        publishedAt: longAgo
      }
    });
    await prisma.announcementRecipient.create({
      data: {
        workspaceId: workspace.id,
        announcementId: announcement.id,
        userId: owner.id,
        readAt
      }
    });
  }

  // These two rows exist to be counted by `?unread=`, and nothing here asserts anything about who
  // caused them. `SYSTEM` is what "no attributable actor" is spelled as, so the fixture says that
  // rather than inventing an author whose provenance a later reader might take for meaningful.
  await prisma.notification.createMany({
    data: [
      {
        workspaceId: workspace.id,
        userId: owner.id,
        actorType: 'SYSTEM',
        taskId: ownerTask.id,
        type: 'task.assigned',
        title: 'Read notification',
        readAt: longAgo
      },
      {
        workspaceId: workspace.id,
        userId: owner.id,
        actorType: 'SYSTEM',
        taskId: otherTask.id,
        type: 'task.assigned',
        title: 'Unread notification'
      }
    ]
  });

  await prisma.meeting.createMany({
    data: [
      { workspaceId: workspace.id, title: 'My meeting', ownerId: owner.id },
      { workspaceId: workspace.id, title: 'Someone else’s meeting', ownerId: other.id }
    ]
  });

  await prisma.oneOnOneSeries.createMany({
    data: [
      {
        workspaceId: workspace.id,
        managerId: owner.id,
        participantId: other.id,
        title: 'Running series',
        active: true
      },
      {
        workspaceId: workspace.id,
        managerId: owner.id,
        participantId: owner.id,
        title: 'Retired series',
        active: false
      }
    ]
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    otherEmail,
    ownerTaskKey: ownerTask.key,
    otherTaskKey: otherTask.key,
    ownerArchivedTaskKey: ownerArchived.key,
    otherArchivedTaskKey: otherArchived.key
  };
}
