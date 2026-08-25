import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config';
import { mintAgentCredentialToken } from '../services/agent-credential';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import { appendSupportCaseSyncEvent } from '../services/support-sync';
import { registerSupportQualityRoutes } from './support-quality';
import { registerSupportRoutes } from './support';

const EMAIL_DOMAIN = 'support-security.test';
const cleanupWorkspaceIds: string[] = [];
const originalSupportDataSecret = config.TASKARA_SUPPORT_DATA_SECRET;
let app: FastifyInstance;

describe('Support assignment-scoped security regressions', () => {
  beforeAll(async () => {
    if (!config.TASKARA_SUPPORT_DATA_SECRET) {
      config.TASKARA_SUPPORT_DATA_SECRET = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    }
    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.code(400).send({ message: 'Validation failed', issues: error.issues });
      }
      const message = errorMessage(error);
      return reply.code(statusCodeFromError(error, message)).send({
        message,
        ...(error instanceof HttpError ? error.details : undefined)
      });
    });
    await app.register(registerSupportRoutes);
    await app.register(registerSupportQualityRoutes);
    await app.ready();
  });

  afterEach(async () => {
    const workspaceIds = cleanupWorkspaceIds.splice(0);
    if (workspaceIds.length) {
      await prisma.notification.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.supportCase.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
    config.TASKARA_SUPPORT_DATA_SECRET = originalSupportDataSecret;
  });

  test('known peer contact ids cannot be attached to a readable Case, and callback owners need Case access', async () => {
    const fixture = await createFixture();
    const actorHeaders = humanHeaders(fixture, fixture.memberA.email);
    const startedAt = new Date().toISOString();

    const interaction = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.id}/interactions`,
      headers: actorHeaders,
      payload: {
        kind: 'NOTE',
        visibility: 'INTERNAL',
        channel: 'MANUAL',
        direction: 'INTERNAL',
        contactId: fixture.peerContact.id,
        baseVersion: fixture.ownCase.version
      }
    });
    const call = await app.inject({
      method: 'POST',
      url: '/support/calls',
      headers: actorHeaders,
      payload: {
        caseId: fixture.ownCase.id,
        baseVersion: fixture.ownCase.version,
        contactId: fixture.peerContact.id,
        summary: 'A guessed contact id must not become a lookup capability.',
        call: {
          direction: 'INBOUND',
          disposition: 'ANSWERED',
          startedAt,
          recordingConsent: 'UNKNOWN',
          recordingExists: false
        }
      }
    });
    const inaccessibleCallback = await app.inject({
      method: 'POST',
      url: '/support/calls',
      headers: actorHeaders,
      payload: {
        caseId: fixture.ownCase.id,
        baseVersion: fixture.ownCase.version,
        summary: 'The callback owner must be able to open this Case.',
        call: {
          direction: 'OUTBOUND',
          disposition: 'ANSWERED',
          startedAt,
          recordingConsent: 'UNKNOWN',
          recordingExists: false,
          callbackOwnerId: fixture.noAccess.id,
          callbackDueAt: new Date(Date.now() + 60_000).toISOString()
        }
      }
    });

    expect(interaction.statusCode).toBe(400);
    expect(call.statusCode).toBe(400);
    expect(inaccessibleCallback.statusCode).toBe(400);
    expect(await prisma.supportInteraction.count({ where: { caseId: fixture.ownCase.id } })).toBe(0);
    expect(JSON.stringify([interaction.json(), call.json(), inaccessibleCallback.json()]))
      .not.toContain(fixture.peerContact.email);
  });

  test('CONFIGURE credentials cannot inspect or mutate Department membership', async () => {
    const fixture = await createFixture();
    const credentialHeaders = agentHeaders(fixture);
    const memberUrl = `/support/departments/${fixture.department.id}/members/${fixture.memberA.id}`;
    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/support/departments/${fixture.department.id}/members`,
        headers: credentialHeaders
      }),
      app.inject({
        method: 'POST',
        url: `/support/departments/${fixture.department.id}/members`,
        headers: credentialHeaders,
        payload: { userId: fixture.noAccess.id, role: 'MEMBER' }
      }),
      app.inject({ method: 'PATCH', url: memberUrl, headers: credentialHeaders, payload: { role: 'MANAGER' } }),
      app.inject({ method: 'PATCH', url: memberUrl, headers: credentialHeaders, payload: { active: false } }),
      app.inject({ method: 'DELETE', url: memberUrl, headers: credentialHeaders })
    ]);

    expect(responses[0].statusCode).toBe(404);
    expect(responses.slice(1).map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
    expect(await prisma.departmentMember.findUniqueOrThrow({
      where: { id: fixture.memberAMembership.id },
      select: { role: true, active: true }
    })).toEqual({ role: 'MEMBER', active: true });
    expect(await prisma.departmentMember.count({
      where: { workspaceId: fixture.workspace.id, userId: fixture.noAccess.id }
    })).toBe(0);
  });

  test('routing internals are visible only to configuration actors', async () => {
    const fixture = await createFixture();
    const [memberList, memberBootstrap, ownerList] = await Promise.all([
      injectHuman(fixture, fixture.memberA.email, { method: 'GET', url: '/support/departments' }),
      injectHuman(fixture, fixture.memberA.email, { method: 'GET', url: '/support/sync/bootstrap' }),
      injectHuman(fixture, fixture.owner.email, { method: 'GET', url: '/support/departments' })
    ]);

    expect(memberList.statusCode).toBe(200);
    expect(memberBootstrap.statusCode).toBe(200);
    expect(ownerList.statusCode).toBe(200);
    expect(memberList.json().items[0]).not.toHaveProperty('routingSettings');
    expect(memberBootstrap.json().departments[0]).not.toHaveProperty('routingSettings');
    expect(ownerList.json().items.find((item: { id: string }) => item.id === fixture.department.id))
      .toHaveProperty('routingSettings.secretWeight', 37);
    expect(JSON.stringify([memberList.json(), memberBootstrap.json()])).not.toContain('secretWeight');
  });

  test('credential actors cannot hold a long-lived Support SSE stream', async () => {
    const fixture = await createFixture();
    const response = await app.inject({
      method: 'GET',
      url: '/support/sync/stream',
      headers: agentHeaders(fixture)
    });
    expect(response.statusCode).toBe(403);
  });

  test('a duplicate link exposes its canonical projection only when the canonical Case is independently readable', async () => {
    const fixture = await createFixture();
    const hidden = await injectHuman(fixture, fixture.memberA.email, {
      method: 'GET',
      url: `/support/cases/${fixture.duplicateCase.id}`
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toMatchObject({
      id: fixture.duplicateCase.id,
      duplicateOfCaseId: null,
      duplicateOf: null,
      duplicateOfRedacted: true
    });
    expect(JSON.stringify(hidden.json())).not.toContain(fixture.peerCase.id);
    expect(JSON.stringify(hidden.json())).not.toContain(fixture.peerCase.key);
    expect(JSON.stringify(hidden.json())).not.toContain(fixture.peerCase.title);

    await prisma.supportCase.update({
      where: { id: fixture.peerCase.id },
      data: { assigneeMembershipId: fixture.memberAMembership.id }
    });
    const readable = await injectHuman(fixture, fixture.memberA.email, {
      method: 'GET',
      url: `/support/cases/${fixture.duplicateCase.id}`
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.json()).toMatchObject({
      duplicateOfCaseId: fixture.peerCase.id,
      duplicateOfRedacted: false,
      duplicateOf: {
        id: fixture.peerCase.id,
        key: fixture.peerCase.key,
        title: fixture.peerCase.title,
        status: fixture.peerCase.status
      }
    });
  });

  test('a persisted assistance target does not remain a capability after its Case leaves scope', async () => {
    const fixture = await createFixture();
    await prisma.supportCase.update({
      where: { id: fixture.peerCase.id },
      data: { assigneeMembershipId: fixture.memberAMembership.id }
    });
    const created = await injectHuman(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.id}/assistance`,
      payload: {
        kind: 'DUPLICATE',
        payload: { caseId: fixture.peerCase.id },
        provider: 'security-regression',
        modelOrRule: 'duplicate-candidate',
        version: '1',
        confidence: 0.9,
        contextDigest: 'a'.repeat(64)
      }
    });
    expect(created.statusCode).toBe(201);

    await prisma.supportCase.update({
      where: { id: fixture.peerCase.id },
      data: { assigneeMembershipId: fixture.memberBMembership.id }
    });
    const [listed, rejected] = await Promise.all([
      injectHuman(fixture, fixture.memberA.email, {
        method: 'GET',
        url: `/support/cases/${fixture.ownCase.id}/assistance`
      }),
      injectHuman(fixture, fixture.memberA.email, {
        method: 'POST',
        url: `/support/assistance/${created.json().id}/decide`,
        payload: { decision: 'REJECTED', reason: 'Target must be re-authorized.' }
      })
    ]);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    expect(rejected.statusCode).toBe(404);
    expect(JSON.stringify([listed.json(), rejected.json()])).not.toContain(fixture.peerCase.id);
    expect(await prisma.supportAssistanceSuggestion.findUniqueOrThrow({
      where: { id: created.json().id },
      select: { decision: true }
    })).toEqual({ decision: 'PENDING' });
  });

  test('sync continuation is derived from authorized projections, not peer event volume', async () => {
    const fixture = await createFixture();
    const bootstrap = await injectHuman(fixture, fixture.memberA.email, {
      method: 'GET',
      url: '/support/sync/bootstrap'
    });
    expect(bootstrap.statusCode).toBe(200);

    await prisma.$transaction((tx) => appendSupportCaseSyncEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.peerCase.id,
      caseVersion: fixture.peerCase.version,
      operation: 'upsert',
      actorId: fixture.memberB.id
    }));
    const peerOnly = await injectHuman(fixture, fixture.memberA.email, {
      method: 'GET',
      url: `/support/sync/pull?limit=1&accessEpoch=${bootstrap.json().accessEpoch}`
        + `&cursor=${encodeURIComponent(bootstrap.json().cursor)}`
    });
    expect(peerOnly.statusCode).toBe(200);
    expect(peerOnly.json()).toMatchObject({ events: [], hasMore: false });
    expect(JSON.stringify(peerOnly.json())).not.toContain(fixture.peerCase.id);

    await prisma.$transaction((tx) => appendSupportCaseSyncEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.ownCase.id,
      caseVersion: fixture.ownCase.version,
      operation: 'upsert',
      actorId: fixture.memberA.id
    }));
    const own = await injectHuman(fixture, fixture.memberA.email, {
      method: 'GET',
      url: `/support/sync/pull?limit=1&accessEpoch=${peerOnly.json().accessEpoch}`
        + `&cursor=${encodeURIComponent(peerOnly.json().cursor)}`
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      hasMore: false,
      events: [{ entityType: 'support_case', entityId: fixture.ownCase.id }]
    });
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [owner, memberA, memberB, noAccess] = await Promise.all(
    ['owner', 'member-a', 'member-b', 'no-access'].map((name) => prisma.user.create({
      data: { email: `${name}-${suffix}@${EMAIL_DOMAIN}`, name }
    }))
  );
  const agent = await prisma.user.create({
    data: {
      email: `agent-${suffix}@${EMAIL_DOMAIN}`,
      name: 'Support configuration agent',
      kind: 'AGENT',
      operatorId: owner.id
    }
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'Support security', slug: `support-security-${suffix}`, mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'SSEC', nextCaseNumber: 4 }
  });
  await prisma.workspaceMember.createMany({
    data: [owner, memberA, memberB, noAccess, agent].map((user) => ({
      workspaceId: workspace.id,
      userId: user.id,
      role: user.id === owner.id || user.id === agent.id ? 'OWNER' : 'MEMBER'
    }))
  });
  const [department, otherDepartment] = await Promise.all([
    prisma.department.create({
      data: {
        workspaceId: workspace.id,
        name: 'Primary',
        slug: 'primary',
        routingSettings: { secretWeight: 37, strategy: 'least-loaded' }
      }
    }),
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Other', slug: 'other' }
    })
  ]);
  const [memberAMembership, memberBMembership] = await Promise.all([
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberA.id, role: 'MEMBER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberB.id, role: 'MEMBER' }
    })
  ]);
  const [ownContact, peerContact] = await Promise.all([
    prisma.supportContact.create({
      data: { workspaceId: workspace.id, name: 'Own contact', email: `own-${suffix}@example.test` }
    }),
    prisma.supportContact.create({
      data: { workspaceId: workspace.id, name: 'Peer contact', email: `peer-secret-${suffix}@example.test` }
    })
  ]);
  const [ownCase, peerCase] = await Promise.all([
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 1,
        key: 'SSEC-1',
        title: 'Own readable Case',
        sourceChannel: 'MANUAL',
        typeKey: 'request',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberAMembership.id,
        contactId: ownContact.id
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 2,
        key: 'SSEC-2',
        title: `Peer canonical secret ${suffix}`,
        sourceChannel: 'CALL',
        typeKey: 'incident',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberBMembership.id,
        contactId: peerContact.id
      }
    })
  ]);
  const duplicateTimestamp = new Date();
  const duplicateCase = await prisma.supportCase.create({
    data: {
      workspaceId: workspace.id,
      sequence: 3,
      key: 'SSEC-3',
      title: 'Readable duplicate child',
      sourceChannel: 'MANUAL',
      typeKey: 'request',
      status: 'RESOLVED',
      departmentId: department.id,
      assigneeMembershipId: memberAMembership.id,
      duplicateOfCaseId: peerCase.id,
      resolutionCode: 'DUPLICATE',
      resolutionSummary: 'Tracked against the canonical Case.',
      receivedAt: duplicateTimestamp,
      lastMeaningfulActivityAt: duplicateTimestamp,
      resolvedAt: duplicateTimestamp
    }
  });
  const minted = mintAgentCredentialToken();
  const credential = await prisma.agentCredential.create({
    data: {
      workspaceId: workspace.id,
      userId: agent.id,
      name: 'Support CONFIGURE test',
      lookupId: minted.lookupId,
      tokenHash: minted.tokenHash,
      scope: 'READ_WRITE'
    }
  });
  await prisma.supportCredentialGrant.create({
    data: { workspaceId: workspace.id, credentialId: credential.id, scope: 'CONFIGURE' }
  });

  return {
    workspace,
    owner,
    memberA,
    memberB,
    noAccess,
    agent: { ...agent, token: minted.token },
    department,
    otherDepartment,
    memberAMembership,
    memberBMembership,
    ownContact,
    peerContact,
    ownCase,
    peerCase,
    duplicateCase
  };
}

function humanHeaders(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  email: string
): Record<string, string> {
  return { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': email };
}

function agentHeaders(fixture: Awaited<ReturnType<typeof createFixture>>): Record<string, string> {
  return {
    'x-workspace-slug': fixture.workspace.slug,
    authorization: `Bearer ${fixture.agent.token}`
  };
}

function injectHuman(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  email: string,
  options: Omit<InjectOptions, 'headers'>
) {
  return app.inject({ ...options, headers: humanHeaders(fixture, email) });
}
