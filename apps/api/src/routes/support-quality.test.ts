import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import { mintAgentCredentialToken } from '../services/agent-credential';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import { registerSupportQualityRoutes } from './support-quality';

const EMAIL_DOMAIN = 'support-quality.test';
const cleanupWorkspaceIds: string[] = [];
let app: FastifyInstance;

describe('Support assistance, CSAT, and quality', () => {
  beforeAll(async () => {
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
    await app.register(registerSupportQualityRoutes);
    await app.ready();
  });

  afterEach(async () => {
    const workspaceIds = cleanupWorkspaceIds.splice(0);
    if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => { await app.close(); });

  test('persists digest-only immutable provenance and requires a human, versioned accept/reject decision', async () => {
    const fixture = await createFixture({ ownOpen: true });
    const payload = prioritySuggestion('HIGH');
    const created = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/assistance`,
      payload
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      kind: 'PRIORITY',
      payload: { priority: 'HIGH' },
      provenance: {
        provider: 'routing-rules',
        modelOrRule: 'impact-urgency',
        version: '3',
        confidence: 0.91,
        contextDigest: 'a'.repeat(64)
      },
      decision: 'PENDING'
    });
    expect(JSON.stringify(created.json())).not.toContain('privateContext');

    const contextRejected = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/assistance`,
      payload: { ...payload, privateContext: 'must never be copied' }
    });
    expect(contextRejected.statusCode).toBe(400);

    await expect((async () => prisma.supportAssistanceSuggestion.update({
      where: { id: created.json().id },
      data: { provider: 'rewritten-provider' }
    }))()).rejects.toThrow();

    const stale = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/assistance/${created.json().id}/decide`,
      payload: { decision: 'ACCEPTED', reason: 'Human reviewed recommendation', baseVersion: 99 }
    });
    expect(stale.statusCode).toBe(409);

    const accepted = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/assistance/${created.json().id}/decide`,
      payload: {
        decision: 'ACCEPTED',
        reason: 'Human reviewed recommendation',
        baseVersion: fixture.ownCase.version
      }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ decision: 'ACCEPTED', decisionCaseVersion: 2 });
    expect(await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.ownCase.id } }))
      .toMatchObject({ priority: 'HIGH', version: 2 });
    expect(await prisma.supportCaseEvent.count({
      where: { caseId: fixture.ownCase.id, action: 'case.assistance_suggestion_accepted' }
    })).toBe(1);

    const replay = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/assistance/${created.json().id}/decide`,
      payload: { decision: 'REJECTED', reason: 'Changed my mind' }
    });
    expect(replay.statusCode).toBe(409);
    await expect((async () => prisma.supportAssistanceSuggestion.delete({
      where: { id: created.json().id }
    }))()).rejects.toThrow();
    await expect((async () => prisma.supportAssistanceSuggestion.update({
      where: { id: created.json().id },
      data: { createdById: fixture.manager.id }
    }))()).rejects.toThrow();
    await prisma.user.delete({ where: { id: fixture.memberA.id } });
    expect(await prisma.supportAssistanceSuggestion.findUniqueOrThrow({
      where: { id: created.json().id }
    })).toMatchObject({ createdById: null, decidedById: null, decidedByKind: null });
  });

  test('keeps peer suggestions and reviews invisible while managers can complete scored reviews', async () => {
    const fixture = await createFixture();
    const peerSuggestion = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.peerCase.key}/assistance`,
      payload: {
        ...prioritySuggestion('URGENT'),
        kind: 'SUMMARY',
        payload: { text: fixture.peerSecret }
      }
    });
    expect(peerSuggestion.statusCode).toBe(201);

    const peerList = await inject(fixture, fixture.memberA.email, {
      method: 'GET', url: `/support/cases/${fixture.peerCase.key}/assistance`
    });
    expect(peerList.statusCode).toBe(404);
    expect(peerList.body).not.toContain(fixture.peerSecret);

    const rubric = await createRubric(fixture);
    expect(rubric.statusCode).toBe(201);
    const peerReview = await createReview(fixture, fixture.peerCase.id, rubric.json().id, [4, 2]);
    const ownReview = await createReview(fixture, fixture.ownCase.id, rubric.json().id, [5, 4]);
    expect(peerReview.statusCode).toBe(201);
    expect(peerReview.json().score).toBe(68);
    expect(ownReview.statusCode).toBe(201);

    const memberReviews = await inject(fixture, fixture.memberA.email, {
      method: 'GET', url: '/support/quality/reviews'
    });
    expect(memberReviews.statusCode).toBe(200);
    expect(memberReviews.json().items).toHaveLength(1);
    expect(memberReviews.json().items[0].case.id).toBe(fixture.ownCase.id);
    expect(JSON.stringify(memberReviews.json())).not.toContain(fixture.peerCase.id);
    expect(JSON.stringify(memberReviews.json())).not.toContain(fixture.peerSecret);
    expect(memberReviews.json()).not.toHaveProperty('aggregate');

    const managerReviews = await inject(fixture, fixture.manager.email, {
      method: 'GET', url: '/support/quality/reviews'
    });
    expect(managerReviews.statusCode).toBe(200);
    expect(managerReviews.json().items).toHaveLength(2);
  });

  test('uses opaque one-time CSAT tokens and gives identical acknowledgements without Case leakage', async () => {
    const fixture = await createFixture();
    const denied = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.peerCase.key}/csat/invitations`,
      payload: {}
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain(fixture.peerSecret);

    const invitation = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/csat/invitations`,
      payload: { expiresInDays: 7, scaleMin: 1, scaleMax: 5 }
    });
    expect(invitation.statusCode).toBe(201);
    const token = invitation.json().token as string;
    expect(token.startsWith('tcsat_')).toBe(true);
    const stored = await prisma.supportCsatInvitation.findUniqueOrThrow({
      where: { id: invitation.json().id }
    });
    expect(stored.tokenHash).not.toBe(token);

    const invalid = await app.inject({
      method: 'POST', url: '/support/csat/respond', payload: { token: `tcsat_${'x'.repeat(43)}`, score: 5 }
    });
    const valid = await app.inject({
      method: 'POST', url: '/support/csat/respond', payload: { token, score: 5, comment: 'Helpful' }
    });
    const replay = await app.inject({
      method: 'POST', url: '/support/csat/respond', payload: { token, score: 1, comment: 'Overwrite' }
    });
    for (const response of [invalid, valid, replay]) {
      expect(response.statusCode).toBe(202);
      expect(response.json() as unknown).toEqual({ received: true });
      expect(response.body).not.toContain(fixture.ownCase.id);
      expect(response.body).not.toContain(fixture.peerSecret);
    }
    expect(await prisma.supportCsatResponse.findMany({ where: { invitationId: stored.id } }))
      .toEqual([expect.objectContaining({ score: 5, comment: 'Helpful' })]);
  });

  test('lets scoped credentials persist suggestions but never make human decisions or quality reviews', async () => {
    const fixture = await createFixture();
    const credentialHeaders = {
      'x-workspace-slug': fixture.workspace.slug,
      authorization: `Bearer ${fixture.agentToken}`
    };
    const readOnly = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/assistance`,
      headers: credentialHeaders,
      payload: prioritySuggestion('HIGH')
    });
    expect(readOnly.statusCode).toBe(403);

    await prisma.supportCredentialGrant.create({
      data: {
        workspaceId: fixture.workspace.id,
        credentialId: fixture.agentCredentialId,
        scope: 'CASE_WRITE'
      }
    });
    const created = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/assistance`,
      headers: credentialHeaders,
      payload: prioritySuggestion('HIGH')
    });
    expect(created.statusCode).toBe(201);

    const decision = await app.inject({
      method: 'POST',
      url: `/support/assistance/${created.json().id}/decide`,
      headers: credentialHeaders,
      payload: { decision: 'ACCEPTED', reason: 'Agent cannot decide', baseVersion: 1 }
    });
    expect(decision.statusCode).toBe(403);
    const review = await app.inject({
      method: 'GET', url: '/support/quality/reviews', headers: credentialHeaders
    });
    expect(review.statusCode).toBe(403);
  });

  test('transfers through the ownership graph and resets every former audience epoch', async () => {
    const fixture = await createFixture({ ownOpen: true });
    const created = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/assistance`,
      payload: {
        kind: 'DEPARTMENT',
        payload: { departmentId: fixture.secondaryDepartment.id },
        provider: 'routing-rules',
        modelOrRule: 'department-route',
        version: '1',
        confidence: 0.8,
        contextDigest: 'b'.repeat(64)
      }
    });
    expect(created.statusCode).toBe(201);
    const accepted = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/assistance/${created.json().id}/decide`,
      payload: { decision: 'ACCEPTED', reason: 'Manager approved cross-Department transfer', baseVersion: 1 }
    });
    expect(accepted.statusCode).toBe(200);
    expect(await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.ownCase.id } }))
      .toMatchObject({ departmentId: fixture.secondaryDepartment.id, assigneeMembershipId: null, version: 2 });
    expect(await prisma.supportAccessEpoch.findUnique({
      where: { workspaceId_userId: { workspaceId: fixture.workspace.id, userId: fixture.manager.id } }
    })).toMatchObject({ epoch: 2n });
    expect(await prisma.supportAccessEpoch.findUnique({
      where: { workspaceId_userId: { workspaceId: fixture.workspace.id, userId: fixture.memberA.id } }
    })).toMatchObject({ epoch: 2n });
    const sync = await prisma.syncEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, entityType: 'support_case', entityId: fixture.ownCase.id },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect((sync.payload as { removedUserIds: string[] }).removedUserIds.sort())
      .toEqual([fixture.manager.id, fixture.memberA.id].sort());
    const formerManagerRead = await inject(fixture, fixture.manager.email, {
      method: 'GET', url: `/support/cases/${fixture.ownCase.key}/assistance`
    });
    expect(formerManagerRead.statusCode).toBe(404);
  });

  test('canonicalizes knowledge targets and hides suggestions after page access disappears', async () => {
    const fixture = await createFixture({ ownOpen: true });
    const space = await prisma.knowledgeSpace.create({
      data: { workspaceId: fixture.workspace.id, type: 'WORKSPACE', key: 'support-kb', name: 'Support KB' }
    });
    const page = await prisma.knowledgePage.create({
      data: {
        workspaceId: fixture.workspace.id,
        spaceId: space.id,
        slug: 'refunds',
        path: 'refunds',
        title: 'Canonical refund guide',
        content: {},
        contentText: '',
        status: 'PUBLISHED'
      }
    });
    const created = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/assistance`,
      payload: {
        kind: 'KNOWLEDGE',
        payload: { references: [{ pageId: page.id, title: 'caller spoofed title' }] },
        provider: 'knowledge-search',
        modelOrRule: 'semantic-match',
        version: '1',
        confidence: 0.75,
        contextDigest: 'c'.repeat(64)
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().payload.references[0].title).toBe('Canonical refund guide');
    await prisma.knowledgePage.delete({ where: { id: page.id } });
    const afterDelete = await inject(fixture, fixture.memberA.email, {
      method: 'GET', url: `/support/cases/${fixture.ownCase.key}/assistance`
    });
    expect(afterDelete.statusCode).toBe(200);
    expect(afterDelete.json().items).toEqual([]);
  });
});

async function createFixture(options: { ownOpen?: boolean } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [owner, manager, memberA, memberB, agent] = await Promise.all([
    ['owner', 'HUMAN'], ['manager', 'HUMAN'], ['member-a', 'HUMAN'], ['member-b', 'HUMAN'], ['agent', 'AGENT']
  ].map(([name, kind]) => prisma.user.create({
    data: { email: `${name}-${suffix}@${EMAIL_DOMAIN}`, name: name!, kind: kind as 'HUMAN' | 'AGENT' }
  })));
  const workspace = await prisma.workspace.create({
    data: { name: 'Support quality', slug: `support-quality-${suffix}`, mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'SQUAL', nextCaseNumber: 3 }
  });
  await prisma.workspaceMember.createMany({
    data: [owner, manager, memberA, memberB, agent].map((user) => ({
      workspaceId: workspace.id,
      userId: user.id,
      role: user.id === owner.id || user.id === agent.id ? 'OWNER' : 'MEMBER'
    }))
  });
  const [department, secondaryDepartment] = await Promise.all([
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Quality', slug: 'quality' }
    }),
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Escalations', slug: 'escalations' }
    })
  ]);
  const [managerMembership, memberAMembership, memberBMembership] = await Promise.all([
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: manager.id, role: 'MANAGER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberA.id }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberB.id }
    })
  ]);
  const peerSecret = `peer-quality-secret-${suffix}`;
  const completedAt = new Date();
  const [ownCase, peerCase] = await Promise.all([
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 1,
        key: 'SQUAL-1',
        title: 'Own resolved Case',
        sourceChannel: 'MANUAL',
        typeKey: 'request',
        status: options.ownOpen ? 'OPEN' : 'RESOLVED',
        departmentId: department.id,
        assigneeMembershipId: memberAMembership.id,
        resolutionCode: options.ownOpen ? undefined : 'FIXED',
        resolutionSummary: options.ownOpen ? undefined : 'Resolved',
        receivedAt: completedAt,
        lastMeaningfulActivityAt: completedAt,
        resolvedAt: options.ownOpen ? undefined : completedAt
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 2,
        key: 'SQUAL-2',
        title: peerSecret,
        sourceChannel: 'CALL',
        typeKey: 'incident',
        status: 'RESOLVED',
        departmentId: department.id,
        assigneeMembershipId: memberBMembership.id,
        resolutionCode: 'FIXED',
        resolutionSummary: peerSecret,
        receivedAt: completedAt,
        lastMeaningfulActivityAt: completedAt,
        resolvedAt: completedAt
      }
    })
  ]);
  const minted = mintAgentCredentialToken();
  const credential = await prisma.agentCredential.create({
    data: {
      workspaceId: workspace.id,
      userId: agent.id,
      name: 'Quality suggestion provider',
      lookupId: minted.lookupId,
      tokenHash: minted.tokenHash,
      scope: 'READ_WRITE'
    }
  });
  await prisma.supportCredentialGrant.create({
    data: { workspaceId: workspace.id, credentialId: credential.id, scope: 'CASE_READ' }
  });
  return {
    workspace,
    owner,
    manager,
    memberA,
    memberB,
    department,
    secondaryDepartment,
    managerMembership,
    memberAMembership,
    memberBMembership,
    ownCase,
    peerCase,
    peerSecret,
    agentToken: minted.token,
    agentCredentialId: credential.id
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function inject(
  fixture: Fixture,
  email: string,
  options: InjectOptions
) {
  return app.inject({
    ...options,
    headers: { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': email }
  });
}

function prioritySuggestion(priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT') {
  return {
    kind: 'PRIORITY',
    payload: { priority },
    provider: 'routing-rules',
    modelOrRule: 'impact-urgency',
    version: '3',
    confidence: 0.91,
    contextDigest: 'a'.repeat(64)
  };
}

function createRubric(fixture: Fixture) {
  return inject(fixture, fixture.owner.email, {
    method: 'POST',
    url: '/support/quality/rubrics',
    payload: {
      rubricKey: 'standard',
      name: 'Standard review',
      criteria: [
        { key: 'accuracy', label: 'Accuracy', maxScore: 5, weight: 60 },
        { key: 'empathy', label: 'Empathy', maxScore: 4, weight: 40 }
      ]
    }
  });
}

function createReview(fixture: Fixture, caseId: string, rubricId: string, scores: [number, number]) {
  return inject(fixture, fixture.manager.email, {
    method: 'POST',
    url: '/support/quality/reviews',
    payload: {
      caseId,
      rubricId,
      sampleReason: 'Random weekly quality sample',
      findings: [
        { criterionKey: 'accuracy', score: scores[0], finding: 'Accuracy finding' },
        { criterionKey: 'empathy', score: scores[1], finding: 'Empathy finding' }
      ]
    }
  });
}
