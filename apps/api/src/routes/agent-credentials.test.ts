import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];

const EMAIL_DOMAIN = 'agent-credential-routes.test';

describe('agent credential routes', () => {
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

  describe('issuing', () => {
    test('returns the plaintext exactly once and stores only a hash of it', async () => {
      const fixture = await createFixture();

      const created = await injectAs(fixture, 'admin', {
        method: 'POST',
        url: '/agent-credentials',
        payload: { userId: fixture.agent.id, name: 'Claude Code laptop' }
      });

      expect(created.statusCode).toBe(201);
      const token = created.json().token as string;
      expect(token).toMatch(/^tka_[0-9a-f]{24}_[A-Za-z0-9_-]{43}$/);

      // The plaintext is never recoverable afterwards: not from the list, not from the row.
      const listed = await injectAs(fixture, 'admin', { method: 'GET', url: '/agent-credentials' });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toHaveLength(1);
      expect(listed.json().items[0]).not.toHaveProperty('token');
      expect(listed.json().items[0].tokenHash).toBeUndefined();
      expect(JSON.stringify(listed.json())).not.toContain(token);

      const stored = await prisma.agentCredential.findUniqueOrThrow({
        where: { id: created.json().id }
      });
      // Independent source of truth for the expected hash: recomputed here, not read back.
      expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('base64url'));
      expect(JSON.stringify(stored)).not.toContain(secretOf(token));
    });

    test('mints a different secret every time', async () => {
      const fixture = await createFixture();

      const first = await issue(fixture, { name: 'one' });
      const second = await issue(fixture, { name: 'two' });

      expect(first.token).not.toBe(second.token);
      expect(lookupOf(first.token)).not.toBe(lookupOf(second.token));
    });

    test('refuses to issue a credential for a human user', async () => {
      const fixture = await createFixture();

      const response = await injectAs(fixture, 'admin', {
        method: 'POST',
        url: '/agent-credentials',
        payload: { userId: fixture.operator.id, name: 'Human key' }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('Only an agent user can hold an agent credential');
      expect(await prisma.agentCredential.count({ where: { userId: fixture.operator.id } })).toBe(0);
    });

    test('refuses to issue a credential for an agent outside this workspace', async () => {
      const fixture = await createFixture();
      const outsider = await createOutsideAgent();

      const response = await injectAs(fixture, 'admin', {
        method: 'POST',
        url: '/agent-credentials',
        payload: { userId: outsider.id, name: 'Foreign agent key' }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('Agent must be a member of this workspace');
      expect(await prisma.agentCredential.count({ where: { userId: outsider.id } })).toBe(0);
    });

    test('is refused to a non-admin member', async () => {
      const fixture = await createFixture();

      const response = await injectAs(fixture, 'operator', {
        method: 'POST',
        url: '/agent-credentials',
        payload: { userId: fixture.agent.id, name: 'Self-issued' }
      });

      expect(response.statusCode).toBe(403);
      expect(await prisma.agentCredential.count({ where: { userId: fixture.agent.id } })).toBe(0);
    });
  });

  describe('authenticating', () => {
    test('resolves to the agent user, in its workspace, with agent provenance', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture);

      const response = await injectWithToken(fixture, token, { method: 'GET', url: '/users' });

      expect(response.statusCode).toBe(200);

      const created = await injectWithToken(fixture, token, {
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Agent-authored task', projectId: fixture.project.id }
      });
      expect(created.statusCode).toBe(201);

      const task = await prisma.task.findUniqueOrThrow({
        where: { id: created.json().id },
        select: { reporterId: true }
      });
      expect(task.reporterId).toBe(fixture.agent.id);

      const activity = await prisma.activityLog.findFirstOrThrow({
        where: { workspaceId: fixture.workspace.id, entityId: created.json().id },
        orderBy: { createdAt: 'desc' }
      });
      expect(activity.actorId).toBe(fixture.agent.id);
      expect(activity.actorType).toBe('AGENT');

      // `source` is asserted on an update, not on the create above: `createTask` writes the
      // client-supplied `input.source` (default 'API') rather than the actor's, which is the
      // provenance gap "Make agent authorship provable" owns. The update path already reads
      // `actor.source`, so it shows what this credential actually resolves to.
      const updated = await injectWithToken(fixture, token, {
        method: 'PATCH',
        url: `/tasks/${created.json().id}`,
        payload: { title: 'Agent-edited task' }
      });
      expect(updated.statusCode).toBe(200);

      const updateActivity = await prisma.activityLog.findFirstOrThrow({
        where: { workspaceId: fixture.workspace.id, entityId: created.json().id, action: 'updated' }
      });
      expect(updateActivity.actorType).toBe('AGENT');
      expect(updateActivity.source).toBe('AGENT');
    });

    test('ignores a client-supplied actor type', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture);

      const created = await injectWithToken(
        fixture,
        token,
        { method: 'POST', url: '/tasks', payload: { title: 'Claimed human', projectId: fixture.project.id } },
        { 'x-actor-type': 'USER' }
      );
      expect(created.statusCode).toBe(201);

      const activity = await prisma.activityLog.findFirstOrThrow({
        where: { workspaceId: fixture.workspace.id, entityId: created.json().id }
      });
      expect(activity.actorType).toBe('AGENT');
    });

    test('records last use without ever storing the plaintext', async () => {
      const fixture = await createFixture();
      const { id, token } = await issue(fixture);

      expect((await prisma.agentCredential.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeNull();
      await injectWithToken(fixture, token, { method: 'GET', url: '/users' });

      const used = await prisma.agentCredential.findUniqueOrThrow({ where: { id } });
      expect(used.lastUsedAt).not.toBeNull();
    });

    test('rejects a token whose secret is wrong but whose lookup id is real', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture);
      const forged = `tka_${lookupOf(token)}_${'A'.repeat(43)}`;

      const response = await injectWithToken(fixture, forged, { method: 'GET', url: '/users' });

      expect(response.statusCode).toBe(401);
      expect(response.json().message).toBe('Invalid agent credential');
    });

    // Guards the comparison itself. A prefix check, a truncated compare, or a `startsWith` would
    // all accept at least one of these; only a full-length equality rejects them all.
    test('rejects a secret that is a near miss for the real one', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture);
      const secret = secretOf(token);
      const lookup = lookupOf(token);

      const lastCharChanged = `${secret.slice(0, -1)}${secret.at(-1) === 'A' ? 'B' : 'A'}`;
      const firstCharChanged = `${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;

      for (const candidate of [lastCharChanged, firstCharChanged]) {
        const response = await injectWithToken(fixture, `tka_${lookup}_${candidate}`, {
          method: 'GET',
          url: '/users'
        });
        expect(response.statusCode).toBe(401);
      }

      // The genuine article still works, so the test above is not passing because everything fails.
      expect((await injectWithToken(fixture, token, { method: 'GET', url: '/users' })).statusCode).toBe(200);
    });

    // The secret is compared in constant time, which no test in this suite can observe directly.
    // What is observable, and what this pins, is that the *answer* carries no information either:
    // a real lookup id with a wrong secret and a lookup id that matches nothing are the same reply.
    test('answers a wrong secret and an unknown credential identically', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture);

      const wrongSecret = await injectWithToken(fixture, `tka_${lookupOf(token)}_${'A'.repeat(43)}`, {
        method: 'GET',
        url: '/users'
      });
      const unknown = await injectWithToken(fixture, `tka_${'0'.repeat(24)}_${'A'.repeat(43)}`, {
        method: 'GET',
        url: '/users'
      });

      expect(wrongSecret.statusCode).toBe(unknown.statusCode);
      expect(wrongSecret.json()).toEqual(unknown.json());
    });

    test('rejects an unknown, malformed or empty token', async () => {
      const fixture = await createFixture();

      for (const candidate of [
        `tka_${'0'.repeat(24)}_${'A'.repeat(43)}`,
        'tka_not-hex_secret',
        'tka__',
        'tka_'
      ]) {
        const response = await injectWithToken(fixture, candidate, { method: 'GET', url: '/users' });
        expect(response.statusCode).toBe(401);
      }
    });

    test('does not fall back to the email header when the token is bad', async () => {
      const fixture = await createFixture();
      const forged = `tka_${'0'.repeat(24)}_${'A'.repeat(43)}`;

      const response = await app.inject({
        method: 'GET',
        url: '/users',
        headers: {
          'x-workspace-slug': fixture.workspace.slug,
          'x-user-email': fixture.admin.email,
          authorization: `Bearer ${forged}`
        }
      });

      expect(response.statusCode).toBe(401);
    });

    test('is refused in a workspace it was not issued for', async () => {
      const fixture = await createFixture();
      const other = await createFixture();
      const { token } = await issue(fixture);

      const response = await app.inject({
        method: 'GET',
        url: '/users',
        headers: { 'x-workspace-slug': other.workspace.slug, authorization: `Bearer ${token}` }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('Agent credential is not valid for this workspace');
    });

    test('stops working the moment the agent leaves the workspace', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture);
      expect((await injectWithToken(fixture, token, { method: 'GET', url: '/users' })).statusCode).toBe(200);

      await prisma.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId: fixture.workspace.id, userId: fixture.agent.id } }
      });

      const response = await injectWithToken(fixture, token, { method: 'GET', url: '/users' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('revoking', () => {
    test('rejects the token on the very next request', async () => {
      const fixture = await createFixture();
      const { id, token } = await issue(fixture);
      expect((await injectWithToken(fixture, token, { method: 'GET', url: '/users' })).statusCode).toBe(200);

      const revoked = await injectAs(fixture, 'admin', { method: 'DELETE', url: `/agent-credentials/${id}` });
      expect(revoked.statusCode).toBe(204);

      const after = await injectWithToken(fixture, token, { method: 'GET', url: '/users' });
      expect(after.statusCode).toBe(401);
      expect(after.json().message).toBe('Agent credential has been revoked');
    });

    test('keeps the row so the audit trail survives, and is idempotent', async () => {
      const fixture = await createFixture();
      const { id } = await issue(fixture);

      await injectAs(fixture, 'admin', { method: 'DELETE', url: `/agent-credentials/${id}` });
      const first = await prisma.agentCredential.findUniqueOrThrow({ where: { id } });
      expect(first.revokedAt).not.toBeNull();

      const again = await injectAs(fixture, 'admin', { method: 'DELETE', url: `/agent-credentials/${id}` });
      expect(again.statusCode).toBe(204);
      const second = await prisma.agentCredential.findUniqueOrThrow({ where: { id } });
      expect(second.revokedAt).toEqual(first.revokedAt);
    });

    test('is refused to a non-admin member', async () => {
      const fixture = await createFixture();
      const { id, token } = await issue(fixture);

      const response = await injectAs(fixture, 'operator', {
        method: 'DELETE',
        url: `/agent-credentials/${id}`
      });

      expect(response.statusCode).toBe(403);
      expect((await injectWithToken(fixture, token, { method: 'GET', url: '/users' })).statusCode).toBe(200);
    });

    test('cannot be revoked from another workspace', async () => {
      const fixture = await createFixture();
      const other = await createFixture();
      const { id, token } = await issue(fixture);

      const response = await injectAs(other, 'admin', { method: 'DELETE', url: `/agent-credentials/${id}` });

      expect(response.statusCode).toBe(404);
      expect((await injectWithToken(fixture, token, { method: 'GET', url: '/users' })).statusCode).toBe(200);
    });
  });

  describe('rotating', () => {
    test('issues a new secret and kills the old one immediately', async () => {
      const fixture = await createFixture();
      const { id, token: original } = await issue(fixture);

      const rotated = await injectAs(fixture, 'admin', {
        method: 'POST',
        url: `/agent-credentials/${id}/rotate`
      });

      expect(rotated.statusCode).toBe(200);
      const replacement = rotated.json().token as string;
      expect(replacement).not.toBe(original);

      expect((await injectWithToken(fixture, original, { method: 'GET', url: '/users' })).statusCode).toBe(401);
      expect((await injectWithToken(fixture, replacement, { method: 'GET', url: '/users' })).statusCode).toBe(200);
    });

    test('keeps the credential identity, name and scope', async () => {
      const fixture = await createFixture();
      const { id } = await issue(fixture, { name: 'Nightly triage', scope: 'READ_ONLY' });

      const rotated = await injectAs(fixture, 'admin', {
        method: 'POST',
        url: `/agent-credentials/${id}/rotate`
      });

      expect(rotated.json().id).toBe(id);
      expect(rotated.json().name).toBe('Nightly triage');
      expect(rotated.json().scope).toBe('READ_ONLY');
      expect(rotated.json().rotatedAt).not.toBeNull();
    });

    test('refuses to rotate a revoked credential', async () => {
      const fixture = await createFixture();
      const { id } = await issue(fixture);
      await injectAs(fixture, 'admin', { method: 'DELETE', url: `/agent-credentials/${id}` });

      const response = await injectAs(fixture, 'admin', {
        method: 'POST',
        url: `/agent-credentials/${id}/rotate`
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('Agent credential has been revoked');
    });
  });

  describe('expiry', () => {
    test('never expires by default', async () => {
      const fixture = await createFixture();
      const { id } = await issue(fixture);

      expect((await prisma.agentCredential.findUniqueOrThrow({ where: { id } })).expiresAt).toBeNull();
    });

    test('rejects the token once an explicit expiry has passed', async () => {
      const fixture = await createFixture();
      const { id, token } = await issue(fixture);
      await prisma.agentCredential.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });

      const response = await injectWithToken(fixture, token, { method: 'GET', url: '/users' });

      expect(response.statusCode).toBe(401);
      expect(response.json().message).toBe('Agent credential has expired');
    });
  });

  describe('scope', () => {
    test('a read-only credential may read but not write', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture, { scope: 'READ_ONLY' });

      expect((await injectWithToken(fixture, token, { method: 'GET', url: '/users' })).statusCode).toBe(200);

      const write = await injectWithToken(fixture, token, {
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Should not land', projectId: fixture.project.id }
      });
      expect(write.statusCode).toBe(403);
      expect(write.json().message).toBe('This agent credential is read-only');
      expect(await prisma.task.count({ where: { title: 'Should not land' } })).toBe(0);
    });

    test('a read-write credential may write', async () => {
      const fixture = await createFixture();
      const { token } = await issue(fixture, { scope: 'READ_WRITE' });

      const write = await injectWithToken(fixture, token, {
        method: 'POST',
        url: '/tasks',
        payload: { title: 'Should land', projectId: fixture.project.id }
      });

      expect(write.statusCode).toBe(201);
    });

    test('no credential may administer identity, whatever role its agent holds', async () => {
      const fixture = await createFixture();
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: fixture.workspace.id, userId: fixture.agent.id } },
        data: { role: 'OWNER' }
      });
      const { token } = await issue(fixture, { scope: 'READ_WRITE' });

      const escalation = await injectWithToken(fixture, token, {
        method: 'POST',
        url: '/users',
        payload: { email: `smuggled-${Date.now()}@${EMAIL_DOMAIN}`, name: 'Smuggled owner', role: 'OWNER' }
      });

      expect(escalation.statusCode).toBe(403);
      expect(escalation.json().message).toBe('An agent credential cannot administer this workspace');
      expect(await prisma.user.count({ where: { name: 'Smuggled owner' } })).toBe(0);
    });

    test('no credential may mint or revoke another credential', async () => {
      const fixture = await createFixture();
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: fixture.workspace.id, userId: fixture.agent.id } },
        data: { role: 'OWNER' }
      });
      const { id, token } = await issue(fixture);

      const mint = await injectWithToken(fixture, token, {
        method: 'POST',
        url: '/agent-credentials',
        payload: { userId: fixture.agent.id, name: 'Self-perpetuating' }
      });
      expect(mint.statusCode).toBe(403);

      const rotate = await injectWithToken(fixture, token, {
        method: 'POST',
        url: `/agent-credentials/${id}/rotate`
      });
      expect(rotate.statusCode).toBe(403);

      const revoke = await injectWithToken(fixture, token, { method: 'DELETE', url: `/agent-credentials/${id}` });
      expect(revoke.statusCode).toBe(403);

      expect(await prisma.agentCredential.count({ where: { userId: fixture.agent.id } })).toBe(1);
      expect((await prisma.agentCredential.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
    });
  });
});

type Persona = 'admin' | 'operator';

interface Fixture {
  workspace: { id: string; slug: string };
  admin: { id: string; email: string };
  operator: { id: string; email: string };
  agent: { id: string; email: string };
  project: { id: string };
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `Agent cred ${suffix}`, slug: `agent-cred-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 48) },
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
    data: { email: uniqueEmail('agent'), name: 'Claude', kind: 'AGENT', operatorId: operator.id },
    select: { id: true, email: true }
  });

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
      { workspaceId: workspace.id, userId: operator.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
    ]
  });

  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: `Project ${suffix}`, keyPrefix: projectKey(suffix) },
    select: { id: true }
  });

  return { workspace, admin, operator, agent, project };
}

async function createOutsideAgent(): Promise<{ id: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `Foreign ${suffix}`, slug: `foreign-agent-cred-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 48) },
    select: { id: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const user = await prisma.user.create({
    data: { email: uniqueEmail('outsider-agent'), name: 'Outsider', kind: 'AGENT' },
    select: { id: true }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'MEMBER' }
  });
  return user;
}

async function issue(
  fixture: Fixture,
  overrides: { name?: string; scope?: 'READ_ONLY' | 'READ_WRITE' } = {}
): Promise<{ id: string; token: string }> {
  const response = await injectAs(fixture, 'admin', {
    method: 'POST',
    url: '/agent-credentials',
    payload: { userId: fixture.agent.id, name: overrides.name ?? 'Test key', ...(overrides.scope ? { scope: overrides.scope } : {}) }
  });
  if (response.statusCode !== 201) throw new Error(`issue failed: ${response.statusCode} ${response.body}`);
  return { id: response.json().id, token: response.json().token };
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

async function injectWithToken(
  fixture: Fixture,
  token: string,
  options: InjectOptions,
  extraHeaders: Record<string, string> = {}
) {
  return app.inject({
    ...options,
    headers: {
      'x-workspace-slug': fixture.workspace.slug,
      authorization: `Bearer ${token}`,
      ...extraHeaders,
      ...(options.headers || {})
    }
  });
}

function lookupOf(token: string): string {
  return token.split('_')[1] ?? '';
}

function secretOf(token: string): string {
  return token.split('_').slice(2).join('_');
}

function projectKey(suffix: string): string {
  return `AC${suffix.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`;
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@${EMAIL_DOMAIN}`.toLowerCase();
}
