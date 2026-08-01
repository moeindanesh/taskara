import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { createUserSession } from './auth';

/**
 * Provenance invariants that hold below the service layer.
 *
 * `db push` cannot apply a CHECK constraint, so a bootstrap that skips the migration yields the
 * column with no enforcement. These tests are what notices.
 */

const RUNTIME_CONSTRAINT = 'runtime_only_for_agents';
const EMAIL_DOMAIN = 'actor-provenance.test';

const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];

describe('provenance database invariants', () => {
  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    const userIds = cleanupUserIds.splice(0);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  test('refuses a runtime tag on an activity row that is not agent-authored', async () => {
    const fixture = await createFixture();

    for (const actorType of ['USER', 'SYSTEM', 'MATTERMOST', 'CODEX'] as const) {
      const error = await captureError(
        prisma.activityLog.create({
          data: {
            workspaceId: fixture.workspace.id,
            actorId: fixture.user.id,
            actorType,
            actorRuntime: 'CODEX',
            entityType: 'task',
            entityId: fixture.user.id,
            action: 'created'
          }
        })
      );
      expect(`${actorType}: ${String(error?.message)}`).toContain(RUNTIME_CONSTRAINT);
    }

    const tagged = await prisma.activityLog.create({
      data: {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        actorType: 'AGENT',
        actorRuntime: 'OPENCLAW',
        entityType: 'task',
        entityId: fixture.user.id,
        action: 'created'
      },
      select: { actorType: true, actorRuntime: true }
    });
    expect(tagged.actorType).toBe('AGENT');
    expect(tagged.actorRuntime).toBe('OPENCLAW');
  });

  test('refuses a runtime tag on a notification that is not agent-caused', async () => {
    const fixture = await createFixture();

    const error = await captureError(
      prisma.notification.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          actorId: fixture.user.id,
          actorType: 'USER',
          actorRuntime: 'HERMES',
          type: 'task_assigned',
          title: 'Forged'
        }
      })
    );
    expect(String(error?.message)).toContain(RUNTIME_CONSTRAINT);

    const tagged = await prisma.notification.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        actorId: fixture.user.id,
        actorType: 'AGENT',
        actorRuntime: 'HERMES',
        type: 'task_assigned',
        title: 'Honest'
      },
      select: { actorType: true, actorRuntime: true }
    });
    expect(tagged.actorType).toBe('AGENT');
    expect(tagged.actorRuntime).toBe('HERMES');
  });

  test('holds against raw SQL that bypasses Prisma entirely', async () => {
    const fixture = await createFixture();

    const row = await prisma.activityLog.create({
      data: {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        actorType: 'USER',
        entityType: 'task',
        entityId: fixture.user.id,
        action: 'created'
      },
      select: { id: true }
    });

    const rawTag = await captureError(
      prisma.$executeRawUnsafe(
        `UPDATE "ActivityLog" SET "actorRuntime" = 'CLAUDE_CODE' WHERE "id" = $1::uuid`,
        row.id
      )
    );
    expect(String(rawTag?.message)).toContain(RUNTIME_CONSTRAINT);

    const untouched = await prisma.activityLog.findUniqueOrThrow({
      where: { id: row.id },
      select: { actorRuntime: true }
    });
    expect(untouched.actorRuntime).toBeNull();
  });
});

/**
 * The property from issue #38: authorship is derived from the authenticated identity, and no
 * client can talk its way into looking like an agent or out of looking like one.
 *
 * These tests drive real endpoints over HTTP and read the rows those endpoints wrote. They never
 * call the derivation directly, so a route that reintroduces a header-derived actorType fails here
 * even though the derivation itself still passes its own unit tests.
 */
describe('agent authorship at the request boundary', () => {
  let app: FastifyInstance;

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
    const userIds = cleanupUserIds.splice(0);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  test('a human cannot claim agent authorship with a header', async () => {
    const fixture = await createWorkspaceFixture();

    const created = await inject(app, fixture, fixture.human.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'Human work' },
      headers: { 'x-actor-type': 'AGENT', 'x-agent-runtime': 'OPENCLAW' }
    });
    expect(created.statusCode).toBe(201);

    const row = await activityFor(created.json().id);
    expect(row.actorType).toBe('USER');
    expect(row.actorRuntime).toBeNull();
  });

  test("an agent's work is stamped AGENT however the client describes itself", async () => {
    const fixture = await createWorkspaceFixture();

    const created = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'Agent work' },
      headers: { 'x-actor-type': 'USER' }
    });
    expect(created.statusCode).toBe(201);

    const row = await activityFor(created.json().id);
    expect(row.actorType).toBe('AGENT');
  });

  test('the runtime rides on the action, because one agent User serves all four', async () => {
    const fixture = await createWorkspaceFixture();

    const viaOpenclaw = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'From OpenClaw' },
      headers: { 'x-agent-runtime': 'OPENCLAW' }
    });
    const viaClaudeCode = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'From Claude Code' },
      headers: { 'x-agent-runtime': 'claude-code' }
    });
    const viaNothing = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'From an undeclared runtime' }
    });

    expect((await activityFor(viaOpenclaw.json().id)).actorRuntime).toBe('OPENCLAW');
    expect((await activityFor(viaClaudeCode.json().id)).actorRuntime).toBe('CLAUDE_CODE');
    expect((await activityFor(viaNothing.json().id)).actorRuntime).toBeNull();
  });

  test('the legacy x-actor-type header names a runtime and decides nothing else', async () => {
    const fixture = await createWorkspaceFixture();

    const byAgent = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'Legacy plugin call' },
      headers: { 'x-actor-type': 'CODEX' }
    });
    const agentRow = await activityFor(byAgent.json().id);
    expect(agentRow.actorType).toBe('AGENT');
    expect(agentRow.actorRuntime).toBe('CODEX');

    const byHuman = await inject(app, fixture, fixture.human.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'Legacy human call' },
      headers: { 'x-actor-type': 'CODEX' }
    });
    const humanRow = await activityFor(byHuman.json().id);
    expect(humanRow.actorType).toBe('USER');
    expect(humanRow.actorRuntime).toBeNull();
  });

  test('provenance is a snapshot: changing the identity does not rewrite past work', async () => {
    const fixture = await createWorkspaceFixture();

    const created = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'Work done while an agent' },
      headers: { 'x-agent-runtime': 'HERMES' }
    });
    expect(created.statusCode).toBe(201);

    // The two things a query-time re-join would have consulted, both changed after the fact.
    await prisma.user.update({
      where: { id: fixture.agent.id },
      data: { kind: 'HUMAN', operatorId: null }
    });
    await prisma.workspaceMember.updateMany({
      where: { workspaceId: fixture.workspace.id, userId: fixture.agent.id },
      data: { role: 'ADMIN' }
    });

    const row = await activityFor(created.json().id);
    expect(row.actorType).toBe('AGENT');
    expect(row.actorRuntime).toBe('HERMES');
  });

  test('a notification records the agent that caused it', async () => {
    const fixture = await createWorkspaceFixture();

    const created = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: {
        projectId: fixture.project.id,
        title: 'Handed to a human',
        assigneeId: fixture.human.id
      },
      headers: { 'x-agent-runtime': 'CODEX' }
    });
    expect(created.statusCode).toBe(201);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, userId: fixture.human.id },
      select: { actorId: true, actorType: true, actorRuntime: true }
    });
    expect(notification.actorId).toBe(fixture.agent.id);
    expect(notification.actorType).toBe('AGENT');
    expect(notification.actorRuntime).toBe('CODEX');
  });

  test('an agent holding a web session is still an agent', async () => {
    const fixture = await createWorkspaceFixture();
    const { token } = await createUserSession(fixture.agent.id);

    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'Session-authenticated agent' },
      headers: {
        'x-workspace-slug': fixture.workspace.slug,
        authorization: `Bearer ${token}`
      }
    });
    expect(created.statusCode).toBe(201);

    const row = await activityFor(created.json().id);
    expect(row.actorType).toBe('AGENT');
  });

  test('an unrecognised runtime is recorded as none, not as a runtime', async () => {
    const fixture = await createWorkspaceFixture();

    const created = await inject(app, fixture, fixture.agent.email, {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: fixture.project.id, title: 'Runtime from the future' },
      headers: { 'x-agent-runtime': 'DEVIN' }
    });
    expect(created.statusCode).toBe(201);

    const row = await activityFor(created.json().id);
    expect(row.actorType).toBe('AGENT');
    expect(row.actorRuntime).toBeNull();
  });
});

interface Fixture {
  workspace: { id: string };
  user: { id: string };
}

interface WorkspaceFixture {
  workspace: { id: string; slug: string };
  project: { id: string };
  human: { id: string; email: string };
  agent: { id: string; email: string };
}

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const slug = `provenance-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  const workspace = await prisma.workspace.create({
    data: { name: `Provenance ${suffix}`, slug },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const human = await prisma.user.create({
    data: { email: `human-${suffix}@${EMAIL_DOMAIN}`.toLowerCase(), name: 'Operator' },
    select: { id: true, email: true }
  });
  cleanupUserIds.push(human.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: human.id, role: 'OWNER' }
  });

  // Deliberately an ordinary MEMBER role: agent-ness must come from kind, never from
  // WorkspaceRole.AGENT, which is per-workspace and carries no history.
  const agent = await prisma.user.create({
    data: {
      email: `agent-${suffix}@${EMAIL_DOMAIN}`.toLowerCase(),
      name: 'Claude',
      kind: 'AGENT',
      operatorId: human.id
    },
    select: { id: true, email: true }
  });
  cleanupUserIds.push(agent.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Provenance',
      keyPrefix: `PV${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
    },
    select: { id: true }
  });

  return { workspace, project, human, agent };
}

function inject(
  app: FastifyInstance,
  fixture: WorkspaceFixture,
  email: string,
  options: InjectOptions & { headers?: Record<string, string> }
) {
  return app.inject({
    ...options,
    headers: {
      'x-workspace-slug': fixture.workspace.slug,
      'x-user-email': email,
      ...(options.headers || {})
    }
  });
}

async function activityFor(taskId: string) {
  return prisma.activityLog.findFirstOrThrow({
    where: { entityType: 'task', entityId: taskId },
    orderBy: { createdAt: 'desc' },
    select: { actorId: true, actorType: true, actorRuntime: true }
  });
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Provenance ${suffix}`,
      slug: `provenance-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const user = await prisma.user.create({
    data: { email: `member-${suffix}@actor-provenance.test`.toLowerCase(), name: 'Member' },
    select: { id: true }
  });
  cleanupUserIds.push(user.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'MEMBER' }
  });

  return { workspace, user };
}

async function captureError(work: Promise<unknown>): Promise<Error | undefined> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  return undefined;
}
