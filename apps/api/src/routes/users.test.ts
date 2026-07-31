import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];

const EMAIL_DOMAIN = 'user-kind-routes.test';

describe('user provisioning routes', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    // Only ever removes rows this file created: the domain is unique to it.
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('provisions an agent user bound to a human operator', async () => {
    const fixture = await createFixture();
    const email = uniqueEmail('claude');

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email, name: 'Claude', kind: 'AGENT', operatorId: fixture.operator.id, role: 'AGENT' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().kind).toBe('AGENT');
    expect(response.json().operatorId).toBe(fixture.operator.id);
    expect(response.json().role).toBe('AGENT');

    const stored = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { kind: true, operatorId: true }
    });
    expect(stored.kind).toBe('AGENT');
    expect(stored.operatorId).toBe(fixture.operator.id);
  });

  test('provisions an ordinary human when kind is omitted', async () => {
    const fixture = await createFixture();
    const email = uniqueEmail('human');

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email, name: 'Plain human' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().kind).toBe('HUMAN');
    expect(response.json().operatorId).toBeNull();
  });

  test('provisions an agent with no operator', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email: uniqueEmail('unbound-agent'), name: 'Unbound agent', kind: 'AGENT' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().kind).toBe('AGENT');
    expect(response.json().operatorId).toBeNull();
  });

  test('rejects a human that is given an operator', async () => {
    const fixture = await createFixture();
    const email = uniqueEmail('human-with-operator');

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email, name: 'Human with operator', kind: 'HUMAN', operatorId: fixture.operator.id }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('Only an agent user can have an operator');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test('rejects an operator that does not resolve in this workspace', async () => {
    const fixture = await createFixture();
    const outsider = await createOutsider();

    const unknown = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: {
        email: uniqueEmail('agent-unknown-operator'),
        name: 'Agent',
        kind: 'AGENT',
        operatorId: crypto.randomUUID()
      }
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toBe('Operator must be a user in this workspace');

    const email = uniqueEmail('agent-foreign-operator');
    const foreign = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email, name: 'Agent', kind: 'AGENT', operatorId: outsider.id }
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().message).toBe('Operator must be a user in this workspace');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test('rejects an agent operating another agent', async () => {
    const fixture = await createFixture();
    const email = uniqueEmail('agent-of-agent');

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email, name: 'Agent of an agent', kind: 'AGENT', operatorId: fixture.agent.id }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('An agent cannot operate another agent');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  // Rejecting an agent operator on the way in is only half the rule: without this guard the same
  // forbidden shape is reachable by promoting the operator afterwards.
  test('rejects promoting a user that already operates agents', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email: fixture.operator.email, name: 'Operator', kind: 'AGENT' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('A user that operates agents cannot become an agent');

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.operator.id },
      select: { kind: true }
    });
    expect(stored.kind).toBe('HUMAN');
  });

  test('rejects a user operating itself', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email: fixture.admin.email, name: 'Admin', kind: 'AGENT', operatorId: fixture.admin.id }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('A user cannot operate itself');

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.admin.id },
      select: { kind: true, operatorId: true }
    });
    expect(stored.kind).toBe('HUMAN');
    expect(stored.operatorId).toBeNull();
  });

  // An omitted operatorId means "leave it alone" on update, not "detach".
  test('keeps an existing operator link when kind is re-sent without an operator', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/users',
      payload: { email: fixture.agent.email, name: 'Existing agent', kind: 'AGENT' }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().operatorId).toBe(fixture.operator.id);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.agent.id },
      select: { kind: true, operatorId: true }
    });
    expect(stored.kind).toBe('AGENT');
    expect(stored.operatorId).toBe(fixture.operator.id);
  });
});

type Persona = 'admin' | 'operator';

interface Fixture {
  workspace: { id: string; slug: string };
  admin: { id: string; email: string };
  operator: { id: string; email: string };
  agent: { id: string; email: string };
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `User kind ${suffix}`, slug: `user-kind-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60) },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const admin = await prisma.user.create({
    data: { email: uniqueEmail('admin'), name: 'Admin' },
    select: { id: true, email: true }
  });
  const operator = await prisma.user.create({
    data: { email: uniqueEmail('operator'), name: 'Operator' },
    select: { id: true, email: true }
  });
  const agent = await prisma.user.create({
    data: { email: uniqueEmail('existing-agent'), name: 'Existing agent', kind: 'AGENT', operatorId: operator.id },
    select: { id: true, email: true }
  });

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
      { workspaceId: workspace.id, userId: operator.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: agent.id, role: 'AGENT' }
    ]
  });

  return { workspace, admin, operator, agent };
}

async function createOutsider(): Promise<{ id: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `Foreign ${suffix}`, slug: `foreign-user-kind-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60) },
    select: { id: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const user = await prisma.user.create({
    data: { email: uniqueEmail('outsider'), name: 'Outsider' },
    select: { id: true }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'MEMBER' }
  });
  return user;
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
