import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { registerSupportIntakeAdminRoutes } from './support-intake-admin';

const EMAIL_DOMAIN = 'support-intake-admin.test';
const PRIVATE_VALUES = [
  'private-connector-config',
  'private-secret-hash',
  'private-secret-ciphertext',
  'private-event-key',
  'private-idempotency-key',
  'private-payload-hash',
  'private-payload-reference',
  'private-payload-bytes',
  'private-stored-error'
];
const FORBIDDEN_RESPONSE_KEYS = [
  'config',
  'eventKey',
  'idempotencyKey',
  'lastErrorMessage',
  'lookupId',
  'payloadCiphertext',
  'payloadEncryptionKeyId',
  'payloadHash',
  'payloadRef',
  'payloadRetentionUntil',
  'secretCiphertext',
  'secretEncryptionKeyId',
  'secretHash'
];

let app: FastifyInstance;
let fixture: Awaited<ReturnType<typeof createFixture>>;

describe('Support intake administration', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(registerSupportIntakeAdminRoutes);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    const testUsers = await prisma.user.findMany({
      where: { email: { endsWith: `@${EMAIL_DOMAIN}` } },
      select: { workspaces: { select: { workspaceId: true } } }
    });
    const workspaceIds = testUsers.flatMap((user) =>
      user.workspaces.map((membership) => membership.workspaceId)
    );
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
    await app.close();
  });

  test('returns per-connector health without receipt identities or private connector configuration', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/support/intake-admin/health',
      headers: adminHeaders(fixture.supportWorkspace.slug)
    });
    if (response.statusCode !== 200) throw new Error(response.body);
    const body = response.json();

    expect(body.summary).toMatchObject({
      connectorCount: 2,
      activeConnectorCount: 1,
      pendingCount: 1,
      deadLetterCount: 3
    });
    expect(body.items).toHaveLength(2);
    expect(body.items.find((item: { connector: { id: string } }) => item.connector.id === fixture.activeConnector.id))
      .toMatchObject({ pendingCount: 1, deadLetterCount: 3 });
    assertSanitized(body);
  });

  test('paginates dead letters deterministically and sanitizes list and detail errors', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/support/intake-admin/dead-letters?limit=1',
      headers: adminHeaders(fixture.supportWorkspace.slug)
    });
    if (first.statusCode !== 200) throw new Error(first.body);
    expect(first.json().items).toHaveLength(1);
    expect(first.json().items[0].receiptId).toBe(fixture.deadLetters[0].id);
    expect(first.json().nextCursor).toBeString();
    assertSanitized(first.json());

    const second = await app.inject({
      method: 'GET',
      url: `/support/intake-admin/dead-letters?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: adminHeaders(fixture.supportWorkspace.slug)
    });
    if (second.statusCode !== 200) throw new Error(second.body);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().items[0].receiptId).toBe(fixture.deadLetters[1].id);
    expect(second.json().items[0].receiptId).not.toBe(first.json().items[0].receiptId);
    assertSanitized(second.json());

    const detail = await app.inject({
      method: 'GET',
      url: `/support/intake-admin/dead-letters/${fixture.deadLetters[0].id}`,
      headers: adminHeaders(fixture.supportWorkspace.slug)
    });
    if (detail.statusCode !== 200) throw new Error(detail.body);
    expect(detail.json()).toMatchObject({
      receiptId: fixture.deadLetters[0].id,
      status: 'DEAD_LETTER',
      error: {
        code: 'INTAKE_PROCESSING_FAILED',
        message: 'Intake processing failed and will be retried'
      }
    });
    assertSanitized(detail.json());
  });

  test('atomically schedules an available dead letter and refuses one whose payload was purged', async () => {
    const retry = await app.inject({
      method: 'POST',
      url: `/support/intake-admin/dead-letters/${fixture.deadLetters[0].id}/retry`,
      headers: adminHeaders(fixture.supportWorkspace.slug)
    });
    if (retry.statusCode !== 202) throw new Error(retry.body);
    expect(retry.json()).toMatchObject({
      receiptId: fixture.deadLetters[0].id,
      status: 'RETRY_PENDING'
    });
    assertSanitized(retry.json());
    expect(await prisma.supportIntakeReceipt.findUniqueOrThrow({
      where: { id: fixture.deadLetters[0].id },
      select: { status: true, attemptCount: true, deadLetteredAt: true, lastErrorCode: true }
    })).toEqual({
      status: 'RETRY_PENDING',
      attemptCount: 0,
      deadLetteredAt: null,
      lastErrorCode: null
    });

    const unavailable = await app.inject({
      method: 'POST',
      url: `/support/intake-admin/dead-letters/${fixture.deadLetters[2].id}/retry`,
      headers: adminHeaders(fixture.supportWorkspace.slug)
    });
    expect(unavailable.statusCode).toBe(409);
  });

  test('requires a human workspace admin and scopes receipt lookup to the active workspace', async () => {
    const member = await app.inject({
      method: 'GET',
      url: '/support/intake-admin/health',
      headers: {
        'x-workspace-slug': fixture.supportWorkspace.slug,
        'x-user-email': fixture.member.email
      }
    });
    expect(member.statusCode).toBe(403);

    const team = await app.inject({
      method: 'GET',
      url: '/support/intake-admin/health',
      headers: adminHeaders(fixture.teamWorkspace.slug)
    });
    expect(team.statusCode).toBe(409);

    const otherWorkspace = await app.inject({
      method: 'GET',
      url: `/support/intake-admin/dead-letters/${fixture.deadLetters[1].id}`,
      headers: adminHeaders(fixture.otherSupportWorkspace.slug)
    });
    expect(otherWorkspace.statusCode).toBe(404);
  });
});

function adminHeaders(slug: string) {
  return {
    'x-workspace-slug': slug,
    'x-user-email': fixture.owner.email
  };
}

function assertSanitized(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const privateValue of PRIVATE_VALUES) expect(serialized).not.toContain(privateValue);
  const keys = collectKeys(value);
  for (const key of FORBIDDEN_RESPONSE_KEYS) expect(keys).not.toContain(key);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys);
  }
  return keys;
}

async function createFixture() {
  const owner = await prisma.user.create({
    data: { email: `owner-${crypto.randomUUID()}@${EMAIL_DOMAIN}`, name: 'Intake Admin' }
  });
  const member = await prisma.user.create({
    data: { email: `member-${crypto.randomUUID()}@${EMAIL_DOMAIN}`, name: 'Intake Member' }
  });
  const supportWorkspace = await prisma.workspace.create({
    data: {
      name: 'Intake admin Support',
      slug: `intake-admin-${crypto.randomUUID().slice(0, 12)}`,
      mode: 'SUPPORT',
      users: {
        create: [
          { userId: owner.id, role: 'OWNER' },
          { userId: member.id, role: 'MEMBER' }
        ]
      }
    }
  });
  const otherSupportWorkspace = await prisma.workspace.create({
    data: {
      name: 'Other intake Support',
      slug: `other-intake-${crypto.randomUUID().slice(0, 12)}`,
      mode: 'SUPPORT',
      users: { create: { userId: owner.id, role: 'OWNER' } }
    }
  });
  const teamWorkspace = await prisma.workspace.create({
    data: {
      name: 'Intake admin Team',
      slug: `team-intake-admin-${crypto.randomUUID().slice(0, 12)}`,
      mode: 'TEAM',
      users: { create: { userId: owner.id, role: 'OWNER' } }
    }
  });
  const activeConnector = await prisma.supportIntakeConnector.create({
    data: {
      workspaceId: supportWorkspace.id,
      name: 'Active API',
      sourceKey: `active-${crypto.randomUUID()}`,
      sourceChannel: 'API',
      lookupId: `lookup_${crypto.randomUUID()}`,
      secretHash: 'private-secret-hash',
      secretCiphertext: 'private-secret-ciphertext',
      config: { token: 'private-connector-config' }
    }
  });
  await prisma.supportIntakeConnector.create({
    data: {
      workspaceId: supportWorkspace.id,
      name: 'Revoked call source',
      sourceKey: `revoked-${crypto.randomUUID()}`,
      sourceChannel: 'CALL',
      lookupId: `lookup_${crypto.randomUUID()}`,
      secretHash: 'revoked-hash',
      secretCiphertext: 'revoked-ciphertext',
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedById: owner.id
    }
  });

  const base = Date.now() - 10_000;
  const deadLetters: Array<{ id: string }> = [];
  for (let index = 0; index < 3; index += 1) {
    deadLetters.push(await prisma.supportIntakeReceipt.create({
      data: {
        workspaceId: supportWorkspace.id,
        connectorId: activeConnector.id,
        eventKey: `private-event-key-${index}`,
        idempotencyKey: `private-idempotency-key-${index}`,
        payloadHash: `private-payload-hash-${index}`,
        payloadRef: `private-payload-reference-${index}`,
        payloadCiphertext: index === 2
          ? null
          : Uint8Array.from(Buffer.from(`private-payload-bytes-${index}`, 'utf8')),
        status: 'DEAD_LETTER',
        attemptCount: 8,
        lastErrorCode: index === 0 ? 'PRIVATE_STORED_ERROR_CODE' : 'INTAKE_PAYLOAD_INVALID',
        lastErrorMessage: `private-stored-error-${index}`,
        receivedAt: new Date(base + (3 - index) * 1_000),
        deadLetteredAt: new Date(base + (6 - index) * 1_000)
      }
    }));
  }
  await prisma.supportIntakeReceipt.create({
    data: {
      workspaceId: supportWorkspace.id,
      connectorId: activeConnector.id,
      eventKey: 'pending-event',
      payloadHash: 'pending-hash',
      payloadCiphertext: Uint8Array.from([1, 2, 3]),
      status: 'RETRY_PENDING',
      receivedAt: new Date(base)
    }
  });

  return {
    owner,
    member,
    supportWorkspace,
    otherSupportWorkspace,
    teamWorkspace,
    activeConnector,
    deadLetters
  };
}
