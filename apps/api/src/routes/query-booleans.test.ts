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
      expect(keys).toEqual([fixture.ownerTaskKey]);
    });

    test('a value that is neither true nor false is a 400, not a guess', async () => {
      for (const value of ['banana', '0', '1', 'yes', 'no', 'FALSE', '']) {
        expect((await getTasks({ mine: value })).statusCode).toBe(400);
      }
    });
  });
});

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

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    otherEmail,
    ownerTaskKey: ownerTask.key,
    otherTaskKey: otherTask.key
  };
}
