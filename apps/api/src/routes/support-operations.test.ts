import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import { registerSupportOperationsRoutes } from './support-operations';
import { registerSystemRoutes } from './system';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];
const EMAIL_DOMAIN = 'support-operations.test';

describe('Support operational configuration, reports, and attention commands', () => {
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
    await app.register(registerSupportOperationsRoutes);
    await app.register(registerSystemRoutes);
    await app.ready();
  });

  afterEach(async () => {
    const strandedMemberships = await prisma.workspaceMember.findMany({
      where: { user: { email: { endsWith: `@${EMAIL_DOMAIN}` } } },
      select: { workspaceId: true }
    });
    const workspaceIds = [...new Set([
      ...cleanupWorkspaceIds.splice(0),
      ...strandedMemberships.map((membership) => membership.workspaceId)
    ])];
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

  test('only a workspace admin configures calendars and creates immutable SLA policy versions', async () => {
    const fixture = await createFixture();
    const calendarPayload = {
      name: 'Customer Care hours',
      timezone: 'Europe/Zurich',
      departmentId: fixture.department.id,
      periods: [
        { dayOfWeek: 1, startMinute: 9 * 60, endMinute: 17 * 60 },
        { dayOfWeek: 2, startMinute: 9 * 60, endMinute: 17 * 60 }
      ],
      holidays: [{ date: '2026-12-25', name: 'Winter holiday', working: false }]
    };

    const memberList = await inject(fixture, fixture.memberA.email, {
      method: 'GET',
      url: '/support/config/calendars'
    });
    expect(memberList.statusCode).toBe(403);

    const supervisorCreate = await inject(fixture, fixture.supervisor.email, {
      method: 'POST',
      url: '/support/config/calendars',
      payload: calendarPayload
    });
    expect(supervisorCreate.statusCode).toBe(403);

    const createdCalendar = await inject(fixture, fixture.owner.email, {
      method: 'POST',
      url: '/support/config/calendars',
      payload: calendarPayload
    });
    expect(createdCalendar.statusCode).toBe(201);
    expect(createdCalendar.json()).toMatchObject({
      name: calendarPayload.name,
      timezone: calendarPayload.timezone,
      department: { id: fixture.department.id, name: fixture.department.name },
      active: true,
      periods: calendarPayload.periods,
      holidays: calendarPayload.holidays
    });

    const updatedCalendar = await inject(fixture, fixture.owner.email, {
      method: 'PATCH',
      url: `/support/config/calendars/${createdCalendar.json().id}`,
      payload: { name: 'Customer Care coverage' }
    });
    expect(updatedCalendar.statusCode).toBe(200);
    expect(updatedCalendar.json()).toMatchObject({
      id: createdCalendar.json().id,
      name: 'Customer Care coverage',
      periods: calendarPayload.periods,
      holidays: calendarPayload.holidays
    });

    const versionOnePayload = {
      calendarId: createdCalendar.json().id,
      policyKey: 'customer-response',
      name: 'Customer response target',
      priority: 10,
      conditions: {
        departmentIds: [fixture.department.id],
        priorities: ['HIGH', 'URGENT']
      },
      targets: {
        FIRST_RESPONSE: { businessSeconds: 3600, atRiskSeconds: 900 },
        RESOLUTION: { businessSeconds: 7200 }
      },
      pauseRules: {
        waitingOnCustomer: ['RESOLUTION'],
        waitingOnInternal: [],
        snoozed: [],
        automatedPublicResponseMeets: []
      },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      effectiveUntil: null
    };

    const supervisorPolicy = await inject(fixture, fixture.supervisor.email, {
      method: 'POST',
      url: '/support/config/sla-policies',
      payload: versionOnePayload
    });
    expect(supervisorPolicy.statusCode).toBe(403);

    const versionOne = await inject(fixture, fixture.owner.email, {
      method: 'POST',
      url: '/support/config/sla-policies',
      payload: versionOnePayload
    });
    expect(versionOne.statusCode).toBe(201);
    expect(versionOne.json()).toMatchObject({
      policyKey: versionOnePayload.policyKey,
      version: 1,
      active: true,
      targets: versionOnePayload.targets
    });

    const versionTwo = await inject(fixture, fixture.owner.email, {
      method: 'POST',
      url: '/support/config/sla-policies',
      payload: {
        ...versionOnePayload,
        name: 'Customer response target, revised',
        targets: {
          FIRST_RESPONSE: { businessSeconds: 1800, atRiskSeconds: 600 },
          RESOLUTION: { businessSeconds: 5400 }
        },
        effectiveFrom: '2026-08-15T00:00:00.000Z'
      }
    });
    expect(versionTwo.statusCode).toBe(201);
    expect(versionTwo.json()).toMatchObject({
      policyKey: versionOnePayload.policyKey,
      version: 2,
      active: true,
      targets: {
        FIRST_RESPONSE: { businessSeconds: 1800, atRiskSeconds: 600 },
        RESOLUTION: { businessSeconds: 5400 }
      }
    });
    expect(versionTwo.json().id).not.toBe(versionOne.json().id);

    const listed = await inject(fixture, fixture.owner.email, {
      method: 'GET',
      url: '/support/config/sla-policies'
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(2);
    expect(listed.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: versionOne.json().id,
        version: 1,
        name: versionOnePayload.name,
        targets: versionOnePayload.targets
      }),
      expect.objectContaining({
        id: versionTwo.json().id,
        version: 2,
        name: 'Customer response target, revised',
        targets: {
          FIRST_RESPONSE: { businessSeconds: 1800, atRiskSeconds: 600 },
          RESOLUTION: { businessSeconds: 5400 }
        }
      })
    ]));

    const memberPolicies = await inject(fixture, fixture.memberA.email, {
      method: 'GET',
      url: '/support/config/sla-policies'
    });
    expect(memberPolicies.statusCode).toBe(403);

    const supervisorDeactivate = await inject(fixture, fixture.supervisor.email, {
      method: 'POST',
      url: `/support/config/sla-policies/${versionOne.json().id}/deactivate`
    });
    expect(supervisorDeactivate.statusCode).toBe(403);

    const deactivated = await inject(fixture, fixture.owner.email, {
      method: 'POST',
      url: `/support/config/sla-policies/${versionOne.json().id}/deactivate`
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({
      id: versionOne.json().id,
      policyKey: versionOnePayload.policyKey,
      version: 1,
      active: false,
      name: versionOnePayload.name,
      conditions: versionOnePayload.conditions,
      targets: versionOnePayload.targets,
      pauseRules: versionOnePayload.pauseRules
    });
  });

  test('operational reports expose only assigned Cases to a member and the managed Department to its manager', async () => {
    const fixture = await createFixture();
    const from = new Date(fixture.reportNow.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(fixture.reportNow.getTime() + 60 * 60 * 1000).toISOString();
    const reportUrl = `/support/reports/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    const memberReport = await inject(fixture, fixture.memberA.email, {
      method: 'GET',
      url: `${reportUrl}&departmentId=${fixture.department.id}`
    });
    expect(memberReport.statusCode).toBe(200);
    expect(memberReport.json()).toMatchObject({
      scope: { kind: 'ASSIGNED_CASES', departmentId: fixture.department.id },
      summary: { received: 1, resolved: 0, closed: 0 },
      backlog: { open: 1 },
      privacy: { perMemberBreakdownIncluded: false }
    });
    expect(memberReport.json().queues).toEqual({ MY_CASES: 1, NEEDS_ATTENTION: 1 });
    expect(memberReport.json().breakdowns).toEqual({
      status: { OPEN: 1 },
      priority: { LOW: 1 },
      sourceChannel: { MANUAL: 1 },
      type: { own_request: 1 },
      resolutionCode: {},
      department: [{ departmentId: fixture.department.id, name: fixture.department.name, count: 1 }]
    });
    const serializedMemberReport = JSON.stringify(memberReport.json());
    expect(serializedMemberReport).not.toContain(fixture.peerTypeKey);
    expect(serializedMemberReport).not.toContain(fixture.otherDepartmentTypeKey);

    const managerReport = await inject(fixture, fixture.manager.email, {
      method: 'GET',
      url: reportUrl
    });
    expect(managerReport.statusCode).toBe(200);
    expect(managerReport.json()).toMatchObject({
      scope: { kind: 'MANAGED_DEPARTMENTS', departmentId: null },
      summary: { received: 3 },
      backlog: { open: 3 },
      privacy: { perMemberBreakdownIncluded: false }
    });
    expect(managerReport.json().queues).toEqual({
      DEPARTMENT_INBOX: 1,
      MY_CASES: 0,
      NEEDS_ATTENTION: 3
    });
    expect(managerReport.json().breakdowns).toEqual({
      status: { OPEN: 3 },
      priority: { LOW: 1, NORMAL: 1, URGENT: 1 },
      sourceChannel: { API: 1, CALL: 1, MANUAL: 1 },
      type: {
        department_inbox: 1,
        own_request: 1,
        [fixture.peerTypeKey]: 1
      },
      resolutionCode: {},
      department: [{ departmentId: fixture.department.id, name: fixture.department.name, count: 3 }]
    });
    expect(JSON.stringify(managerReport.json())).not.toContain(fixture.otherDepartmentTypeKey);

    const unmanagedDepartment = await inject(fixture, fixture.manager.email, {
      method: 'GET',
      url: `${reportUrl}&departmentId=${fixture.otherDepartment.id}`
    });
    expect(unmanagedDepartment.statusCode).toBe(404);
  });

  test('an assigned member can snooze and resume attention with optimistic Case versions', async () => {
    const fixture = await createFixture();
    const snoozedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const snoozed = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/snooze`,
      payload: {
        snoozedUntil,
        reason: 'Waiting for a scheduled customer callback',
        baseVersion: 1
      }
    });
    expect(snoozed.statusCode).toBe(200);
    expect(snoozed.json()).toMatchObject({
      id: fixture.ownCase.id,
      key: fixture.ownCase.key,
      version: 2,
      snoozedUntil,
      attentionReasons: []
    });

    const staleResume = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/resume`,
      payload: {
        reason: 'The customer called back sooner than expected',
        baseVersion: 1
      }
    });
    expect(staleResume.statusCode).toBe(409);
    expect(staleResume.json()).toMatchObject({
      code: 'SUPPORT_VERSION_CONFLICT',
      current: {
        id: fixture.ownCase.id,
        version: 2,
        snoozedUntil
      }
    });

    const resumed = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/resume`,
      payload: {
        reason: 'The customer called back sooner than expected',
        baseVersion: 2
      }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      id: fixture.ownCase.id,
      version: 3,
      snoozedUntil: null
    });
  });

  test('contact search requires intake access, rate limits callers, and audits only a query hash', async () => {
    const fixture = await createFixture();
    const query = fixture.contactQuery;
    const url = `/support/contacts/search?q=${encodeURIComponent(query)}&limit=5`;

    const denied = await inject(fixture, fixture.memberA.email, { method: 'GET', url });
    expect(denied.statusCode).toBe(403);

    const first = await inject(fixture, fixture.triager.email, { method: 'GET', url });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toEqual([{
      id: fixture.contact.id,
      name: fixture.contact.name,
      email: fixture.contact.email,
      phone: fixture.contact.phone
    }]);

    for (let attempt = 1; attempt < 20; attempt += 1) {
      const response = await inject(fixture, fixture.triager.email, { method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }

    const limited = await inject(fixture, fixture.triager.email, { method: 'GET', url });
    expect(limited.statusCode).toBe(429);
    const limitedBody = limited.json() as { message: string };
    expect(limitedBody).toEqual({ message: 'Support contact search rate limit exceeded' });

    const activity = await inject(fixture, fixture.owner.email, { method: 'GET', url: '/activity' });
    expect(activity.statusCode).toBe(200);
    const contactSearchAudit = activity.json().filter((item: { action: string }) =>
      item.action === 'support_contact_search'
      || item.action === 'support_contact_search_rate_limited'
    );
    expect(contactSearchAudit).toHaveLength(21);
    expect(contactSearchAudit.filter((item: { action: string }) => item.action === 'support_contact_search'))
      .toHaveLength(20);
    expect(contactSearchAudit.filter((item: { action: string }) => item.action === 'support_contact_search_rate_limited'))
      .toHaveLength(1);
    expect(contactSearchAudit.every((item: { after: { queryHash?: string } }) =>
      /^[a-f0-9]{64}$/.test(item.after.queryHash ?? '')
    )).toBe(true);
    expect(JSON.stringify(contactSearchAudit)).not.toContain(query);
    expect(JSON.stringify(contactSearchAudit)).not.toContain(query.toLocaleLowerCase('en-US'));
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [owner, supervisor, manager, memberA, memberB, triager, outsider] = await Promise.all(
    ['owner', 'supervisor', 'manager', 'member-a', 'member-b', 'triager', 'outsider'].map((name) =>
      prisma.user.create({
        data: { email: `${name}-${suffix}@${EMAIL_DOMAIN}`, name }
      })
    )
  );
  const workspace = await prisma.workspace.create({
    data: { name: 'Support operations', slug: `support-operations-${suffix}`, mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'SOPS', nextCaseNumber: 5 }
  });
  await prisma.workspaceMember.createMany({
    data: [owner, supervisor, manager, memberA, memberB, triager, outsider].map((user) => ({
      workspaceId: workspace.id,
      userId: user.id,
      role: user.id === owner.id ? 'OWNER' : 'MEMBER'
    }))
  });
  const [department, otherDepartment] = await Promise.all([
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Customer Care', slug: 'customer-care' }
    }),
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Private Escalations', slug: 'private-escalations' }
    })
  ]);
  const [managerMembership, memberAMembership, memberBMembership, outsiderMembership] = await Promise.all([
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: manager.id, role: 'MANAGER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberA.id, role: 'MEMBER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberB.id, role: 'MEMBER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: otherDepartment.id, userId: outsider.id, role: 'MEMBER' }
    })
  ]);
  await prisma.supportPermissionGrant.createMany({
    data: [
      { workspaceId: workspace.id, userId: supervisor.id, role: 'SUPERVISOR' },
      { workspaceId: workspace.id, userId: triager.id, role: 'TRIAGER' }
    ]
  });

  const reportNow = new Date();
  const peerTypeKey = `peer_secret_${suffix}`;
  const otherDepartmentTypeKey = `other_secret_${suffix}`;
  const [ownCase, peerCase, departmentInboxCase, otherDepartmentCase] = await Promise.all([
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 1,
        key: 'SOPS-1',
        title: 'Assigned member Case',
        sourceChannel: 'MANUAL',
        typeKey: 'own_request',
        priority: 'LOW',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberAMembership.id,
        receivedAt: new Date(reportNow.getTime() - 4 * 60 * 60 * 1000),
        firstResponseAt: new Date(reportNow.getTime() - 3 * 60 * 60 * 1000)
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 2,
        key: 'SOPS-2',
        title: 'Peer-private Case',
        sourceChannel: 'CALL',
        typeKey: peerTypeKey,
        priority: 'URGENT',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberBMembership.id,
        receivedAt: new Date(reportNow.getTime() - 3 * 60 * 60 * 1000)
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 3,
        key: 'SOPS-3',
        title: 'Department Inbox Case',
        sourceChannel: 'API',
        typeKey: 'department_inbox',
        status: 'OPEN',
        departmentId: department.id,
        receivedAt: new Date(reportNow.getTime() - 2 * 60 * 60 * 1000)
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 4,
        key: 'SOPS-4',
        title: 'Other Department private Case',
        sourceChannel: 'EMAIL',
        typeKey: otherDepartmentTypeKey,
        priority: 'HIGH',
        status: 'OPEN',
        departmentId: otherDepartment.id,
        assigneeMembershipId: outsiderMembership.id,
        receivedAt: new Date(reportNow.getTime() - 60 * 60 * 1000)
      }
    })
  ]);

  const contactQuery = `Lookup Plaintext ${suffix}`;
  const contact = await prisma.supportContact.create({
    data: {
      workspaceId: workspace.id,
      name: `Customer ${contactQuery}`,
      email: `lookup-${suffix}@example.test`,
      normalizedEmail: `lookup-${suffix}@example.test`,
      phone: '+41 79 555 01 23',
      normalizedPhone: '+41795550123'
    }
  });

  return {
    workspace,
    owner,
    supervisor,
    manager,
    memberA,
    memberB,
    triager,
    outsider,
    department,
    otherDepartment,
    managerMembership,
    memberAMembership,
    memberBMembership,
    outsiderMembership,
    ownCase,
    peerCase,
    departmentInboxCase,
    otherDepartmentCase,
    reportNow,
    peerTypeKey,
    otherDepartmentTypeKey,
    contact,
    contactQuery
  };
}

function headers(workspaceSlug: string, email: string): Record<string, string> {
  return { 'x-workspace-slug': workspaceSlug, 'x-user-email': email };
}

function inject(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  email: string,
  options: Omit<InjectOptions, 'headers'>
) {
  return app.inject({ ...options, headers: headers(fixture.workspace.slug, email) });
}
