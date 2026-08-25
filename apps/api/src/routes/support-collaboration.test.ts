import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import {
  SupportCasePresenceRegistry,
  supportCasePresenceRegistry
} from '../services/support-collaboration';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import { registerSupportCollaborationRoutes } from './support-collaboration';

const EMAIL_DOMAIN = 'support-collaboration.test';
const cleanupWorkspaceIds: string[] = [];
let app: FastifyInstance;

describe('Support saved views and Case presence privacy', () => {
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
    await app.register(registerSupportCollaborationRoutes);
    await app.ready();
  });

  afterEach(async () => {
    supportCasePresenceRegistry.clear();
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
  });

  test('defaults saved queues to owner-private and rejects raw query or peer filters', async () => {
    const fixture = await createFixture();
    const created = await createView(fixture, fixture.memberA.email, {
      name: 'My urgent Cases',
      filters: {
        assigneeMembershipId: fixture.memberAMembership.id,
        priorities: ['URGENT']
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      ownerId: fixture.memberA.id,
      visibility: 'PRIVATE',
      departmentId: null,
      version: 1,
      filters: { schemaVersion: 1, assigneeMembershipId: fixture.memberAMembership.id }
    });

    const ownList = await listViews(fixture, fixture.memberA.email);
    const peerList = await listViews(fixture, fixture.memberB.email);
    const managerList = await listViews(fixture, fixture.managerA.email);
    expect(ownList.json().items.map((view: { id: string }) => view.id)).toEqual([created.json().id]);
    expect(peerList.json().items).toEqual([]);
    expect(managerList.json().items).toEqual([]);

    const used = await app.inject({
      method: 'GET',
      url: `/support/saved-views/${created.json().id}/cases`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(used.statusCode).toBe(200);
    expect(used.json().items.map((item: { id: string }) => item.id)).toEqual([fixture.memberACase.id]);
    expect(JSON.stringify(used.json())).not.toContain(fixture.peerSecret);

    const peerFilter = await createView(fixture, fixture.memberA.email, {
      name: 'Forbidden peer filter',
      filters: { assigneeMembershipId: fixture.memberBMembership.id }
    });
    expect(peerFilter.statusCode).toBe(403);

    const attemptedShared = await createView(fixture, fixture.memberA.email, {
      name: 'Member cannot share',
      visibility: 'DEPARTMENT',
      departmentId: fixture.departmentA.id,
      filters: {}
    });
    expect(attemptedShared.statusCode).toBe(403);

    for (const forbiddenFilters of [
      { where: { workspaceId: fixture.workspace.id } },
      { sql: 'SELECT * FROM SupportCase' },
      { q: fixture.peerSecret }
    ]) {
      const response = await createView(fixture, fixture.memberA.email, {
        name: 'Never store raw query state',
        filters: forbiddenFilters
      });
      expect(response.statusCode).toBe(400);
    }
  });

  test('shares Department queues only among its managers and Support-wide readers', async () => {
    const fixture = await createFixture();
    const departmentView = await createView(fixture, fixture.managerA.email, {
      name: 'Primary inbox',
      visibility: 'DEPARTMENT',
      departmentId: fixture.departmentA.id,
      filters: { queue: 'DEPARTMENT_INBOX' }
    });
    expect(departmentView.statusCode).toBe(201);

    for (const [email, seesDepartmentView] of [
      [fixture.managerA.email, true],
      [fixture.supervisor.email, true],
      [fixture.owner.email, true],
      [fixture.managerB.email, false],
      [fixture.memberA.email, false],
      [fixture.triager.email, false]
    ] as const) {
      const response = await listViews(fixture, email);
      expect(response.statusCode).toBe(200);
      expect(response.json().items.some((view: { id: string }) => view.id === departmentView.json().id))
        .toBe(seesDepartmentView);
    }

    const supervisorUse = await app.inject({
      method: 'GET',
      url: `/support/saved-views/${departmentView.json().id}/cases`,
      headers: headers(fixture, fixture.supervisor.email)
    });
    expect(supervisorUse.statusCode).toBe(200);
    expect(supervisorUse.json().items.map((item: { id: string }) => item.id)).toEqual([
      fixture.departmentInboxCase.id
    ]);
    expect(JSON.stringify(supervisorUse.json())).not.toContain(fixture.otherDepartmentSecret);

    const workspaceView = await createView(fixture, fixture.supervisor.email, {
      name: 'Support-wide Triage',
      visibility: 'WORKSPACE',
      filters: { queue: 'TRIAGE' }
    });
    expect(workspaceView.statusCode).toBe(201);
    expect((await listViews(fixture, fixture.owner.email)).json().items
      .some((view: { id: string }) => view.id === workspaceView.json().id)).toBe(true);
    expect((await listViews(fixture, fixture.managerA.email)).json().items
      .some((view: { id: string }) => view.id === workspaceView.json().id)).toBe(false);

    const otherManagerShare = await createView(fixture, fixture.managerB.email, {
      name: 'Cannot share another Department',
      visibility: 'DEPARTMENT',
      departmentId: fixture.departmentA.id,
      filters: {}
    });
    expect(otherManagerShare.statusCode).toBe(403);
  });

  test('revalidates stored filters at every read/use and hides invalid or revoked views', async () => {
    const fixture = await createFixture();
    const peerView = await createView(fixture, fixture.managerA.email, {
      name: 'Manager peer assignment',
      filters: { assigneeMembershipId: fixture.memberBMembership.id }
    });
    expect(peerView.statusCode).toBe(201);

    const corrupted = await prisma.supportSavedView.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerId: fixture.memberA.id,
        name: 'Corrupt raw predicate',
        filters: { OR: [{ title: { contains: fixture.peerSecret } }] }
      }
    });
    const memberList = await listViews(fixture, fixture.memberA.email);
    expect(JSON.stringify(memberList.json())).not.toContain(corrupted.id);
    expect(JSON.stringify(memberList.json())).not.toContain(fixture.peerSecret);
    const corruptUse = await app.inject({
      method: 'GET',
      url: `/support/saved-views/${corrupted.id}/cases`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(corruptUse.statusCode).toBe(404);

    await prisma.departmentMember.update({
      where: { id: fixture.managerAMembership.id },
      data: { role: 'MEMBER' }
    });
    const afterRevocation = await listViews(fixture, fixture.managerA.email);
    expect(afterRevocation.statusCode).toBe(200);
    expect(afterRevocation.json().items.some((view: { id: string }) => view.id === peerView.json().id))
      .toBe(false);
    const revokedUse = await app.inject({
      method: 'GET',
      url: `/support/saved-views/${peerView.json().id}/cases`,
      headers: headers(fixture, fixture.managerA.email)
    });
    expect(revokedUse.statusCode).toBe(404);
  });

  test('uses optimistic versions for saved queue changes and ownership for deletion', async () => {
    const fixture = await createFixture();
    const created = await createView(fixture, fixture.memberA.email, {
      name: 'Versioned private queue',
      filters: { statuses: ['OPEN'] }
    });
    const id = created.json().id as string;
    const stale = await app.inject({
      method: 'PATCH',
      url: `/support/saved-views/${id}`,
      headers: headers(fixture, fixture.memberA.email),
      payload: { name: 'Stale edit', baseVersion: 2 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'SUPPORT_SAVED_VIEW_VERSION_CONFLICT',
      currentVersion: 1
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: `/support/saved-views/${id}`,
      headers: headers(fixture, fixture.memberA.email),
      payload: { name: 'Current edit', baseVersion: 1 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Current edit', version: 2 });

    const peerDelete = await app.inject({
      method: 'DELETE',
      url: `/support/saved-views/${id}?baseVersion=2`,
      headers: headers(fixture, fixture.memberB.email)
    });
    expect(peerDelete.statusCode).toBe(404);
    const staleDelete = await app.inject({
      method: 'DELETE',
      url: `/support/saved-views/${id}?baseVersion=1`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(staleDelete.statusCode).toBe(409);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/support/saved-views/${id}?baseVersion=2`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(deleted.statusCode).toBe(204);
  });

  test('presence warns only exact current Case readers and drops revoked or stale heartbeats', async () => {
    const fixture = await createFixture();
    const memberTouch = await touchPresence(
      fixture,
      fixture.memberA.email,
      fixture.memberACase.key,
      'member-a-client',
      fixture.memberACase.version,
      'EDITING'
    );
    expect(memberTouch.statusCode).toBe(200);
    expect(memberTouch.json().collision).toEqual({
      hasConcurrentEditor: false,
      hasVersionSkew: false,
      readers: []
    });

    const peerDenied = await touchPresence(
      fixture,
      fixture.memberB.email,
      fixture.memberACase.key,
      'member-b-denied',
      fixture.memberACase.version,
      'VIEWING'
    );
    expect(peerDenied.statusCode).toBe(404);
    const otherManagerDenied = await touchPresence(
      fixture,
      fixture.managerB.email,
      fixture.memberACase.key,
      'manager-b-denied',
      fixture.memberACase.version,
      'VIEWING'
    );
    expect(otherManagerDenied.statusCode).toBe(404);

    const managerTouch = await touchPresence(
      fixture,
      fixture.managerA.email,
      fixture.memberACase.key,
      'manager-a-client',
      fixture.memberACase.version,
      'VIEWING'
    );
    expect(managerTouch.statusCode).toBe(200);
    expect(managerTouch.json().collision).toMatchObject({
      hasConcurrentEditor: true,
      hasVersionSkew: false,
      readers: [{
        user: { id: fixture.memberA.id, name: fixture.memberA.name },
        clientId: 'member-a-client',
        intent: 'EDITING',
        caseVersion: fixture.memberACase.version,
        staleVersion: false
      }]
    });
    expect(JSON.stringify(managerTouch.json())).not.toContain(fixture.peerSecret);

    const stale = await touchPresence(
      fixture,
      fixture.managerA.email,
      fixture.memberACase.key,
      'stale-client',
      fixture.memberACase.version + 1,
      'EDITING'
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('SUPPORT_VERSION_CONFLICT');

    const transferred = await prisma.supportCase.update({
      where: { id: fixture.memberACase.id },
      data: {
        assigneeMembershipId: fixture.memberBMembership.id,
        version: { increment: 1 }
      }
    });
    const newAssignee = await touchPresence(
      fixture,
      fixture.memberB.email,
      transferred.key,
      'member-b-current',
      transferred.version,
      'EDITING'
    );
    expect(newAssignee.statusCode).toBe(200);
    const collisionJson = JSON.stringify(newAssignee.json().collision);
    expect(collisionJson).not.toContain(fixture.memberA.id);
    expect(collisionJson).not.toContain('member-a-client');
    expect(collisionJson).not.toContain('stale-client');
    expect(collisionJson).toContain(fixture.managerA.id);
    expect(newAssignee.json().collision.hasVersionSkew).toBe(true);

    const formerAssignee = await app.inject({
      method: 'GET',
      url: `/support/cases/${transferred.key}/presence?baseVersion=${transferred.version}`,
      headers: headers(fixture, fixture.memberA.email)
    });
    expect(formerAssignee.statusCode).toBe(404);
  });

  test('expires presence deterministically at the server-controlled TTL boundary', () => {
    const registry = new SupportCasePresenceRegistry(1_000, 10);
    const input = {
      workspaceId: crypto.randomUUID(),
      caseId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      clientId: 'ttl-client',
      intent: 'EDITING' as const,
      caseVersion: 3
    };
    registry.touch(input, new Date('2026-08-23T00:00:00.000Z'));
    expect(registry.activeForCase(
      input.workspaceId,
      input.caseId,
      new Date('2026-08-23T00:00:00.999Z')
    )).toHaveLength(1);
    expect(registry.activeForCase(
      input.workspaceId,
      input.caseId,
      new Date('2026-08-23T00:00:01.000Z')
    )).toEqual([]);
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [owner, supervisor, managerA, managerB, memberA, memberB, triager, noAccess] =
    await Promise.all(
      ['owner', 'supervisor', 'manager-a', 'manager-b', 'member-a', 'member-b', 'triager', 'no-access']
        .map((name) => prisma.user.create({
          data: { email: `${name}-${suffix}@${EMAIL_DOMAIN}`, name }
        }))
    );
  const workspace = await prisma.workspace.create({
    data: { name: 'Support collaboration', slug: `support-collab-${suffix}`, mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'SCOL', nextCaseNumber: 6 }
  });
  await prisma.workspaceMember.createMany({
    data: [owner, supervisor, managerA, managerB, memberA, memberB, triager, noAccess]
      .map((user) => ({
        workspaceId: workspace.id,
        userId: user.id,
        role: user.id === owner.id ? 'OWNER' : 'MEMBER'
      }))
  });
  const [departmentA, departmentB] = await Promise.all([
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Primary', slug: 'primary' }
    }),
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Other', slug: 'other' }
    })
  ]);
  const [managerAMembership, managerBMembership, memberAMembership, memberBMembership] =
    await Promise.all([
      prisma.departmentMember.create({
        data: {
          workspaceId: workspace.id,
          departmentId: departmentA.id,
          userId: managerA.id,
          role: 'MANAGER'
        }
      }),
      prisma.departmentMember.create({
        data: {
          workspaceId: workspace.id,
          departmentId: departmentB.id,
          userId: managerB.id,
          role: 'MANAGER'
        }
      }),
      prisma.departmentMember.create({
        data: { workspaceId: workspace.id, departmentId: departmentA.id, userId: memberA.id }
      }),
      prisma.departmentMember.create({
        data: { workspaceId: workspace.id, departmentId: departmentA.id, userId: memberB.id }
      })
    ]);
  await prisma.supportPermissionGrant.createMany({
    data: [
      { workspaceId: workspace.id, userId: supervisor.id, role: 'SUPERVISOR' },
      { workspaceId: workspace.id, userId: triager.id, role: 'TRIAGER' }
    ]
  });
  const peerSecret = `peer-case-secret-${suffix}`;
  const otherDepartmentSecret = `other-department-secret-${suffix}`;
  const [memberACase, peerCase, departmentInboxCase, otherDepartmentCase, triageCase] =
    await Promise.all([
      prisma.supportCase.create({
        data: {
          workspaceId: workspace.id,
          sequence: 1,
          key: 'SCOL-1',
          title: 'Member A visible Case',
          sourceChannel: 'API',
          typeKey: 'request',
          priority: 'URGENT',
          status: 'OPEN',
          departmentId: departmentA.id,
          assigneeMembershipId: memberAMembership.id
        }
      }),
      prisma.supportCase.create({
        data: {
          workspaceId: workspace.id,
          sequence: 2,
          key: 'SCOL-2',
          title: peerSecret,
          sourceChannel: 'CALL',
          typeKey: 'incident',
          status: 'OPEN',
          departmentId: departmentA.id,
          assigneeMembershipId: memberBMembership.id
        }
      }),
      prisma.supportCase.create({
        data: {
          workspaceId: workspace.id,
          sequence: 3,
          key: 'SCOL-3',
          title: 'Primary Department inbox',
          sourceChannel: 'EMAIL',
          typeKey: 'request',
          status: 'OPEN',
          departmentId: departmentA.id
        }
      }),
      prisma.supportCase.create({
        data: {
          workspaceId: workspace.id,
          sequence: 4,
          key: 'SCOL-4',
          title: otherDepartmentSecret,
          sourceChannel: 'API',
          typeKey: 'request',
          status: 'OPEN',
          departmentId: departmentB.id,
          assigneeMembershipId: managerBMembership.id
        }
      }),
      prisma.supportCase.create({
        data: {
          workspaceId: workspace.id,
          sequence: 5,
          key: 'SCOL-5',
          title: 'Unrouted Triage Case',
          sourceChannel: 'MANUAL',
          typeKey: 'request'
        }
      })
    ]);
  return {
    workspace,
    owner,
    supervisor,
    managerA,
    managerB,
    memberA,
    memberB,
    triager,
    noAccess,
    departmentA,
    departmentB,
    managerAMembership,
    managerBMembership,
    memberAMembership,
    memberBMembership,
    memberACase,
    peerCase,
    departmentInboxCase,
    otherDepartmentCase,
    triageCase,
    peerSecret,
    otherDepartmentSecret
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function headers(fixture: Fixture, email: string) {
  return { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': email };
}

function createView(fixture: Fixture, email: string, payload: InjectOptions['payload']) {
  return app.inject({
    method: 'POST',
    url: '/support/saved-views',
    headers: headers(fixture, email),
    payload
  });
}

function listViews(fixture: Fixture, email: string) {
  return app.inject({
    method: 'GET',
    url: '/support/saved-views',
    headers: headers(fixture, email)
  });
}

function touchPresence(
  fixture: Fixture,
  email: string,
  caseKey: string,
  clientId: string,
  baseVersion: number,
  intent: 'VIEWING' | 'EDITING'
) {
  return app.inject({
    method: 'POST',
    url: `/support/cases/${caseKey}/presence`,
    headers: headers(fixture, email),
    payload: { clientId, baseVersion, intent }
  });
}
