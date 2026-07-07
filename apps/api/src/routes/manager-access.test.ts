import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type WorkspaceRole } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { createUserSession } from '../services/auth';
import { appendSyncEvent } from '../services/sync';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];

describe('manager route access boundaries', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (!workspaceId) continue;
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  test('attention list and lifecycle are scoped to workspace admins or the attention owner', async () => {
    const fixture = await createFixture();

    const adminList = await injectAs(fixture, 'admin', { method: 'GET', url: '/attention?generate=false&status=ALL' });
    expect(adminList.statusCode).toBe(200);
    expect(ids(adminList.json().items)).toContain(fixture.attention.member.id);
    expect(ids(adminList.json().items)).toContain(fixture.attention.outsider.id);

    const memberList = await injectAs(fixture, 'member', { method: 'GET', url: '/attention?generate=false&status=ALL' });
    expect(memberList.statusCode).toBe(200);
    expect(ids(memberList.json().items)).toContain(fixture.attention.member.id);
    expect(ids(memberList.json().items)).not.toContain(fixture.attention.outsider.id);

    const deniedResolve = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/attention/${fixture.attention.outsider.id}/resolve`
    });
    expect(deniedResolve.statusCode).toBe(404);

    const allowedResolve = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/attention/${fixture.attention.member.id}/resolve`
    });
    expect(allowedResolve.statusCode).toBe(200);
    expect(allowedResolve.json().status).toBe('RESOLVED');
  });

  test('review routes hide restricted tasks and allow only the assigned reviewer to decide', async () => {
    const fixture = await createFixture();

    const outsiderList = await injectAs(fixture, 'outsider', {
      method: 'GET',
      url: `/tasks/${fixture.tasks.review.key}/reviews`
    });
    expect(outsiderList.statusCode).toBe(404);

    const memberDecision = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/reviews/${fixture.review.id}/approve`,
      payload: { comment: 'Looks fine' }
    });
    expect(memberDecision.statusCode).toBe(403);

    const reviewerDecision = await injectAs(fixture, 'reviewer', {
      method: 'POST',
      url: `/reviews/${fixture.review.id}/approve`,
      payload: { comment: 'Approved' }
    });
    expect(reviewerDecision.statusCode).toBe(200);
    expect(reviewerDecision.json().status).toBe('APPROVED');
  });

  test('assignment recommendations require project access and exclude outside-team candidates', async () => {
    const fixture = await createFixture();

    const denied = await injectAs(fixture, 'outsider', {
      method: 'POST',
      url: '/assignment/recommend',
      payload: { projectId: fixture.projects.restricted.id, title: 'Restricted assignment' }
    });
    expect(denied.statusCode).toBe(404);

    const allowed = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/assignment/recommend',
      payload: { projectId: fixture.projects.restricted.id, title: 'Restricted assignment', limit: 20 }
    });
    expect(allowed.statusCode).toBe(200);
    const recommendedUserIds = ids(allowed.json().recommendations.map((item: { user: { id: string } }) => item.user));
    expect(recommendedUserIds).toContain(fixture.users.member.id);
    expect(recommendedUserIds).toContain(fixture.users.reviewer.id);
    expect(recommendedUserIds).not.toContain(fixture.users.outsider.id);
    expect(allowed.json().excluded.outsideProjectMembership).toBeGreaterThan(0);
  });

  test('triage cannot mutate backlog tasks outside the actor scope', async () => {
    const fixture = await createFixture();

    const denied = await injectAs(fixture, 'outsider', {
      method: 'POST',
      url: `/triage/tasks/${fixture.tasks.backlog.key}/accept`,
      payload: {
        assigneeId: fixture.users.member.id,
        priority: 'HIGH',
        weight: 2,
        comment: 'Accepted'
      }
    });
    expect(denied.statusCode).toBe(404);

    const reloaded = await prisma.task.findUniqueOrThrow({ where: { id: fixture.tasks.backlog.id } });
    expect(reloaded.status).toBe('BACKLOG');

    const deniedSnooze = await injectAs(fixture, 'outsider', {
      method: 'POST',
      url: `/triage/tasks/${fixture.tasks.backlog.key}/snooze`,
      payload: {
        snoozedUntil: '2026-07-08T09:00:00.000Z',
        reason: 'Waiting for planning'
      }
    });
    expect(deniedSnooze.statusCode).toBe(404);

    const deniedSplit = await injectAs(fixture, 'outsider', {
      method: 'POST',
      url: `/triage/tasks/${fixture.tasks.backlog.key}/split`,
      payload: {
        items: [{ title: 'First child' }, { title: 'Second child' }],
        reason: 'Too large'
      }
    });
    expect(deniedSplit.statusCode).toBe(404);

    const allowedSplit = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: `/triage/tasks/${fixture.tasks.backlog.key}/split`,
      payload: {
        items: [{ title: 'Clarify scope' }, { title: 'Build first slice' }],
        reason: 'Original intake was too broad'
      }
    });
    expect(allowedSplit.statusCode).toBe(200);
    expect(allowedSplit.json().task.status).toBe('CANCELED');
    expect(allowedSplit.json().items).toHaveLength(2);
    expect(allowedSplit.json().items.every((item: { status: string; parentId: string }) => item.status === 'BACKLOG' && item.parentId === fixture.tasks.backlog.id)).toBe(true);

    const splitOriginal = await prisma.task.findUniqueOrThrow({ where: { id: fixture.tasks.backlog.id } });
    expect(splitOriginal.status).toBe('CANCELED');
  });

  test('check-in and 1:1 routes keep admin cadence and participant privacy rules', async () => {
    const fixture = await createFixture();

    const memberMissing = await injectAs(fixture, 'member', { method: 'GET', url: '/check-ins/missing?hours=24' });
    expect(memberMissing.statusCode).toBe(403);

    const adminMissing = await injectAs(fixture, 'admin', { method: 'GET', url: '/check-ins/missing?hours=24' });
    expect(adminMissing.statusCode).toBe(200);
    expect(adminMissing.json().total).toBeGreaterThan(0);

    const managerAgenda = await injectAs(fixture, 'member', {
      method: 'GET',
      url: `/one-on-ones/${fixture.oneOnOne.id}/agenda`
    });
    expect(managerAgenda.statusCode).toBe(200);

    const participantAgenda = await injectAs(fixture, 'reviewer', {
      method: 'GET',
      url: `/one-on-ones/${fixture.oneOnOne.id}/agenda`
    });
    expect(participantAgenda.statusCode).toBe(200);

    const unrelatedAgenda = await injectAs(fixture, 'outsider', {
      method: 'GET',
      url: `/one-on-ones/${fixture.oneOnOne.id}/agenda`
    });
    expect(unrelatedAgenda.statusCode).toBe(403);
  });

  test('meeting action items are listed and mutated only through meeting access', async () => {
    const fixture = await createFixture();

    const participantList = await injectAs(fixture, 'reviewer', { method: 'GET', url: '/meeting-action-items?status=ALL' });
    expect(participantList.statusCode).toBe(200);
    expect(ids(participantList.json().items)).toContain(fixture.actionItem.id);

    const outsiderList = await injectAs(fixture, 'outsider', { method: 'GET', url: '/meeting-action-items?status=ALL' });
    expect(outsiderList.statusCode).toBe(200);
    expect(ids(outsiderList.json().items)).not.toContain(fixture.actionItem.id);

    const deniedComplete = await injectAs(fixture, 'outsider', {
      method: 'POST',
      url: `/meeting-action-items/${fixture.actionItem.id}/complete`
    });
    expect(deniedComplete.statusCode).toBe(404);

    const reloaded = await prisma.meetingActionItem.findUniqueOrThrow({ where: { id: fixture.actionItem.id } });
    expect(reloaded.status).toBe('OPEN');
  });

  test('project health updates allow project leads outside the team and deny unrelated members', async () => {
    const fixture = await createFixture();

    const leadCreate = await injectAs(fixture, 'lead', {
      method: 'POST',
      url: `/projects/${fixture.projects.restricted.id}/updates`,
      payload: {
        health: 'AT_RISK',
        summary: 'Launch depends on a manager decision.',
        risks: 'Approval is late',
        decisionsNeeded: 'Choose a reduced launch scope'
      }
    });
    expect(leadCreate.statusCode).toBe(201);
    expect(leadCreate.json().authorId).toBe(fixture.users.lead.id);

    const leadList = await injectAs(fixture, 'lead', {
      method: 'GET',
      url: `/projects/${fixture.projects.restricted.id}/updates`
    });
    expect(leadList.statusCode).toBe(200);
    expect(ids(leadList.json().items)).toContain(leadCreate.json().id);

    const outsiderList = await injectAs(fixture, 'outsider', {
      method: 'GET',
      url: `/projects/${fixture.projects.restricted.id}/updates`
    });
    expect(outsiderList.statusCode).toBe(404);
  });

  test('sync bootstrap and pull do not leak restricted task or manager events', async () => {
    const fixture = await createFixture();
    await emitAttentionEvent(fixture, fixture.attention.member.id);
    await emitAttentionEvent(fixture, fixture.attention.outsider.id);

    const adminBootstrap = await injectAs(fixture, 'admin', { method: 'GET', url: '/sync/bootstrap?scope=tasks&teamId=all' });
    expect(adminBootstrap.statusCode).toBe(200);
    expect(ids(adminBootstrap.json().tasks)).toContain(fixture.tasks.backlog.id);

    const outsiderBootstrap = await injectAs(fixture, 'outsider', { method: 'GET', url: '/sync/bootstrap?scope=tasks&teamId=all' });
    expect(outsiderBootstrap.statusCode).toBe(200);
    expect(ids(outsiderBootstrap.json().tasks)).not.toContain(fixture.tasks.backlog.id);

    const memberPull = await injectAs(fixture, 'member', { method: 'GET', url: '/sync/pull?scope=tasks&teamId=all&cursor=0&limit=50' });
    expect(memberPull.statusCode).toBe(200);
    const memberAttentionIds = memberPull
      .json()
      .events.filter((event: { entityType: string }) => event.entityType === 'attention')
      .map((event: { entity?: { id?: string } }) => event.entity?.id);
    expect(memberAttentionIds).toContain(fixture.attention.member.id);
    expect(memberAttentionIds).not.toContain(fixture.attention.outsider.id);
  });

  test('sync push applies attention lifecycle mutations durably and rejects unauthorized ones', async () => {
    const fixture = await createFixture();

    const denied = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'attention-denied',
            name: 'attention.resolve',
            args: { id: fixture.attention.outsider.id }
          }
        ]
      }
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().results[0].status).toBe('rejected');
    expect((await prisma.attentionItem.findUniqueOrThrow({ where: { id: fixture.attention.outsider.id } })).status).toBe('OPEN');

    const allowed = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'attention-allowed',
            name: 'attention.resolve',
            args: { id: fixture.attention.member.id }
          }
        ]
      }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().results[0].status).toBe('applied');
    expect(allowed.json().results[0].entity.status).toBe('RESOLVED');
    expect((await prisma.attentionItem.findUniqueOrThrow({ where: { id: fixture.attention.member.id } })).status).toBe('RESOLVED');
  });

  test('sync push applies 1:1 agenda and meeting action item mutations with access checks', async () => {
    const fixture = await createFixture();

    const agendaCreate = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'agenda-create',
            name: 'one_on_one_agenda_item.create',
            args: {
              seriesId: fixture.oneOnOne.id,
              item: { title: 'Discuss staffing risk', notes: 'Bring latest blockers.' }
            }
          }
        ]
      }
    });
    expect(agendaCreate.statusCode).toBe(200);
    expect(agendaCreate.json().results[0].status).toBe('applied');
    expect(agendaCreate.json().results[0].entity.title).toBe('Discuss staffing risk');

    const deniedComplete = await injectAs(fixture, 'outsider', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'action-complete-denied',
            name: 'meeting_action_item.complete',
            args: { id: fixture.actionItem.id }
          }
        ]
      }
    });
    expect(deniedComplete.statusCode).toBe(200);
    expect(deniedComplete.json().results[0].status).toBe('rejected');
    expect((await prisma.meetingActionItem.findUniqueOrThrow({ where: { id: fixture.actionItem.id } })).status).toBe('OPEN');

    const allowedComplete = await injectAs(fixture, 'reviewer', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'action-complete-allowed',
            name: 'meeting_action_item.complete',
            args: { id: fixture.actionItem.id }
          }
        ]
      }
    });
    expect(allowedComplete.statusCode).toBe(200);
    expect(allowedComplete.json().results[0].status).toBe('applied');
    expect(allowedComplete.json().results[0].entity.status).toBe('DONE');
  });

  test('sync push can convert a visible meeting action item into a linked task', async () => {
    const fixture = await createFixture();

    const result = await injectAs(fixture, 'reviewer', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'action-create-task',
            name: 'meeting_action_item.create_task',
            args: { id: fixture.actionItem.id, task: {} }
          }
        ]
      }
    });

    expect(result.statusCode).toBe(200);
    expect(result.json().results[0].status).toBe('applied');
    expect(result.json().results[0].entity.actionItem.status).toBe('DONE');
    expect(result.json().results[0].entity.task.key.startsWith('RST')).toBe(true);

    const actionItem = await prisma.meetingActionItem.findUniqueOrThrow({ where: { id: fixture.actionItem.id } });
    expect(actionItem.status).toBe('DONE');
    expect(typeof actionItem.taskId).toBe('string');
  });

  test('sync push creates project health updates through project access policy', async () => {
    const fixture = await createFixture();

    const denied = await injectAs(fixture, 'outsider', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'project-health-denied',
            name: 'project_health_update.create',
            args: {
              projectId: fixture.projects.restricted.id,
              update: { health: 'AT_RISK', summary: 'Should not save' }
            }
          }
        ]
      }
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().results[0].status).toBe('rejected');

    const allowed = await injectAs(fixture, 'lead', {
      method: 'POST',
      url: '/sync/push',
      payload: {
        clientId: 'manager-access-test-client',
        mutations: [
          {
            mutationId: 'project-health-allowed',
            name: 'project_health_update.create',
            args: {
              projectId: fixture.projects.restricted.id,
              update: {
                health: 'AT_RISK',
                summary: 'Launch depends on a manager decision.',
                risks: 'Approval is late',
                decisionsNeeded: 'Choose a reduced launch scope'
              }
            }
          }
        ]
      }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().results[0].status).toBe('applied');
    expect(allowed.json().results[0].entity.projectId).toBe(fixture.projects.restricted.id);
    expect(allowed.json().results[0].entity.authorId).toBe(fixture.users.lead.id);
  });
});

type Persona = 'owner' | 'admin' | 'member' | 'reviewer' | 'outsider' | 'lead';

interface ManagerAccessFixture {
  workspace: { id: string; slug: string };
  users: Record<Persona, { id: string; email: string; name: string }>;
  sessions: Record<Persona, string>;
  teams: { restricted: { id: string; slug: string } };
  projects: { restricted: { id: string }; public: { id: string } };
  tasks: { active: { id: string; key: string }; backlog: { id: string; key: string }; review: { id: string; key: string } };
  review: { id: string };
  attention: { member: { id: string }; outsider: { id: string } };
  oneOnOne: { id: string };
  actionItem: { id: string };
}

async function createFixture(): Promise<ManagerAccessFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Manager Access ${suffix}`,
      slug: `manager-access-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const users = {
    owner: await createUser(`owner-${suffix}`, 'Owner'),
    admin: await createUser(`admin-${suffix}`, 'Admin'),
    member: await createUser(`member-${suffix}`, 'Member'),
    reviewer: await createUser(`reviewer-${suffix}`, 'Reviewer'),
    outsider: await createUser(`outsider-${suffix}`, 'Outsider'),
    lead: await createUser(`lead-${suffix}`, 'Lead')
  };

  await prisma.workspaceMember.createMany({
    data: [
      workspaceMember(workspace.id, users.owner.id, 'OWNER'),
      workspaceMember(workspace.id, users.admin.id, 'ADMIN'),
      workspaceMember(workspace.id, users.member.id, 'MEMBER'),
      workspaceMember(workspace.id, users.reviewer.id, 'MEMBER'),
      workspaceMember(workspace.id, users.outsider.id, 'MEMBER'),
      workspaceMember(workspace.id, users.lead.id, 'MEMBER')
    ]
  });

  const restrictedTeam = await prisma.team.create({
    data: {
      workspaceId: workspace.id,
      name: 'Restricted Team',
      slug: `restricted-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 50)
    },
    select: { id: true, slug: true }
  });

  await prisma.teamMember.createMany({
    data: [
      { teamId: restrictedTeam.id, userId: users.member.id, role: 'MEMBER' },
      { teamId: restrictedTeam.id, userId: users.reviewer.id, role: 'MEMBER' }
    ]
  });

  const restrictedProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: restrictedTeam.id,
      leadId: users.lead.id,
      name: 'Restricted Project',
      keyPrefix: uniquePrefix('RST')
    },
    select: { id: true }
  });
  const publicProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Public Project',
      keyPrefix: uniquePrefix('PUB')
    },
    select: { id: true }
  });

  const activeTask = await createTask(workspace.id, restrictedProject.id, 1, 'Active restricted task', 'TODO', users.member.id);
  const backlogTask = await createTask(workspace.id, restrictedProject.id, 2, 'Backlog restricted task', 'BACKLOG', null);
  const reviewTask = await createTask(workspace.id, restrictedProject.id, 3, 'Review restricted task', 'IN_REVIEW', users.member.id);
  await createTask(workspace.id, publicProject.id, 1, 'Public task', 'TODO', users.outsider.id);

  const review = await prisma.taskReviewRequest.create({
    data: {
      workspaceId: workspace.id,
      taskId: reviewTask.id,
      requesterId: users.member.id,
      reviewerId: users.reviewer.id,
      dueAt: new Date(Date.now() + 60 * 60 * 1000)
    },
    select: { id: true }
  });

  const memberAttention = await createAttention(workspace.id, users.member.id, activeTask.id, 'Member attention');
  const outsiderAttention = await createAttention(workspace.id, users.outsider.id, publicProject.id, 'Outsider attention');

  const oneOnOne = await prisma.oneOnOneSeries.create({
    data: {
      workspaceId: workspace.id,
      managerId: users.member.id,
      participantId: users.reviewer.id,
      title: 'Member / Reviewer 1:1',
      nextScheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    },
    select: { id: true }
  });

  const meeting = await prisma.meeting.create({
    data: {
      workspaceId: workspace.id,
      teamId: restrictedTeam.id,
      projectId: restrictedProject.id,
      ownerId: users.member.id,
      createdById: users.member.id,
      title: 'Restricted sync'
    },
    select: { id: true }
  });
  await prisma.meetingParticipant.createMany({
    data: [
      { workspaceId: workspace.id, meetingId: meeting.id, userId: users.member.id, role: 'OWNER' },
      { workspaceId: workspace.id, meetingId: meeting.id, userId: users.reviewer.id, role: 'PARTICIPANT' }
    ]
  });
  const actionItem = await prisma.meetingActionItem.create({
    data: {
      workspaceId: workspace.id,
      meetingId: meeting.id,
      assigneeId: users.reviewer.id,
      createdById: users.member.id,
      title: 'Follow up from sync'
    },
    select: { id: true }
  });

  const sessions = Object.fromEntries(
    await Promise.all(
      (Object.entries(users) as Array<[Persona, { id: string }]>).map(async ([key, user]) => {
        const session = await createUserSession(user.id);
        return [key, session.token] as const;
      })
    )
  ) as Record<Persona, string>;

  return {
    workspace,
    users,
    sessions,
    teams: { restricted: restrictedTeam },
    projects: { restricted: restrictedProject, public: publicProject },
    tasks: { active: activeTask, backlog: backlogTask, review: reviewTask },
    review,
    attention: { member: memberAttention, outsider: outsiderAttention },
    oneOnOne,
    actionItem
  };
}

async function injectAs(fixture: ManagerAccessFixture, persona: Persona, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      authorization: `Bearer ${fixture.sessions[persona]}`,
      'x-workspace-slug': fixture.workspace.slug,
      ...(options.headers || {})
    }
  });
}

async function createUser(key: string, name: string) {
  return prisma.user.create({
    data: {
      email: `${key}@manager-access.test`.toLowerCase(),
      name
    },
    select: { id: true, email: true, name: true }
  });
}

function workspaceMember(workspaceId: string, userId: string, role: WorkspaceRole) {
  return { workspaceId, userId, role };
}

async function createTask(
  workspaceId: string,
  projectId: string,
  sequence: number,
  title: string,
  status: 'BACKLOG' | 'TODO' | 'IN_REVIEW',
  assigneeId: string | null
) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { keyPrefix: true } });
  return prisma.task.create({
    data: {
      workspaceId,
      projectId,
      sequence,
      key: `${project.keyPrefix}-${sequence}`,
      title,
      status,
      priority: 'HIGH',
      weight: 2,
      assigneeId
    },
    select: { id: true, key: true }
  });
}

async function createAttention(workspaceId: string, assigneeId: string, entityId: string, title: string) {
  return prisma.attentionItem.create({
    data: {
      workspaceId,
      assigneeId,
      entityType: 'task',
      entityId,
      reason: `manual_${entityId}`,
      severity: 'HIGH',
      payload: {
        version: 1,
        title,
        description: 'Needs manager attention',
        actionLabel: 'Open',
        reason: 'manual',
        severity: 'HIGH',
        entity: { type: 'task', id: entityId },
        signal: { conditionKey: `manual:${entityId}`, generatedAt: new Date().toISOString() }
      }
    },
    select: { id: true }
  });
}

async function emitAttentionEvent(fixture: ManagerAccessFixture, attentionId: string) {
  const attention = await prisma.attentionItem.findUniqueOrThrow({ where: { id: attentionId } });
  await prisma.$transaction((tx) => appendSyncEvent(tx, {
    workspaceId: fixture.workspace.id,
    entityType: 'attention',
    entityId: attention.id,
    operation: 'updated',
    actorId: fixture.users.owner.id,
    payload: {
      after: {
        id: attention.id,
        workspaceId: attention.workspaceId,
        assigneeId: attention.assigneeId,
        managerId: attention.managerId,
        entityType: attention.entityType,
        entityId: attention.entityId,
        reason: attention.reason,
        severity: attention.severity,
        status: attention.status
      }
    }
  }));
}

function ids(items: Array<{ id?: string }>): string[] {
  return items.map((item) => item.id).filter((id): id is string => Boolean(id));
}

function uniquePrefix(base: string): string {
  return `${base}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}
