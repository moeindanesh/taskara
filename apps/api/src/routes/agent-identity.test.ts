import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';
import { parseEnvFlag } from '../config';
import { hashPassword, hashToken } from '../services/auth';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];

const EMAIL_DOMAIN = 'agent-identity.test';
const PASSWORD = 'correct horse battery staple';

/**
 * An agent User is provisioned without a password on purpose. That makes its identity claimable by
 * anyone who learns its email address unless every path that can write a password refuses to write
 * one onto an agent -- and the agent's email is not a secret; it appears in every activity feed,
 * assignee picker and member list in the product.
 */
describe('an agent identity cannot be claimed by a person', () => {
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

  test('public signup cannot take over a passwordless agent', async () => {
    const fixture = await createFixture();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: fixture.agent.email, name: 'Actually a person', password: PASSWORD }
    });

    expect(response.statusCode).toBe(409);
    // Deliberately the same wording an ordinary duplicate gets: whether an address belongs to an
    // agent is not something an unauthenticated caller should be able to probe.
    expect(response.json().message).toBe('An account with this email already exists');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: fixture.agent.id } });
    expect(stored.passwordHash).toBeNull();
    expect(stored.kind).toBe('AGENT');
    expect(stored.name).toBe('Claude');
    expect(await prisma.authSession.count({ where: { userId: fixture.agent.id } })).toBe(0);
  });

  test('signup still works for an ordinary new person', async () => {
    const email = uniqueEmail('newcomer');

    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, name: 'Newcomer', password: PASSWORD }
    });

    expect(response.statusCode).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).kind).toBe('HUMAN');
  });

  test('accepting an invite cannot take over an agent either', async () => {
    const fixture = await createFixture();
    const token = `invite-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await prisma.workspaceInvite.create({
      data: {
        workspaceId: fixture.workspace.id,
        email: fixture.agent.email,
        role: 'ADMIN',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });

    const response = await app.inject({
      method: 'POST',
      url: `/auth/invites/${token}/accept`,
      payload: { name: 'Actually a person', password: PASSWORD }
    });

    expect(response.statusCode).toBe(409);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: fixture.agent.id } });
    expect(stored.passwordHash).toBeNull();
    expect(stored.kind).toBe('AGENT');

    const membership = await prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: fixture.workspace.id, userId: fixture.agent.id } }
    });
    expect(membership.role).toBe('MEMBER');
  });

  test('an agent cannot log in even if a password somehow reached its row', async () => {
    const fixture = await createFixture();
    // Simulates a row that predates this guard, or one written by any path outside these routes.
    await prisma.user.update({
      where: { id: fixture.agent.id },
      data: { passwordHash: await hashPassword(PASSWORD) }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: fixture.agent.email, password: PASSWORD }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe('Invalid email or password');
    expect(await prisma.authSession.count({ where: { userId: fixture.agent.id } })).toBe(0);
  });

  test('an ordinary person can still log in', async () => {
    const fixture = await createFixture();
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { passwordHash: await hashPassword(PASSWORD) }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: fixture.admin.email, password: PASSWORD }
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('the legacy email header', () => {
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
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('cannot speak as an agent', async () => {
    const fixture = await createFixture();

    const response = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': fixture.agent.email }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe('Agent users must authenticate with an agent credential');
  });

  test('still works for a person, so shipped consumers keep running', async () => {
    const fixture = await createFixture();

    const response = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': fixture.admin.email }
    });

    expect(response.statusCode).toBe(200);
  });
});

/**
 * The switch that turns the legacy path off is only worth having if it can actually be turned off.
 * `z.coerce.boolean()` -- the idiom used by every other flag in this config -- reads the string
 * "false" as **true**, which for a security switch means an operator who disables it has not.
 */
describe('the email-header switch reads what an operator writes', () => {
  test('treats the words that mean off as off', () => {
    for (const value of ['false', 'FALSE', 'False', '0', 'no', 'off', ' off ']) {
      expect(parseEnvFlag(value, true)).toBe(false);
    }
  });

  test('treats the words that mean on as on', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(parseEnvFlag(value, false)).toBe(true);
    }
  });

  test('falls back when the variable is absent or blank', () => {
    expect(parseEnvFlag(undefined, true)).toBe(true);
    expect(parseEnvFlag('', true)).toBe(true);
    expect(parseEnvFlag(undefined, false)).toBe(false);
  });
});

interface Fixture {
  workspace: { id: string; slug: string };
  admin: { id: string; email: string };
  agent: { id: string; email: string };
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `Agent identity ${suffix}`, slug: `agent-id-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 48) },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const admin = await prisma.user.create({
    data: { email: uniqueEmail('admin'), name: 'Admin' },
    select: { id: true, email: true }
  });
  const agent = await prisma.user.create({
    data: { email: uniqueEmail('claude'), name: 'Claude', kind: 'AGENT' },
    select: { id: true, email: true }
  });

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
      { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
    ]
  });

  return { workspace, admin, agent };
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@${EMAIL_DOMAIN}`.toLowerCase();
}
