import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import { mintAgentCredentialToken } from '../services/agent-credential';
import {
  createSupportEnablementDefinitionSchema,
  createSupportKnowledgeGapSchema
} from '../services/support-enablement';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import { registerSupportEnablementRoutes } from './support-enablement';

const EMAIL_DOMAIN = 'support-enablement.test';
const cleanupWorkspaceIds: string[] = [];
let app: FastifyInstance;

describe('Support enablement, privacy-safe clusters, and KCS', () => {
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
    await app.register(registerSupportEnablementRoutes);
    await app.ready();
  });

  afterEach(async () => {
    const workspaceIds = cleanupWorkspaceIds.splice(0);
    if (workspaceIds.length) {
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('accepts only closed reversible action and condition unions', () => {
    expect(createSupportEnablementDefinitionSchema.safeParse({
      kind: 'MACRO',
      definitionKey: 'escalate',
      name: 'Escalate safely',
      actions: [{ type: 'SET_PRIORITY', value: 'URGENT' }]
    }).success).toBe(true);
    for (const actions of [
      [{ type: 'RUN_SCRIPT', script: 'return true' }],
      [{ type: 'SEND_WEBHOOK', url: 'https://example.test' }],
      [{ type: 'SET_FIELD', field: 'contact.email', value: 'leak' }],
      [{ type: 'SET_TYPE_KEY', value: '9invalid' }],
      [
        { type: 'SET_PRIORITY', value: 'HIGH' },
        { type: 'SET_PRIORITY', value: 'URGENT' }
      ]
    ]) {
      expect(createSupportEnablementDefinitionSchema.safeParse({
        kind: 'MACRO', definitionKey: 'closed-union', name: 'Closed union', actions
      }).success).toBe(false);
    }
    expect(createSupportEnablementDefinitionSchema.safeParse({
      kind: 'AUTOMATION',
      definitionKey: 'no-predicate',
      name: 'No raw predicates',
      conditions: [{ field: 'SQL', value: 'TRUE' }],
      actions: [{ type: 'SET_PRIORITY', value: 'HIGH' }]
    }).success).toBe(false);
    expect(createSupportKnowledgeGapSchema.safeParse({
      kind: 'MISSING',
      pageId: crypto.randomUUID(),
      caseBaseVersion: 1,
      feedback: 'Missing must not smuggle a page relation'
    }).success).toBe(false);
  });

  test('versions admin-approved definitions and applies then safely undoes an exact preview', async () => {
    const fixture = await createFixture();
    const managerDenied = await createDefinition(fixture, fixture.manager.email, {
      kind: 'MACRO',
      definitionKey: 'priority-next-step',
      name: 'Priority and next step',
      actions: [{ type: 'SET_PRIORITY', value: 'HIGH' }]
    });
    expect(managerDenied.statusCode).toBe(403);

    const first = await createDefinition(fixture, fixture.owner.email, {
      kind: 'MACRO',
      definitionKey: 'priority-next-step',
      name: 'Priority and next step',
      actions: [
        { type: 'SET_PRIORITY', value: 'HIGH' },
        { type: 'SET_TYPE_KEY', value: 'incident' }
      ]
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ version: 1, status: 'DRAFT' });

    const draftPreview = await preview(fixture, fixture.memberA.email, first.json().id, 1);
    expect(draftPreview.statusCode).toBe(404);
    const approved = await app.inject({
      method: 'POST',
      url: `/support/enablement/definitions/${first.json().id}/approve`,
      headers: headers(fixture, fixture.owner.email)
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'APPROVED', version: 1 });

    const second = await createDefinition(fixture, fixture.owner.email, {
      kind: 'MACRO',
      definitionKey: 'priority-next-step',
      name: 'Priority and next step v2',
      actions: [{ type: 'SET_PRIORITY', value: 'URGENT' }]
    });
    expect(second.json().version).toBe(2);
    const secondApproved = await app.inject({
      method: 'POST',
      url: `/support/enablement/definitions/${second.json().id}/approve`,
      headers: headers(fixture, fixture.owner.email)
    });
    expect(secondApproved.statusCode).toBe(200);
    const definitions = await app.inject({
      method: 'GET',
      url: '/support/enablement/definitions',
      headers: headers(fixture, fixture.owner.email)
    });
    expect(definitions.json().items.map((item: { version: number; status: string }) => ({
      version: item.version,
      status: item.status
    }))).toEqual([
      { version: 2, status: 'APPROVED' },
      { version: 1, status: 'RETIRED' }
    ]);

    const exactPreview = await preview(fixture, fixture.memberA.email, second.json().id, 1);
    expect(exactPreview.statusCode).toBe(200);
    expect(exactPreview.json()).toMatchObject({
      case: { id: fixture.memberACase.id, version: 1 },
      canApply: true,
      requiresHumanApply: true,
      changes: [{ field: 'priority', before: 'NORMAL', after: 'URGENT' }]
    });
    const staleHash = `${'0'.repeat(64)}`;
    const rejectedStale = await applyDefinition(
      fixture,
      fixture.memberA.email,
      second.json().id,
      1,
      staleHash
    );
    expect(rejectedStale.statusCode).toBe(409);

    const applied = await applyDefinition(
      fixture,
      fixture.memberA.email,
      second.json().id,
      1,
      exactPreview.json().previewHash
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      application: { caseVersionBefore: 1, caseVersionAfter: 2, undoneAt: null },
      case: { priority: 'URGENT', version: 2 }
    });
    const staleUndo = await app.inject({
      method: 'POST',
      url: `/support/enablement/applications/${applied.json().application.id}/undo`,
      headers: headers(fixture, fixture.memberA.email),
      payload: { baseVersion: 1 }
    });
    expect(staleUndo.statusCode).toBe(409);
    const undone = await app.inject({
      method: 'POST',
      url: `/support/enablement/applications/${applied.json().application.id}/undo`,
      headers: headers(fixture, fixture.memberA.email),
      payload: { baseVersion: 2 }
    });
    expect(undone.statusCode).toBe(200);
    expect(undone.json()).toMatchObject({
      application: { undoCaseVersion: 3 },
      case: { priority: 'NORMAL', version: 3 }
    });
  });

  test('filters every cluster member and count through current Case access', async () => {
    const fixture = await createFixture();
    const created = await app.inject({
      method: 'POST',
      url: '/support/problem-clusters',
      headers: headers(fixture, fixture.manager.email),
      payload: { title: 'Canonical login problem', summary: 'Sanitized problem statement' }
    });
    expect(created.statusCode).toBe(201);

    const firstLink = await linkCase(
      fixture,
      created.json().id,
      fixture.memberACase.key,
      1,
      1
    );
    expect(firstLink.statusCode).toBe(200);
    expect(firstLink.json()).toMatchObject({ version: 2, visibleMemberCount: 1 });
    const secondLink = await linkCase(
      fixture,
      created.json().id,
      fixture.memberBCase.key,
      2,
      1
    );
    expect(secondLink.statusCode).toBe(200);
    expect(secondLink.json()).toMatchObject({ version: 3, visibleMemberCount: 2 });

    const memberA = await app.inject({
      method: 'GET',
      url: `/support/problem-clusters/${created.json().id}`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(memberA.statusCode).toBe(200);
    expect(memberA.json()).toMatchObject({ visibleMemberCount: 1 });
    expect(memberA.json().cases.map((item: { id: string }) => item.id)).toEqual([
      fixture.memberACase.id
    ]);
    expect(memberA.body).not.toContain(fixture.peerSecret);
    expect(memberA.body).not.toContain(fixture.memberBCase.id);
    expect(memberA.body).not.toContain(fixture.memberBCase.key);

    const hiddenCluster = await app.inject({
      method: 'POST',
      url: '/support/problem-clusters',
      headers: headers(fixture, fixture.manager.email),
      payload: { title: 'Peer-only canonical problem' }
    });
    const currentPeer = await prisma.supportCase.findUniqueOrThrow({
      where: { id: fixture.memberBCase.id }, select: { version: true }
    });
    await linkCase(
      fixture,
      hiddenCluster.json().id,
      fixture.memberBCase.key,
      1,
      currentPeer.version
    );
    const memberAList = await app.inject({
      method: 'GET',
      url: '/support/problem-clusters',
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(memberAList.statusCode).toBe(200);
    expect(memberAList.json().items.map((item: { id: string }) => item.id)).toEqual([
      created.json().id
    ]);
    expect(memberAList.body).not.toContain(hiddenCluster.json().id);
    expect(memberAList.body).not.toContain(fixture.peerSecret);

    const outOfScopeDepartment = await prisma.department.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'Out of scope',
        slug: `out-of-scope-${crypto.randomUUID().slice(0, 8)}`
      }
    });
    await prisma.supportCase.updateMany({
      where: { id: { in: [fixture.memberACase.id, fixture.memberBCase.id] } },
      data: {
        departmentId: outOfScopeDepartment.id,
        assigneeMembershipId: null,
        version: { increment: 1 }
      }
    });
    const formerCreatorRead = await app.inject({
      method: 'GET',
      url: `/support/problem-clusters/${created.json().id}`,
      headers: headers(fixture, fixture.manager.email)
    });
    expect(formerCreatorRead.statusCode).toBe(404);
    const formerCreatorUpdate = await app.inject({
      method: 'PATCH',
      url: `/support/problem-clusters/${created.json().id}`,
      headers: headers(fixture, fixture.manager.email),
      payload: { baseVersion: 3, title: 'Retained capability must fail' }
    });
    expect(formerCreatorUpdate.statusCode).toBe(404);
  });

  test('keeps Case and Knowledge authorization independent at write and read time', async () => {
    const fixture = await createFixture();
    const beforeSearch = await app.inject({
      method: 'GET',
      url: `/support/cases/${fixture.memberACase.key}/knowledge/search?q=guide`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(beforeSearch.statusCode).toBe(200);
    expect(beforeSearch.json().items.map((item: { id: string }) => item.id)).toEqual([
      fixture.knowledgePage.id
    ]);

    const use = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.memberACase.key}/knowledge/uses`,
      headers: headers(fixture, fixture.memberA.email),
      payload: {
        pageId: fixture.knowledgePage.id,
        caseBaseVersion: 1,
        usefulness: 'HELPFUL',
        outcome: 'ADVANCED'
      }
    });
    expect(use.statusCode).toBe(201);
    const wrongGap = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.memberACase.key}/knowledge/gaps`,
      headers: headers(fixture, fixture.memberA.email),
      payload: {
        kind: 'WRONG',
        pageId: fixture.knowledgePage.id,
        caseBaseVersion: 1,
        feedback: 'The final remediation step is outdated'
      }
    });
    expect(wrongGap.statusCode).toBe(201);

    const peerCaseDenied = await app.inject({
      method: 'GET',
      url: `/support/cases/${fixture.memberACase.key}/knowledge/search?q=guide`,
      headers: headers(fixture, fixture.memberB.email)
    });
    expect(peerCaseDenied.statusCode).toBe(404);

    await prisma.teamMember.delete({
      where: { teamId_userId: { teamId: fixture.team.id, userId: fixture.memberA.id } }
    });
    const afterRevocation = await app.inject({
      method: 'GET',
      url: `/support/cases/${fixture.memberACase.key}/knowledge/uses`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(afterRevocation.statusCode).toBe(200);
    expect(afterRevocation.json() as unknown).toEqual({ items: [], visibleCount: 0 });
    const gapBacklog = await app.inject({
      method: 'GET',
      url: '/support/knowledge/gaps',
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(gapBacklog.statusCode).toBe(200);
    expect(gapBacklog.json().items).toEqual([]);

    const credentialHeaders = {
      'x-workspace-slug': fixture.workspace.slug,
      authorization: `Bearer ${fixture.agentToken}`
    };
    const credentialSearch = await app.inject({
      method: 'GET',
      url: `/support/cases/${fixture.memberACase.key}/knowledge/search?q=guide`,
      headers: credentialHeaders
    });
    expect(credentialSearch.statusCode).toBe(403);
    const credentialApply = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.memberACase.key}/automation-evaluations`,
      headers: credentialHeaders,
      payload: { baseVersion: 1 }
    });
    // Evaluation may read an exact Case, but it remains dry-run and carries no automatic apply.
    expect(credentialApply.statusCode).toBe(200);
    expect(credentialApply.json()).toMatchObject({ requiresHumanApply: true });
  });

  test('database constraints reject cross-workspace Knowledge bindings and direct provenance erasure', async () => {
    const fixture = await createFixture();
    const other = await createForeignKnowledgePage();
    expect(await rejects(async () => prisma.supportCaseKnowledgeUse.create({
      data: {
        workspaceId: fixture.workspace.id,
        caseId: fixture.memberACase.id,
        knowledgePageId: other.page.id,
        caseVersion: 1,
        knowledgePageVersion: 1,
        usefulness: 'HELPFUL',
        outcome: 'ADVANCED',
        createdById: fixture.memberA.id
      }
    }))).toBe(true);
    expect(await rejects(async () => prisma.supportKnowledgeGap.create({
      data: {
        workspaceId: fixture.workspace.id,
        caseId: fixture.memberACase.id,
        knowledgePageId: other.page.id,
        kind: 'WRONG',
        feedback: 'Cross-workspace relation must fail',
        createdById: fixture.memberA.id
      }
    }))).toBe(true);

    const definition = await prisma.supportEnablementDefinition.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: 'MACRO',
        definitionKey: 'immutable_creator',
        version: 1,
        name: 'Immutable creator',
        actions: [{ type: 'SET_PRIORITY', value: 'HIGH' }],
        createdById: fixture.owner.id
      }
    });
    expect(await rejects(async () => prisma.$executeRawUnsafe(
      `UPDATE "SupportEnablementDefinition" SET "createdById" = NULL WHERE "id" = $1::uuid`,
      definition.id
    ))).toBe(true);
    expect(await rejects(async () => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('taskara.support_provenance_nulling', 'on', true)`;
      await tx.$executeRawUnsafe(
        `UPDATE "SupportEnablementDefinition" SET "createdById" = NULL WHERE "id" = $1::uuid`,
        definition.id
      );
    }))).toBe(true);

    const deleteSubject = await prisma.user.create({
      data: {
        email: `delete-subject-${crypto.randomUUID().slice(0, 8)}@${EMAIL_DOMAIN}`,
        name: 'Delete subject'
      }
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: fixture.workspace.id, userId: deleteSubject.id, role: 'MEMBER' }
    });
    const approved = await prisma.supportEnablementDefinition.create({
      data: {
        workspaceId: fixture.workspace.id,
        kind: 'TEMPLATE',
        definitionKey: 'deletion_provenance',
        version: 1,
        name: 'Deletion provenance',
        status: 'APPROVED',
        actions: [{ type: 'SET_PRIORITY', value: 'HIGH' }],
        createdById: deleteSubject.id,
        approvedById: deleteSubject.id,
        approvedAt: new Date()
      }
    });
    const application = await prisma.supportEnablementApplication.create({
      data: {
        workspaceId: fixture.workspace.id,
        definitionId: approved.id,
        caseId: fixture.memberACase.id,
        caseVersionBefore: 1,
        caseVersionAfter: 2,
        previewHash: 'a'.repeat(64),
        before: { priority: 'NORMAL' },
        after: { priority: 'HIGH' },
        appliedById: deleteSubject.id
      }
    });
    await prisma.workspaceMember.delete({
      where: {
        workspaceId_userId: {
          workspaceId: fixture.workspace.id,
          userId: deleteSubject.id
        }
      }
    });
    await prisma.user.delete({ where: { id: deleteSubject.id } });
    expect(await prisma.supportEnablementDefinition.findUnique({
      where: { id: approved.id },
      select: { createdById: true, approvedById: true }
    })).toEqual({ createdById: null, approvedById: null });
    expect(await prisma.supportEnablementApplication.findUnique({
      where: { id: application.id },
      select: { appliedById: true }
    })).toEqual({ appliedById: null });
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [owner, manager, memberA, memberB, agent] = await Promise.all([
    ['owner', 'HUMAN'],
    ['manager', 'HUMAN'],
    ['member-a', 'HUMAN'],
    ['member-b', 'HUMAN'],
    ['agent', 'AGENT']
  ].map(([name, kind]) => prisma.user.create({
    data: {
      email: `${name}-${suffix}@${EMAIL_DOMAIN}`,
      name: name!,
      kind: kind as 'HUMAN' | 'AGENT'
    }
  })));
  const workspace = await prisma.workspace.create({
    data: { name: 'Support enablement', slug: `support-enablement-${suffix}`, mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'SENA', nextCaseNumber: 3 }
  });
  await prisma.workspaceMember.createMany({
    data: [owner, manager, memberA, memberB, agent].map((user) => ({
      workspaceId: workspace.id,
      userId: user.id,
      role: user.id === owner.id || user.id === agent.id ? 'OWNER' : 'MEMBER'
    }))
  });
  const department = await prisma.department.create({
    data: { workspaceId: workspace.id, name: 'Enablement', slug: 'enablement' }
  });
  const [managerMembership, memberAMembership, memberBMembership] = await Promise.all([
    prisma.departmentMember.create({
      data: {
        workspaceId: workspace.id,
        departmentId: department.id,
        userId: manager.id,
        role: 'MANAGER'
      }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberA.id }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberB.id }
    })
  ]);
  const peerSecret = `peer-enablement-secret-${suffix}`;
  const [memberACase, memberBCase] = await Promise.all([
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 1,
        key: 'SENA-1',
        title: 'Member A login issue',
        sourceChannel: 'API',
        typeKey: 'request',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberAMembership.id
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 2,
        key: 'SENA-2',
        title: peerSecret,
        description: peerSecret,
        sourceChannel: 'CALL',
        typeKey: 'incident',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberBMembership.id
      }
    })
  ]);
  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Knowledge authors', slug: `knowledge-${suffix}` }
  });
  await prisma.teamMember.create({
    data: { teamId: team.id, userId: memberA.id, role: 'MEMBER' }
  });
  const knowledgeSpace = await prisma.knowledgeSpace.create({
    data: {
      workspaceId: workspace.id,
      type: 'TEAM',
      teamId: team.id,
      key: `support-guide-${suffix}`,
      name: 'Support guide'
    }
  });
  const knowledgePage = await prisma.knowledgePage.create({
    data: {
      workspaceId: workspace.id,
      spaceId: knowledgeSpace.id,
      slug: 'login-guide',
      path: 'login-guide',
      title: 'Login guide',
      content: { type: 'doc', content: [] },
      contentText: 'login guide remediation',
      status: 'PUBLISHED'
    }
  });
  const minted = mintAgentCredentialToken();
  const credential = await prisma.agentCredential.create({
    data: {
      workspaceId: workspace.id,
      userId: agent.id,
      name: 'Enablement evaluator',
      lookupId: minted.lookupId,
      tokenHash: minted.tokenHash,
      scope: 'READ_WRITE'
    }
  });
  await prisma.supportCredentialGrant.createMany({
    data: [
      { workspaceId: workspace.id, credentialId: credential.id, scope: 'CASE_READ' },
      { workspaceId: workspace.id, credentialId: credential.id, scope: 'CASE_WRITE' }
    ]
  });
  return {
    workspace,
    owner,
    manager,
    memberA,
    memberB,
    department,
    managerMembership,
    memberAMembership,
    memberBMembership,
    memberACase,
    memberBCase,
    peerSecret,
    team,
    knowledgePage,
    agentToken: minted.token
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function headers(fixture: Fixture, email: string) {
  return { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': email };
}

function createDefinition(fixture: Fixture, email: string, payload: InjectOptions['payload']) {
  return app.inject({
    method: 'POST',
    url: '/support/enablement/definitions',
    headers: headers(fixture, email),
    payload
  });
}

function preview(fixture: Fixture, email: string, definitionId: string, baseVersion: number) {
  return app.inject({
    method: 'POST',
    url: `/support/cases/${fixture.memberACase.key}/enablement/${definitionId}/preview`,
    headers: headers(fixture, email),
    payload: { baseVersion }
  });
}

function applyDefinition(
  fixture: Fixture,
  email: string,
  definitionId: string,
  baseVersion: number,
  previewHash: string
) {
  return app.inject({
    method: 'POST',
    url: `/support/cases/${fixture.memberACase.key}/enablement/${definitionId}/apply`,
    headers: headers(fixture, email),
    payload: { baseVersion, previewHash }
  });
}

function linkCase(
  fixture: Fixture,
  clusterId: string,
  caseKey: string,
  clusterBaseVersion: number,
  caseBaseVersion: number
) {
  return app.inject({
    method: 'POST',
    url: `/support/problem-clusters/${clusterId}/cases/${caseKey}`,
    headers: headers(fixture, fixture.manager.email),
    payload: { clusterBaseVersion, caseBaseVersion }
  });
}

async function createForeignKnowledgePage() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await prisma.workspace.create({
    data: { name: 'Foreign knowledge', slug: `foreign-knowledge-${suffix}` }
  });
  cleanupWorkspaceIds.push(workspace.id);
  const space = await prisma.knowledgeSpace.create({
    data: {
      workspaceId: workspace.id,
      type: 'WORKSPACE',
      key: `foreign-${suffix}`,
      name: 'Foreign'
    }
  });
  const page = await prisma.knowledgePage.create({
    data: {
      workspaceId: workspace.id,
      spaceId: space.id,
      slug: 'foreign',
      path: 'foreign',
      title: 'Foreign page',
      content: { type: 'doc', content: [] },
      contentText: 'foreign'
    }
  });
  return { workspace, page };
}

async function rejects(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}
