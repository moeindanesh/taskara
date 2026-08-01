import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';
import { mintAgentCredentialToken } from './agent-credential';

const HOLDER_CONSTRAINT = 'AgentCredential_holder_is_agent';
const HOLDER_FK = 'AgentCredential_userId_userKind_fkey';
const EMAIL_DOMAIN = 'agent-credential-db.test';

const cleanupWorkspaceIds: string[] = [];

describe('agent credential token', () => {
  // A weak generator is the failure this catches: 400 secrets drawn from a real CSPRNG collide
  // with probability far below anything observable, so a repeat means the source is not one.
  test('mints unguessable, non-repeating secrets', () => {
    const tokens = Array.from({ length: 400 }, () => mintAgentCredentialToken());

    expect(new Set(tokens.map((minted) => minted.token)).size).toBe(400);
    expect(new Set(tokens.map((minted) => minted.lookupId)).size).toBe(400);
    expect(new Set(tokens.map((minted) => minted.tokenHash)).size).toBe(400);

    for (const minted of tokens) {
      expect(lookupOf(minted.token)).toMatch(/^[0-9a-f]{24}$/);
      // 43 base64url characters is 32 bytes -- 256 bits -- of entropy.
      expect(secretOf(minted.token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(minted.tokenHash).not.toContain(secretOf(minted.token));
    }

    // Every position of the secret varies across mints. A generator seeded per-process, or one
    // that padded a short random core, would show a constant column here.
    const secrets = tokens.map((minted) => secretOf(minted.token));
    for (let position = 0; position < 43; position += 1) {
      expect(new Set(secrets.map((secret) => secret[position])).size).toBeGreaterThan(1);
    }
  });
});

describe('agent credential database invariants', () => {
  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    // Only ever removes rows this file created: the domain is unique to it.
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  test('refuses a credential whose holder column claims to be human', async () => {
    const seed = await createSeed();

    const error = await captureError(insertRaw(seed.workspaceId, seed.agentId, 'HUMAN'));

    expect(String(error?.message)).toContain(HOLDER_CONSTRAINT);
  });

  test('refuses a credential pointed at a human user', async () => {
    const seed = await createSeed();

    // Claims AGENT so the CHECK passes; the composite foreign key is what rejects it, because
    // (humanId, 'AGENT') is not a row in User. This is the case that matters: without the
    // composite key a credential could quietly authenticate as a person.
    const error = await captureError(insertRaw(seed.workspaceId, seed.humanId, 'AGENT'));

    expect(String(error?.message)).toContain(HOLDER_FK);
    expect(await prisma.agentCredential.count({ where: { userId: seed.humanId } })).toBe(0);
  });

  test('refuses to demote an agent that still holds a credential', async () => {
    const seed = await createSeed();
    await issueRow(seed.workspaceId, seed.agentId);

    // ON UPDATE CASCADE rewrites the credential's "userKind" to HUMAN, which the CHECK then
    // rejects -- so the demotion fails rather than leaving a live secret on a human account.
    const error = await captureError(
      prisma.user.update({ where: { id: seed.agentId }, data: { kind: 'HUMAN' } })
    );
    expect(String(error?.message)).toContain(HOLDER_CONSTRAINT);

    const raw = await captureError(
      prisma.$executeRawUnsafe(`UPDATE "User" SET "kind" = 'HUMAN' WHERE "id" = $1::uuid`, seed.agentId)
    );
    expect(String(raw?.message)).toContain(HOLDER_CONSTRAINT);

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: seed.agentId }, select: { kind: true } })).kind
    ).toBe('AGENT');
  });

  test('destroys an agent credential with the agent and with the workspace', async () => {
    const byUser = await createSeed();
    await issueRow(byUser.workspaceId, byUser.agentId);
    await prisma.user.delete({ where: { id: byUser.agentId } });
    expect(await prisma.agentCredential.count({ where: { userId: byUser.agentId } })).toBe(0);

    const byWorkspace = await createSeed();
    await issueRow(byWorkspace.workspaceId, byWorkspace.agentId);
    await prisma.workspace.delete({ where: { id: byWorkspace.workspaceId } });
    expect(await prisma.agentCredential.count({ where: { workspaceId: byWorkspace.workspaceId } })).toBe(0);
  });
});

describe('agent credential secrecy in logs', () => {
  let app: FastifyInstance;
  let captured: string[];

  beforeAll(async () => {
    captured = [];
    app = Fastify({
      // Deliberately the most talkative setting available: if any level of this server's logging
      // would ever carry the plaintext, it is visible here.
      logger: {
        level: 'trace',
        stream: {
          write(chunk: string) {
            captured.push(chunk);
          }
        }
      }
    });
    await registerApp(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  test('never writes the plaintext to the log, not even on an error', async () => {
    const seed = await createSeed();
    const adminHeaders = { 'x-workspace-slug': seed.slug, 'x-user-email': seed.adminEmail };

    const created = await app.inject({
      method: 'POST',
      url: '/agent-credentials',
      headers: adminHeaders,
      payload: { userId: seed.agentId, name: 'Logged key' }
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    // A successful call, a rejected call, and a call that raises inside a handler -- the last one
    // reaches `app.log.error(error)` in the shared error handler.
    await app.inject({
      method: 'GET',
      url: '/users',
      headers: { 'x-workspace-slug': seed.slug, authorization: `Bearer ${token}` }
    });
    await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { 'x-workspace-slug': seed.slug, authorization: `Bearer ${token}` },
      payload: { title: 'no project' }
    });
    await app.inject({
      method: 'GET',
      url: '/tasks/not-a-real-task',
      headers: { 'x-workspace-slug': seed.slug, authorization: `Bearer ${token}` }
    });

    const log = captured.join('');
    expect(log.length).toBeGreaterThan(0);
    const secret = token.split('_').slice(2).join('_');
    expect(log).not.toContain(token);
    expect(log).not.toContain(secret);
    expect(log).not.toContain(created.json().tokenHash ?? 'tokenHash-absent-from-response');
  });
});

interface Seed {
  workspaceId: string;
  slug: string;
  agentId: string;
  humanId: string;
  adminEmail: string;
}

async function createSeed(): Promise<Seed> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const slug = `agent-cred-db-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  const workspace = await prisma.workspace.create({
    data: { name: `Agent cred db ${suffix}`, slug },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const admin = await prisma.user.create({
    data: { email: uniqueEmail('admin'), name: 'Admin' },
    select: { id: true, email: true }
  });
  const human = await prisma.user.create({
    data: { email: uniqueEmail('human'), name: 'Human' },
    select: { id: true }
  });
  const agent = await prisma.user.create({
    data: { email: uniqueEmail('agent'), name: 'Agent', kind: 'AGENT' },
    select: { id: true }
  });

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
      { workspaceId: workspace.id, userId: human.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
    ]
  });

  return {
    workspaceId: workspace.id,
    slug: workspace.slug,
    agentId: agent.id,
    humanId: human.id,
    adminEmail: admin.email
  };
}

async function issueRow(workspaceId: string, userId: string) {
  const minted = mintAgentCredentialToken();
  return prisma.agentCredential.create({
    data: { workspaceId, userId, name: 'Row', lookupId: minted.lookupId, tokenHash: minted.tokenHash }
  });
}

function insertRaw(workspaceId: string, userId: string, userKind: 'HUMAN' | 'AGENT') {
  const minted = mintAgentCredentialToken();
  return prisma.$executeRawUnsafe(
    `INSERT INTO "AgentCredential"
       ("id", "workspaceId", "userId", "userKind", "name", "lookupId", "tokenHash", "updatedAt")
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"UserKind", 'Raw', $5, $6, now())`,
    crypto.randomUUID(),
    workspaceId,
    userId,
    userKind,
    minted.lookupId,
    minted.tokenHash
  );
}

async function captureError(promise: Promise<unknown>): Promise<Error | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as Error;
  }
}

function lookupOf(token: string): string {
  return token.split('_')[1] ?? '';
}

// The secret is base64url, whose alphabet contains `_`, so it is everything after the second
// delimiter rather than a single split field.
function secretOf(token: string): string {
  return token.split('_').slice(2).join('_');
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@${EMAIL_DOMAIN}`.toLowerCase();
}
