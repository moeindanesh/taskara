import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import {
  createSupportRoutingPolicySchema,
  selectCapacityAwareMember,
  suggestSupportPriority,
  supportRoutingRuleMismatches
} from '../services/support-routing';
import { registerSupportRoutingRoutes } from './support-routing';

const EMAIL_DOMAIN = 'support-routing.test';
const cleanupWorkspaceIds: string[] = [];
let app: FastifyInstance;

describe('deterministic Support routing', () => {
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
    await app.register(registerSupportRoutingRoutes);
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
  });

  test('uses strict typed conditions, an impact-by-urgency matrix, and stable capacity tie-breaks', () => {
    const withUnmodelledContactTags = createSupportRoutingPolicySchema.safeParse({
      rules: [{
        order: 1,
        name: 'No metadata conventions',
        conditions: { contactTags: ['vip'] },
        action: { targetDepartmentId: crypto.randomUUID() }
      }]
    });
    expect(withUnmodelledContactTags.success).toBe(false);
    expect(createSupportRoutingPolicySchema.safeParse({
      rules: [
        { order: 1, name: 'A', action: { targetDepartmentId: crypto.randomUUID() } },
        { order: 1, name: 'B', action: { targetDepartmentId: crypto.randomUUID() } }
      ]
    }).success).toBe(false);

    expect(supportRoutingRuleMismatches({
      typeKey: 'incident',
      priority: 'HIGH',
      sourceChannel: 'CALL',
      impact: null,
      urgency: 'HIGH'
    }, {
      caseTypeKeys: ['incident'],
      priorities: ['HIGH'],
      sourceChannels: ['CALL'],
      impacts: ['HIGH'],
      urgencies: ['HIGH']
    })).toEqual(['IMPACT_MISSING']);

    expect(suggestSupportPriority('HIGH', 'MEDIUM')).toBe('URGENT');
    expect(suggestSupportPriority('LOW', 'LOW')).toBe('LOW');
    expect(suggestSupportPriority(null, 'HIGH')).toBeNull();

    const selected = selectCapacityAwareMember([
      {
        membershipId: '00000000-0000-4000-8000-000000000002',
        active: true,
        available: true,
        capacity: 4,
        activeCaseLoad: 2,
        skills: ['billing']
      },
      {
        membershipId: '00000000-0000-4000-8000-000000000001',
        active: true,
        available: true,
        capacity: 2,
        activeCaseLoad: 1,
        skills: ['billing']
      }
    ], ['billing']);
    expect(selected?.membershipId).toBe('00000000-0000-4000-8000-000000000001');
  });

  test('creates immutable ordered policy versions and atomically activates only the newest choice', async () => {
    const fixture = await createFixture();
    const first = await createPolicy(fixture, {
      label: 'Initial',
      activate: true,
      rules: [{
        order: 10,
        name: 'Initial route',
        conditions: { caseTypeKeys: ['request'] },
        action: { targetDepartmentId: fixture.primary.id }
      }]
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ version: 1, active: true, label: 'Initial' });

    const second = await createPolicy(fixture, {
      label: 'Replacement',
      activate: true,
      rules: [{
        order: 1,
        name: 'Replacement route',
        conditions: { sourceChannels: ['API'] },
        action: { targetDepartmentId: fixture.secondary.id }
      }]
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ version: 2, active: true, label: 'Replacement' });

    const policies = await app.inject({
      method: 'GET',
      url: '/support/routing/policies',
      headers: headers(fixture, fixture.owner.email)
    });
    expect(policies.statusCode).toBe(200);
    expect(policies.json().items.map((policy: { version: number; active: boolean }) => ({
      version: policy.version,
      active: policy.active
    }))).toEqual([
      { version: 2, active: true },
      { version: 1, active: false }
    ]);

    const managerDenied = await app.inject({
      method: 'POST',
      url: '/support/routing/policies',
      headers: headers(fixture, fixture.manager.email),
      payload: {
        rules: [{
          order: 1,
          name: 'Manager cannot configure policy',
          action: { targetDepartmentId: fixture.primary.id }
        }]
      }
    });
    expect(managerDenied.statusCode).toBe(403);
  });

  test('selects by capacity while redacting peer load from triagers and supervisors', async () => {
    const fixture = await createFixture({ withPeerLoad: true });
    await configureCapacity(fixture, fixture.memberA.email, {
      routingAvailability: 'AVAILABLE',
      routingCapacity: 4,
      routingSkills: ['billing']
    });
    await configureCapacity(fixture, fixture.memberB.email, {
      routingAvailability: 'AVAILABLE',
      routingCapacity: 1,
      routingSkills: ['billing']
    });
    const policy = await createPolicy(fixture, {
      activate: true,
      rules: [
        {
          order: 1,
          name: 'Urgent calls first',
          conditions: { priorities: ['URGENT'], sourceChannels: ['CALL'] },
          action: { targetDepartmentId: fixture.secondary.id }
        },
        {
          order: 2,
          name: 'Billing requests',
          conditions: {
            caseTypeKeys: ['request'],
            sourceChannels: ['API'],
            impacts: ['HIGH'],
            urgencies: ['MEDIUM']
          },
          action: {
            targetDepartmentId: fixture.primary.id,
            assignmentMode: 'CAPACITY_AWARE',
            requiredSkills: ['billing']
          }
        }
      ]
    });
    expect(policy.statusCode).toBe(201);

    const triagerSimulation = await simulate(fixture, fixture.triager.email);
    expect(triagerSimulation.statusCode).toBe(200);
    expect(triagerSimulation.json()).toMatchObject({
      outcome: 'ROUTE',
      evaluatedRules: [
        { order: 1, result: 'NO_MATCH', mismatches: ['PRIORITY', 'SOURCE_CHANNEL'] },
        { order: 2, result: 'MATCH', mismatches: [] }
      ],
      route: {
        departmentId: fixture.primary.id,
        assignment: {
          mode: 'CAPACITY_AWARE',
          result: 'MEMBER_SELECTED',
          capacityDetailsRedacted: true
        }
      },
      prioritySuggestion: { suggestedPriority: 'URGENT', requiresHumanDecision: true }
    });
    const triagerBody = JSON.stringify(triagerSimulation.json());
    expect(triagerBody).not.toContain('activeCaseLoad');
    expect(triagerBody).not.toContain('availableSlots');
    expect(triagerBody).not.toContain(fixture.memberAMembership.id);
    expect(triagerBody).not.toContain(fixture.memberBMembership.id);
    expect(triagerBody).not.toContain(fixture.peerSecret);

    const supervisorSimulation = await simulate(fixture, fixture.supervisor.email);
    expect(supervisorSimulation.statusCode).toBe(200);
    expect(supervisorSimulation.json().route.assignment.capacityDetailsRedacted).toBe(true);
    expect(JSON.stringify(supervisorSimulation.json())).not.toContain('activeCaseLoad');

    const ownerSimulation = await simulate(fixture, fixture.owner.email);
    expect(ownerSimulation.statusCode).toBe(200);
    expect(ownerSimulation.json().route.assignment).toMatchObject({
      capacityDetailsRedacted: false,
      selectedMember: {
        membershipId: fixture.memberBMembership.id,
        activeCaseLoad: 0,
        capacity: 1,
        availableSlots: 1
      }
    });
    expect(ownerSimulation.json().decisionFingerprint).toBe(triagerSimulation.json().decisionFingerprint);

    for (const [email, expected] of [
      [fixture.owner.email, 200],
      [fixture.manager.email, 200],
      [fixture.triager.email, 404],
      [fixture.supervisor.email, 404],
      [fixture.memberA.email, 404]
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/support/routing/departments/${fixture.primary.id}/members`,
        headers: headers(fixture, email)
      });
      expect(response.statusCode).toBe(expected);
    }
  });

  test('requires baseVersion, routes through the invariant-safe command, and audits the matched rule', async () => {
    const fixture = await createFixture();
    await configureCapacity(fixture, fixture.memberB.email, {
      routingAvailability: 'AVAILABLE',
      routingCapacity: 2,
      routingSkills: ['billing']
    });
    await createPolicy(fixture, {
      activate: true,
      rules: [{
        order: 1,
        name: 'Billing requests',
        conditions: { caseTypeKeys: ['request'] },
        action: {
          targetDepartmentId: fixture.primary.id,
          assignmentMode: 'CAPACITY_AWARE',
          requiredSkills: ['billing']
        }
      }]
    });

    const stale = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/routing/apply`,
      headers: headers(fixture, fixture.triager.email),
      payload: { baseVersion: fixture.triageCase.version + 1 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('SUPPORT_VERSION_CONFLICT');

    const applied = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/routing/apply`,
      headers: headers(fixture, fixture.triager.email),
      payload: { baseVersion: fixture.triageCase.version }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      outcome: 'ROUTED',
      applied: true,
      case: {
        id: fixture.triageCase.id,
        version: fixture.triageCase.version + 1,
        departmentId: fixture.primary.id
      },
      assignment: { result: 'MEMBER_SELECTED', capacityDetailsRedacted: true }
    });
    expect(JSON.stringify(applied.json())).not.toContain(fixture.memberBMembership.id);

    const stored = await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.triageCase.id } });
    expect(stored).toMatchObject({
      departmentId: fixture.primary.id,
      assigneeMembershipId: fixture.memberBMembership.id,
      status: 'OPEN',
      version: fixture.triageCase.version + 1
    });
    const event = await prisma.supportCaseEvent.findFirstOrThrow({
      where: { caseId: fixture.triageCase.id, action: 'case.routed' }
    });
    expect(event.reason).toContain('Deterministic routing policy v1');
    expect(event.reason).toContain('rule 1');
  });

  test('keeps the Case in Triage and records the fallback when no safe route exists', async () => {
    const fixture = await createFixture();
    await createPolicy(fixture, {
      activate: true,
      rules: [{
        order: 1,
        name: 'Incident only',
        conditions: { caseTypeKeys: ['incident'] },
        action: { targetDepartmentId: fixture.primary.id }
      }]
    });

    const noMatch = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/routing/apply`,
      headers: headers(fixture, fixture.triager.email),
      payload: { baseVersion: fixture.triageCase.version }
    });
    expect(noMatch.statusCode).toBe(200);
    expect(noMatch.json()).toMatchObject({
      outcome: 'TRIAGE',
      applied: true,
      fallbackReason: 'NO_MATCHING_RULE',
      route: null,
      caseVersion: fixture.triageCase.version
    });
    expect(await prisma.supportCase.findUniqueOrThrow({
      where: { id: fixture.triageCase.id },
      select: { departmentId: true, assigneeMembershipId: true, version: true }
    })).toEqual({ departmentId: null, assigneeMembershipId: null, version: fixture.triageCase.version });
    expect(await prisma.supportCaseEvent.findFirst({
      where: { caseId: fixture.triageCase.id, action: 'case.routing_fallback_to_triage' },
      select: { reason: true }
    })).toMatchObject({ reason: expect.stringContaining('NO_MATCHING_RULE') });

    await prisma.department.update({
      where: { id: fixture.primary.id },
      data: { active: false }
    });
    const unavailableFixtureCase = await prisma.supportCase.create({
      data: {
        workspaceId: fixture.workspace.id,
        sequence: 99,
        key: 'SROUT-99',
        title: 'Unavailable target remains safely in Triage',
        sourceChannel: 'API',
        typeKey: 'incident'
      }
    });
    const unsafe = await simulate(fixture, fixture.owner.email, unavailableFixtureCase.key, unavailableFixtureCase.version);
    expect(unsafe.statusCode).toBe(200);
    expect(unsafe.json()).toMatchObject({
      outcome: 'TRIAGE',
      fallbackReason: 'TARGET_DEPARTMENT_UNAVAILABLE',
      route: null
    });
  });

  test('audits human acceptance and override of the impact-by-urgency priority suggestion', async () => {
    const fixture = await createFixture();
    const accepted = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/routing/priority`,
      headers: headers(fixture, fixture.triager.email),
      payload: { decision: 'ACCEPT_SUGGESTION', baseVersion: fixture.triageCase.version }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      case: { priority: 'URGENT', version: fixture.triageCase.version + 1 },
      priorityDecision: {
        decision: 'ACCEPT_SUGGESTION',
        suggestion: 'URGENT',
        appliedPriority: 'URGENT'
      }
    });

    const overridden = await app.inject({
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/routing/priority`,
      headers: headers(fixture, fixture.triager.email),
      payload: {
        decision: 'OVERRIDE',
        priority: 'HIGH',
        reason: 'Known workaround lowers immediate business risk',
        baseVersion: fixture.triageCase.version + 1
      }
    });
    expect(overridden.statusCode).toBe(200);
    expect(overridden.json()).toMatchObject({
      case: { priority: 'HIGH', version: fixture.triageCase.version + 2 },
      priorityDecision: { decision: 'OVERRIDE', suggestion: 'URGENT', appliedPriority: 'HIGH' }
    });
    expect(await prisma.supportCaseEvent.findMany({
      where: { caseId: fixture.triageCase.id },
      orderBy: { sequence: 'asc' },
      select: { action: true, reason: true }
    })).toEqual([
      {
        action: 'case.priority_suggestion_accepted',
        reason: 'Human accepted impact-by-urgency suggestion URGENT'
      },
      {
        action: 'case.priority_suggestion_overridden',
        reason: expect.stringContaining('Known workaround lowers immediate business risk')
      }
    ]);
  });
});

interface FixtureOptions {
  withPeerLoad?: boolean;
}

async function createFixture(options: FixtureOptions = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [owner, manager, memberA, memberB, triager, supervisor] = await Promise.all(
    ['owner', 'manager', 'member-a', 'member-b', 'triager', 'supervisor'].map((name) =>
      prisma.user.create({
        data: { email: `${name}-${suffix}@${EMAIL_DOMAIN}`, name }
      })
    )
  );
  const workspace = await prisma.workspace.create({
    data: { name: 'Support routing', slug: `support-routing-${suffix}`, mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'SROUT', nextCaseNumber: 100 }
  });
  await prisma.workspaceMember.createMany({
    data: [owner, manager, memberA, memberB, triager, supervisor].map((user) => ({
      workspaceId: workspace.id,
      userId: user.id,
      role: user.id === owner.id ? 'OWNER' : 'MEMBER'
    }))
  });
  const [primary, secondary] = await Promise.all([
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Primary', slug: 'primary' }
    }),
    prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Secondary', slug: 'secondary' }
    })
  ]);
  const [managerMembership, memberAMembership, memberBMembership] = await Promise.all([
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: primary.id, userId: manager.id, role: 'MANAGER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: primary.id, userId: memberA.id }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: primary.id, userId: memberB.id }
    })
  ]);
  await prisma.supportPermissionGrant.createMany({
    data: [
      { workspaceId: workspace.id, userId: triager.id, role: 'TRIAGER' },
      { workspaceId: workspace.id, userId: supervisor.id, role: 'SUPERVISOR' }
    ]
  });
  const triageCase = await prisma.supportCase.create({
    data: {
      workspaceId: workspace.id,
      sequence: 1,
      key: 'SROUT-1',
      title: 'Billing request from API',
      sourceChannel: 'API',
      typeKey: 'request',
      priority: 'NORMAL',
      impact: 'HIGH',
      urgency: 'MEDIUM'
    }
  });
  const peerSecret = `peer-secret-${suffix}`;
  if (options.withPeerLoad) {
    await prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 2,
        key: 'SROUT-2',
        title: peerSecret,
        sourceChannel: 'CALL',
        typeKey: 'incident',
        status: 'OPEN',
        departmentId: primary.id,
        assigneeMembershipId: memberAMembership.id
      }
    });
  }
  return {
    workspace,
    owner,
    manager,
    memberA,
    memberB,
    triager,
    supervisor,
    primary,
    secondary,
    managerMembership,
    memberAMembership,
    memberBMembership,
    triageCase,
    peerSecret
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function headers(fixture: Fixture, email: string) {
  return { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': email };
}

async function createPolicy(fixture: Fixture, payload: InjectOptions['payload']) {
  return await app.inject({
    method: 'POST',
    url: '/support/routing/policies',
    headers: headers(fixture, fixture.owner.email),
    payload
  });
}

async function configureCapacity(fixture: Fixture, email: string, payload: InjectOptions['payload']) {
  const user = [fixture.memberA, fixture.memberB].find((candidate) => candidate.email === email);
  if (!user) throw new Error('Capacity fixture user not found');
  const response = await app.inject({
    method: 'PATCH',
    url: `/support/routing/departments/${fixture.primary.id}/members/${user.id}`,
    headers: headers(fixture, fixture.manager.email),
    payload
  });
  if (response.statusCode !== 200) throw new Error(response.body);
  return response;
}

function simulate(
  fixture: Fixture,
  email: string,
  caseKey = fixture.triageCase.key,
  baseVersion = fixture.triageCase.version
) {
  return app.inject({
    method: 'POST',
    url: `/support/cases/${caseKey}/routing/simulate`,
    headers: headers(fixture, email),
    payload: { baseVersion }
  });
}
