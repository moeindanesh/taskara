import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { registerApp } from '../app';
import { supportIntakeSignature } from '../services/support-intake';

process.env.TASKARA_SUPPORT_DATA_SECRET ??= 'taskara-test-only-support-encryption-key-0001';
process.env.TASKARA_SUPPORT_INTAKE_WORKER_ENABLED ??= 'false';

const EMAIL_DOMAIN = 'support-intake-route.test';
let app: FastifyInstance;
let fixture: Awaited<ReturnType<typeof createFixture>>;

describe('Support intake HTTP boundary', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({
      where: { id: { in: [fixture.supportWorkspace.id, fixture.teamWorkspace.id] } }
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
    await app.close();
  });

  test('admin creates a scoped secret once while Team mode is refused', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/support/intake-connectors',
      headers: sessionHeaders(fixture.supportWorkspace.slug),
      payload: {
        name: 'Call API',
        sourceKey: `call-${crypto.randomUUID()}`,
        sourceChannel: 'CALL'
      }
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    expect(created.statusCode).toBe(201);
    expect(created.json().signingSecret).toMatch(/^tks_/);
    expect(created.json().connector).not.toHaveProperty('secretHash');
    expect(created.json().connector).not.toHaveProperty('secretCiphertext');
    fixture.connector = created.json();

    const team = await app.inject({
      method: 'POST',
      url: '/support/intake-connectors',
      headers: sessionHeaders(fixture.teamWorkspace.slug),
      payload: { name: 'Forbidden', sourceKey: 'forbidden', sourceChannel: 'API' }
    });
    expect(team.statusCode).toBe(409);
  });

  test('source endpoint consumes exact bytes without workspace/session headers and returns 202 + status location', async () => {
    const connector = fixture.connector!;
    const raw = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      externalCaseId: 'route-thread-1',
      case: { title: 'تماس از دست رفته', typeKey: 'incident' },
      interaction: { externalId: 'route-call-1', kind: 'CALL', body: 'نیاز به تماس مجدد' },
      call: {
        disposition: 'MISSED',
        startedAt: new Date().toISOString(),
        recordingConsent: 'UNKNOWN',
        recordingExists: false
      }
    }), 'utf8');
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const accepted = await app.inject({
      method: 'POST',
      url: `/support/intake/${connector.connector.lookupId}/events`,
      headers: {
        'content-type': 'application/json',
        'x-taskara-timestamp': timestamp,
        'x-taskara-event-id': 'route-event-1',
        'x-taskara-signature': supportIntakeSignature(connector.signingSecret, timestamp, raw)
      },
      payload: raw
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers.location).toBe(accepted.json().location);
    expect(accepted.json().status).toBe('RECEIVED');

    const status = await app.inject({
      method: 'GET',
      url: accepted.json().location,
      headers: { authorization: `Bearer ${connector.signingSecret}` }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ receiptId: accepted.json().receiptId, status: 'RECEIVED' });
  });

  test('signature failure happens before JSON parsing', async () => {
    const connector = fixture.connector!;
    const invalid = Buffer.from('{not-json', 'utf8');
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const response = await app.inject({
      method: 'POST',
      url: `/support/intake/${connector.connector.lookupId}/events`,
      headers: {
        'content-type': 'application/json',
        'x-taskara-timestamp': timestamp,
        'x-taskara-event-id': 'invalid-signature-before-json',
        'x-taskara-signature': `v1=${'0'.repeat(64)}`
      },
      payload: invalid
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toContain('signature');
  });
});

function sessionHeaders(slug: string) {
  return {
    'x-workspace-slug': slug,
    'x-user-email': fixture.owner.email
  };
}

async function createFixture() {
  const owner = await prisma.user.create({
    data: { email: `owner-${crypto.randomUUID()}@${EMAIL_DOMAIN}`, name: 'Connector Owner' }
  });
  const supportWorkspace = await prisma.workspace.create({
    data: {
      name: 'Support intake route',
      slug: `support-intake-${crypto.randomUUID().slice(0, 12)}`,
      mode: 'SUPPORT',
      users: { create: { userId: owner.id, role: 'OWNER' } }
    }
  });
  const teamWorkspace = await prisma.workspace.create({
    data: {
      name: 'Team intake route',
      slug: `team-intake-${crypto.randomUUID().slice(0, 12)}`,
      mode: 'TEAM',
      users: { create: { userId: owner.id, role: 'OWNER' } }
    }
  });
  return {
    owner,
    supportWorkspace,
    teamWorkspace,
    connector: null as null | {
      signingSecret: string;
      connector: { id: string; lookupId: string };
    }
  };
}
