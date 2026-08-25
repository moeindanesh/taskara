import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import type { RequestActor } from '../services/actor';
import { HttpError, errorMessage, statusCodeFromError } from '../services/http';
import { evaluateSupportRecoveryWorkspace } from '../services/support-recovery-evaluator';
import { createLinkedTaskFromSupportCase } from '../services/support-links';
import { registerSupportHandoffRoutes } from './support-handoff';
import { registerSupportRoutes } from './support';
import { registerTaskRoutes } from './tasks';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];
const EMAIL_DOMAIN = 'support-handoff.test';

describe('Support Case to Team Task handoff', () => {
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
    await app.register(registerSupportRoutes);
    await app.register(registerTaskRoutes);
    await app.register(registerSupportHandoffRoutes);
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
      await prisma.task.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('configures an allowlisted target before either independent approval activates the connection', async () => {
    const fixture = await createFixture();
    const created = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: '/workspace-connections',
      payload: { teamWorkspaceId: fixture.teamWorkspace.id }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      replayed: false,
      connection: { status: 'PENDING', currentWorkspaceSide: 'SUPPORT', currentApproved: false, otherApproved: false }
    });
    const connectionId = created.json().connection.id as string;

    const premature = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/workspace-connections/${connectionId}/approve`,
      payload: { side: 'SUPPORT' }
    });
    expect(premature.statusCode).toBe(409);

    const configured = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: '/support/department-work-targets',
      payload: {
        connectionId,
        departmentId: fixture.department.id,
        projectId: fixture.project.id,
        allowCreateTasks: true,
        allowLinkTasks: true
      }
    });
    expect(configured.statusCode).toBe(201);
    expect(configured.json()).toMatchObject({
      replayed: false,
      target: {
        connectionId,
        department: { id: fixture.department.id },
        project: { name: fixture.project.name },
        connectionStatus: 'PENDING'
      }
    });

    const supportApproval = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/workspace-connections/${connectionId}/approve`,
      payload: { side: 'SUPPORT' }
    });
    expect(supportApproval.statusCode).toBe(200);
    expect(supportApproval.json()).toMatchObject({ status: 'PENDING', currentApproved: true, otherApproved: false });

    const frozenTarget = await injectSupport(fixture, fixture.admin.email, {
      method: 'PATCH',
      url: `/support/department-work-targets/${configured.json().target.id}`,
      payload: { allowCreateTasks: false }
    });
    expect(frozenTarget.statusCode).toBe(409);

    const teamApproval = await injectTeam(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/workspace-connections/${connectionId}/approve`,
      payload: { side: 'TEAM' }
    });
    expect(teamApproval.statusCode).toBe(200);
    expect(teamApproval.json()).toMatchObject({ status: 'ACTIVE', currentApproved: true, otherApproved: true });
  });

  test('returns exact redacted projections and enforces replay-safe idempotency', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const idempotencyKey = `link-${crypto.randomUUID()}`;
    const payload = {
      workTargetId: setup.targetId,
      taskId: fixture.task.id,
      relationType: 'FIX_WORK',
      handoffTitle: 'Retry login for jane@example.com at +41 79 123 45 67',
      handoffSummary: `Approved delivery brief ${fixture.privateMarker}`,
      baseVersion: 1,
      idempotencyKey
    };

    const linked = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/task-links`,
      payload
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json()).toMatchObject({ replayed: false, caseVersion: 2, accessEpoch: '1' });
    expect(Object.keys(linked.json().link).sort()).toEqual([
      'lastSignalAt', 'linkId', 'projectionVersion', 'status', 'taskKey', 'teamWorkspaceName', 'title', 'tombstone'
    ].sort());
    expect(linked.json().link.title).toBe('Retry login for [redacted-email] at [redacted-phone]');

    const serializedSupportProjection = JSON.stringify(linked.json());
    for (const forbidden of [
      fixture.supportCase.id,
      fixture.task.id,
      fixture.supportWorkspace.id,
      fixture.teamWorkspace.id,
      fixture.privateMarker,
      fixture.supportCase.title
    ]) {
      expect(serializedSupportProjection).not.toContain(forbidden);
    }

    const replayed = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/task-links`,
      payload
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ replayed: true, caseVersion: 2, link: { linkId: linked.json().link.linkId } });

    const conflict = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/task-links`,
      payload: { ...payload, handoffTitle: 'A different approved title', baseVersion: 2 }
    });
    expect(conflict.statusCode).toBe(409);

    const supportList = await injectSupport(fixture, fixture.admin.email, {
      method: 'GET',
      url: `/support/cases/${fixture.supportCase.key}/task-links`
    });
    expect(supportList.statusCode).toBe(200);
    expect(supportList.json()).toMatchObject({ caseVersion: 2, accessEpoch: '1', items: [{ linkId: linked.json().link.linkId }] });

    const teamList = await injectTeam(fixture, fixture.admin.email, {
      method: 'GET',
      url: `/tasks/${fixture.task.key}/support-case-links`
    });
    expect(teamList.statusCode).toBe(200);
    expect(Object.keys(teamList.json().items[0]).sort()).toEqual([
      'caseKey', 'lastSignalAt', 'linkId', 'projectionVersion', 'status', 'supportWorkspaceName', 'title', 'tombstone'
    ].sort());
    expect(teamList.json().items[0]).toMatchObject({
      caseKey: fixture.supportCase.key,
      title: 'Retry login for [redacted-email] at [redacted-phone]',
      status: 'OPEN'
    });
    const serializedTeamProjection = JSON.stringify(teamList.json());
    expect(serializedTeamProjection).not.toContain(fixture.supportCase.id);
    expect(serializedTeamProjection).not.toContain(fixture.privateMarker);
    expect(serializedTeamProjection).not.toContain(fixture.supportCase.title);
  });

  test('denies a Team project viewer even when that same human can work the Support Case', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const denied = await injectSupport(fixture, fixture.viewer.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/task-links`,
      payload: {
        workTargetId: setup.targetId,
        taskId: fixture.task.id,
        relationType: 'FIX_WORK',
        handoffTitle: 'Approved viewer test',
        handoffSummary: 'The same human still needs write authority on the Team project.',
        baseVersion: 1,
        idempotencyKey: `viewer-${crypto.randomUUID()}`
      }
    });
    expect(denied.statusCode).toBe(403);
    expect(await prisma.supportCaseTaskLink.count({ where: { caseId: fixture.supportCase.id } })).toBe(0);
  });

  test('rejects a composed Team comment beyond the published comment ceiling', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const denied = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/task-links`,
      payload: {
        workTargetId: setup.targetId,
        taskId: fixture.task.id,
        relationType: 'FIX_WORK',
        handoffTitle: 'Approved bounded comment test',
        handoffSummary: 'x'.repeat(15_000),
        baseVersion: 1,
        idempotencyKey: `comment-limit-${crypto.randomUUID()}`
      }
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().message).toContain('Team Task comment');
    expect(await prisma.supportCaseTaskLink.count({ where: { caseId: fixture.supportCase.id } })).toBe(0);
    expect(await prisma.taskComment.count({ where: { taskId: fixture.task.id } })).toBe(0);
  });

  test('rolls Task creation and its key reservation back with the link, then retries once', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const input = {
      workTargetId: setup.targetId,
      relationType: 'FIX_WORK' as const,
      handoffTitle: 'Approved implementation title',
      handoffSummary: 'Only this reviewed brief crosses into Team work.',
      taskTitle: 'Implement approved Support fix',
      taskDescription: 'No private Case description is copied.',
      taskPriority: 'HIGH' as const,
      baseVersion: 1,
      idempotencyKey: `create-${crypto.randomUUID()}`
    };

    await expect(createLinkedTaskFromSupportCase(
      supportActor(fixture),
      fixture.supportCase.key,
      input,
      { afterTaskCreated: () => { throw new Error('injected handoff failure'); } }
    )).rejects.toThrow('injected handoff failure');

    expect(await prisma.task.count({ where: { projectId: fixture.project.id, title: input.taskTitle } })).toBe(0);
    expect(await prisma.supportCaseTaskLink.count({ where: { caseId: fixture.supportCase.id } })).toBe(0);
    expect((await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } })).version).toBe(1);

    const created = await createLinkedTaskFromSupportCase(supportActor(fixture), fixture.supportCase.key, input);
    expect(created).toMatchObject({ replayed: false, caseVersion: 2 });
    expect(await prisma.task.count({ where: { projectId: fixture.project.id, title: input.taskTitle } })).toBe(1);
    expect(await prisma.supportCaseTaskLink.count({ where: { caseId: fixture.supportCase.id } })).toBe(1);

    const replayed = await createLinkedTaskFromSupportCase(supportActor(fixture), fixture.supportCase.key, input);
    expect(replayed).toMatchObject({ replayed: true, caseVersion: 2, link: { linkId: created.link.linkId } });
    expect(await prisma.task.count({ where: { projectId: fixture.project.id, title: input.taskTitle } })).toBe(1);
  });

  test('Task signals advance and notify each affected Case once, even with multiple links', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const first = await linkExistingTask(fixture, setup.targetId);
    const second = await linkSameTask(fixture, setup.targetId, 'INVESTIGATION', first.caseVersion);

    const started = await injectTeam(fixture, fixture.teamUpdater.email, {
      method: 'PATCH',
      url: `/tasks/${fixture.task.key}`,
      payload: { status: 'IN_PROGRESS' }
    });
    expect(started.statusCode).toBe(200);
    const afterStarted = await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } });
    expect(afterStarted.version).toBe(second.caseVersion + 1);
    expect(afterStarted.nextActionAt).toBeNull();
    expect(await prisma.supportCaseEvent.count({
      where: { caseId: fixture.supportCase.id, action: 'case.linked_task_status_changed' }
    })).toBe(1);
    expect(await prisma.notification.count({
      where: {
        workspaceId: fixture.supportWorkspace.id,
        userId: fixture.admin.id,
        type: 'SUPPORT_LINKED_TASK_SIGNAL'
      }
    })).toBe(1);

    const completed = await injectTeam(fixture, fixture.teamUpdater.email, {
      method: 'PATCH',
      url: `/tasks/${fixture.task.key}`,
      payload: { status: 'DONE' }
    });
    expect(completed.statusCode).toBe(200);

    const [supportCase, link, notifications] = await Promise.all([
      prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } }),
      prisma.supportCaseTaskLink.findMany({ where: { caseId: fixture.supportCase.id } }),
      prisma.notification.findMany({ where: { workspaceId: fixture.supportWorkspace.id, userId: fixture.admin.id } })
    ]);
    expect(supportCase.status).toBe('OPEN');
    expect(supportCase.version).toBe(second.caseVersion + 2);
    expect(supportCase.nextActionAt).not.toBeNull();
    expect(link).toHaveLength(2);
    expect(link.every((item) => item.taskStatusSnapshot === 'DONE')).toBe(true);
    expect(notifications.filter((notification) => notification.type === 'SUPPORT_LINKED_TASK_SIGNAL')).toHaveLength(2);
    expect(await prisma.supportCaseEvent.count({
      where: { caseId: fixture.supportCase.id, action: 'case.linked_task_status_changed' }
    })).toBe(2);
  });

  test('Task deletion leaves a tombstone and materializes recovery attention', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const first = await linkExistingTask(fixture, setup.targetId);
    const second = await linkSameTask(fixture, setup.targetId, 'INVESTIGATION', first.caseVersion);

    const deleted = await injectTeam(fixture, fixture.teamUpdater.email, {
      method: 'DELETE',
      url: `/tasks/${fixture.task.key}`
    });
    expect(deleted.statusCode).toBe(204);

    const links = await prisma.supportCaseTaskLink.findMany({ where: { caseId: fixture.supportCase.id } });
    expect(links).toHaveLength(2);
    expect(links.every((link) => !link.taskId && !link.taskWorkspaceId && link.taskDeletedAt)).toBe(true);
    expect(await prisma.supportCase.count({ where: { id: fixture.supportCase.id } })).toBe(1);
    expect((await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } })).version)
      .toBe(second.caseVersion + 1);
    expect(await prisma.supportCaseEvent.count({
      where: { caseId: fixture.supportCase.id, action: 'case.linked_task_deleted' }
    })).toBe(1);
    expect(await prisma.notification.count({
      where: { workspaceId: fixture.supportWorkspace.id, type: 'SUPPORT_LINKED_TASK_SIGNAL' }
    })).toBe(1);
    expect(await prisma.task.count({ where: { id: fixture.task.id } })).toBe(0);

    await evaluateSupportRecoveryWorkspace(fixture.supportWorkspace.id, new Date());
    const attention = await prisma.attentionItem.findUnique({
      where: {
        workspaceId_entityType_entityId_reason: {
          workspaceId: fixture.supportWorkspace.id,
          entityType: 'support_case',
          entityId: fixture.supportCase.id,
          reason: 'LINKED_TASK_BLOCKED_OR_OVERDUE'
        }
      }
    });
    expect(attention).toMatchObject({ status: 'OPEN', reason: 'LINKED_TASK_BLOCKED_OR_OVERDUE' });

    const projection = await injectSupport(fixture, fixture.admin.email, {
      method: 'GET',
      url: `/support/cases/${fixture.supportCase.key}/task-links`
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json().items).toHaveLength(2);
    expect(projection.json().items.every((item: { tombstone: { taskDeletedAt: string | null } }) => (
      item.tombstone.taskDeletedAt !== null
    ))).toBe(true);
  });

  test('unlinking deletes neither aggregate', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const linked = await linkExistingTask(fixture, setup.targetId);

    const unlinked = await injectSupport(fixture, fixture.admin.email, {
      method: 'DELETE',
      url: `/support/cases/${fixture.supportCase.key}/task-links/${linked.link.linkId}`,
      payload: { baseVersion: linked.caseVersion, reason: 'Delivery work is no longer relevant.' }
    });
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json().link.tombstone.unlinkedAt).not.toBeNull();
    expect(await prisma.supportCase.count({ where: { id: fixture.supportCase.id } })).toBe(1);
    expect(await prisma.task.count({ where: { id: fixture.task.id } })).toBe(1);

    const [caseBeforeDelete, frozenLink, eventCount, notificationCount, crossWorkspaceSyncCount] = await Promise.all([
      prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } }),
      prisma.supportCaseTaskLink.findUniqueOrThrow({ where: { id: linked.link.linkId } }),
      prisma.supportCaseEvent.count({ where: { caseId: fixture.supportCase.id } }),
      prisma.notification.count({ where: { workspaceId: fixture.supportWorkspace.id } }),
      prisma.syncEvent.count({
        where: {
          OR: [
            { entityType: 'support_case_task_link', entityId: linked.link.linkId },
            { entityType: 'support_case', entityId: fixture.supportCase.id }
          ]
        }
      })
    ]);
    const deleted = await injectTeam(fixture, fixture.teamUpdater.email, {
      method: 'DELETE',
      url: `/tasks/${fixture.task.key}`
    });
    expect(deleted.statusCode).toBe(204);
    const historical = await prisma.supportCaseTaskLink.findUniqueOrThrow({ where: { id: linked.link.linkId } });
    expect(historical.taskDeletedAt).not.toBeNull();
    expect(historical.version).toBe(frozenLink.version + 1);
    expect((await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } })).version)
      .toBe(caseBeforeDelete.version);
    expect(await prisma.supportCaseEvent.count({ where: { caseId: fixture.supportCase.id } })).toBe(eventCount);
    expect(await prisma.notification.count({ where: { workspaceId: fixture.supportWorkspace.id } })).toBe(notificationCount);
    expect(await prisma.syncEvent.count({
      where: {
        OR: [
          { entityType: 'support_case_task_link', entityId: linked.link.linkId },
          { entityType: 'support_case', entityId: fixture.supportCase.id }
        ]
      }
    })).toBe(crossWorkspaceSyncCount);
    const frozenProjection = await injectSupport(fixture, fixture.admin.email, {
      method: 'GET',
      url: `/support/cases/${fixture.supportCase.key}/task-links`
    });
    expect(frozenProjection.json().items[0].tombstone.taskDeletedAt).toBeNull();
  });

  test('revocation freezes projections and blocks new links without erasing history', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const linked = await linkExistingTask(fixture, setup.targetId);

    const revoked = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/workspace-connections/${setup.connectionId}/revoke`,
      payload: { reason: 'The approved delivery boundary changed.' }
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'REVOKED' });
    const frozen = await prisma.supportCaseTaskLink.findUniqueOrThrow({ where: { id: linked.link.linkId } });
    const caseAfterRevoke = await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } });
    expect(caseAfterRevoke.version).toBe(linked.caseVersion + 1);
    expect(await prisma.syncEvent.count({
      where: {
        workspaceId: fixture.supportWorkspace.id,
        entityType: 'support_case',
        entityId: fixture.supportCase.id,
        entityVersion: caseAfterRevoke.version
      }
    })).toBe(1);
    const teamProjection = await injectTeam(fixture, fixture.admin.email, {
      method: 'GET',
      url: `/tasks/${fixture.task.key}/support-case-links`
    });
    expect(teamProjection.statusCode).toBe(200);
    expect(teamProjection.json().items[0].tombstone.connectionRevokedAt).not.toBeNull();

    const updated = await injectTeam(fixture, fixture.teamUpdater.email, {
      method: 'PATCH',
      url: `/tasks/${fixture.task.key}`,
      payload: { status: 'BLOCKED' }
    });
    expect(updated.statusCode).toBe(200);
    const afterSignal = await prisma.supportCaseTaskLink.findUniqueOrThrow({ where: { id: linked.link.linkId } });
    expect(afterSignal.version).toBe(frozen.version);
    expect(afterSignal.taskStatusSnapshot).toBe(frozen.taskStatusSnapshot);
    expect((await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } })).version)
      .toBe(caseAfterRevoke.version);

    const blocked = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/task-links`,
      payload: {
        workTargetId: setup.targetId,
        taskId: fixture.secondTask.id,
        relationType: 'FIX_WORK',
        handoffTitle: 'A new handoff after revocation',
        handoffSummary: 'This must not cross a revoked connection.',
        baseVersion: linked.caseVersion,
        idempotencyKey: `revoked-${crypto.randomUUID()}`
      }
    });
    expect(blocked.statusCode).toBe(400);
    expect(await prisma.supportCaseTaskLink.count({ where: { caseId: fixture.supportCase.id } })).toBe(1);

    const unlinkAfterRevoke = await injectSupport(fixture, fixture.admin.email, {
      method: 'DELETE',
      url: `/support/cases/${fixture.supportCase.key}/task-links/${linked.link.linkId}`,
      payload: { baseVersion: caseAfterRevoke.version, reason: 'Must stay frozen after revocation.' }
    });
    expect(unlinkAfterRevoke.statusCode).toBe(409);

    const [eventCount, notificationCount, crossWorkspaceSyncCount] = await Promise.all([
      prisma.supportCaseEvent.count({ where: { caseId: fixture.supportCase.id } }),
      prisma.notification.count({ where: { workspaceId: fixture.supportWorkspace.id } }),
      prisma.syncEvent.count({
        where: {
          OR: [
            { entityType: 'support_case_task_link', entityId: linked.link.linkId },
            { entityType: 'support_case', entityId: fixture.supportCase.id }
          ]
        }
      })
    ]);
    const deleted = await injectTeam(fixture, fixture.teamUpdater.email, {
      method: 'DELETE',
      url: `/tasks/${fixture.task.key}`
    });
    expect(deleted.statusCode).toBe(204);
    const afterDelete = await prisma.supportCaseTaskLink.findUniqueOrThrow({ where: { id: linked.link.linkId } });
    expect(afterDelete.taskDeletedAt).not.toBeNull();
    expect(afterDelete.version).toBe(frozen.version + 1);
    expect((await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } })).version)
      .toBe(caseAfterRevoke.version);
    expect(await prisma.supportCaseEvent.count({ where: { caseId: fixture.supportCase.id } })).toBe(eventCount);
    expect(await prisma.notification.count({ where: { workspaceId: fixture.supportWorkspace.id } })).toBe(notificationCount);
    expect(await prisma.syncEvent.count({
      where: {
        OR: [
          { entityType: 'support_case_task_link', entityId: linked.link.linkId },
          { entityType: 'support_case', entityId: fixture.supportCase.id }
        ]
      }
    })).toBe(crossWorkspaceSyncCount);

    const supportProjection = await injectSupport(fixture, fixture.admin.email, {
      method: 'GET',
      url: `/support/cases/${fixture.supportCase.key}/task-links`
    });
    expect(supportProjection.statusCode).toBe(200);
    expect(supportProjection.json().items[0].tombstone).toMatchObject({
      connectionRevokedAt: expect.any(String),
      taskDeletedAt: null
    });
  });

  test('Case lifecycle publishes only a coarse status signal to Team projections', async () => {
    const fixture = await createFixture();
    const setup = await configureAndActivate(fixture);
    const linked = await linkExistingTask(fixture, setup.targetId);

    const resolved = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/resolve`,
      payload: { resolutionCode: 'FIXED', resolutionSummary: 'Verified by Support.', baseVersion: linked.caseVersion }
    });
    expect(resolved.statusCode).toBe(200);
    expect(await teamProjectionStatus(fixture)).toBe('RESOLVED');

    const closed = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/close`,
      payload: { confirmation: 'CUSTOMER_CONFIRMED', baseVersion: resolved.json().version }
    });
    expect(closed.statusCode).toBe(200);
    expect(await teamProjectionStatus(fixture)).toBe('CLOSED');

    const reopened = await injectSupport(fixture, fixture.admin.email, {
      method: 'POST',
      url: `/support/cases/${fixture.supportCase.key}/reopen`,
      payload: { reason: 'The customer reproduced the problem.', baseVersion: closed.json().version }
    });
    expect(reopened.statusCode).toBe(200);
    expect(await teamProjectionStatus(fixture)).toBe('OPEN');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).status).toBe('TODO');
  });
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [admin, viewer, teamUpdater] = await Promise.all([
    prisma.user.create({ data: { email: `admin-${suffix}@${EMAIL_DOMAIN}`, name: 'Dual workspace admin' } }),
    prisma.user.create({ data: { email: `viewer-${suffix}@${EMAIL_DOMAIN}`, name: 'Team viewer' } }),
    prisma.user.create({ data: { email: `updater-${suffix}@${EMAIL_DOMAIN}`, name: 'Team updater' } })
  ]);
  const [supportWorkspace, teamWorkspace] = await Promise.all([
    prisma.workspace.create({
      data: { name: `Support ${suffix}`, slug: `support-handoff-${suffix}`, mode: 'SUPPORT' }
    }),
    prisma.workspace.create({
      data: { name: `Team ${suffix}`, slug: `team-handoff-${suffix}`, mode: 'TEAM' }
    })
  ]);
  cleanupWorkspaceIds.push(supportWorkspace.id, teamWorkspace.id);
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: supportWorkspace.id, userId: admin.id, role: 'OWNER' },
      { workspaceId: teamWorkspace.id, userId: admin.id, role: 'OWNER' },
      { workspaceId: supportWorkspace.id, userId: viewer.id, role: 'OWNER' },
      { workspaceId: teamWorkspace.id, userId: viewer.id, role: 'GUEST' },
      { workspaceId: teamWorkspace.id, userId: teamUpdater.id, role: 'OWNER' }
    ]
  });
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: supportWorkspace.id, keyPrefix: `SH${suffix.slice(0, 4).toUpperCase()}`, nextCaseNumber: 2 }
  });
  const department = await prisma.department.create({
    data: { workspaceId: supportWorkspace.id, name: 'Product Support', slug: `product-${suffix}` }
  });
  const adminDepartmentMembership = await prisma.departmentMember.create({
    data: {
      workspaceId: supportWorkspace.id,
      departmentId: department.id,
      userId: admin.id,
      role: 'MANAGER'
    }
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: teamWorkspace.id,
      name: `Delivery ${suffix}`,
      keyPrefix: `HD${suffix.slice(0, 4).toUpperCase()}`,
      nextTaskNumber: 3
    }
  });
  await prisma.projectMember.create({
    data: { projectId: project.id, userId: viewer.id, role: 'VIEWER' }
  });
  const [task, secondTask] = await Promise.all([
    prisma.task.create({
      data: {
        workspaceId: teamWorkspace.id,
        projectId: project.id,
        sequence: 1,
        key: `${project.keyPrefix}-1`,
        title: 'Existing delivery Task',
        status: 'TODO'
      }
    }),
    prisma.task.create({
      data: {
        workspaceId: teamWorkspace.id,
        projectId: project.id,
        sequence: 2,
        key: `${project.keyPrefix}-2`,
        title: 'Second delivery Task',
        status: 'TODO'
      }
    })
  ]);
  const privateMarker = `PRIVATE-${suffix}`;
  const supportCase = await prisma.supportCase.create({
    data: {
      workspaceId: supportWorkspace.id,
      sequence: 1,
      key: `SH${suffix.slice(0, 4).toUpperCase()}-1`,
      title: `Private requester details ${privateMarker}`,
      description: `Internal Case narrative ${privateMarker}`,
      sourceChannel: 'CALL',
      typeKey: 'incident',
      status: 'OPEN',
      departmentId: department.id,
      assigneeMembershipId: adminDepartmentMembership.id
    }
  });
  return {
    admin,
    viewer,
    teamUpdater,
    supportWorkspace,
    teamWorkspace,
    department,
    project,
    task,
    secondTask,
    supportCase,
    privateMarker
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function configureAndActivate(fixture: Fixture): Promise<{ connectionId: string; targetId: string }> {
  const created = await injectSupport(fixture, fixture.admin.email, {
    method: 'POST',
    url: '/workspace-connections',
    payload: { teamWorkspaceId: fixture.teamWorkspace.id }
  });
  expect(created.statusCode).toBe(201);
  const connectionId = created.json().connection.id as string;
  const configured = await injectSupport(fixture, fixture.admin.email, {
    method: 'POST',
    url: '/support/department-work-targets',
    payload: {
      connectionId,
      departmentId: fixture.department.id,
      projectId: fixture.project.id,
      allowCreateTasks: true,
      allowLinkTasks: true
    }
  });
  expect(configured.statusCode).toBe(201);
  const targetId = configured.json().target.id as string;
  const supportApproval = await injectSupport(fixture, fixture.admin.email, {
    method: 'POST',
    url: `/workspace-connections/${connectionId}/approve`,
    payload: { side: 'SUPPORT' }
  });
  expect(supportApproval.statusCode).toBe(200);
  const teamApproval = await injectTeam(fixture, fixture.admin.email, {
    method: 'POST',
    url: `/workspace-connections/${connectionId}/approve`,
    payload: { side: 'TEAM' }
  });
  expect(teamApproval.statusCode).toBe(200);
  expect(teamApproval.json().status).toBe('ACTIVE');
  return { connectionId, targetId };
}

async function linkExistingTask(fixture: Fixture, targetId: string) {
  const response = await injectSupport(fixture, fixture.admin.email, {
    method: 'POST',
    url: `/support/cases/${fixture.supportCase.key}/task-links`,
    payload: {
      workTargetId: targetId,
      taskId: fixture.task.id,
      relationType: 'FIX_WORK',
      handoffTitle: 'Approved delivery handoff',
      handoffSummary: 'This is the reviewed minimum brief.',
      baseVersion: 1,
      idempotencyKey: `link-${crypto.randomUUID()}`
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { link: { linkId: string }; replayed: boolean; caseVersion: number; accessEpoch: string };
}

async function linkSameTask(
  fixture: Fixture,
  targetId: string,
  relationType: 'FIX_WORK' | 'INVESTIGATION' | 'RELATED',
  baseVersion: number
) {
  const response = await injectSupport(fixture, fixture.admin.email, {
    method: 'POST',
    url: `/support/cases/${fixture.supportCase.key}/task-links`,
    payload: {
      workTargetId: targetId,
      taskId: fixture.task.id,
      relationType,
      handoffTitle: `Approved ${relationType.toLowerCase()} handoff`,
      handoffSummary: 'This second relation is independently reviewed.',
      baseVersion,
      idempotencyKey: `link-${relationType.toLowerCase()}-${crypto.randomUUID()}`
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { link: { linkId: string }; replayed: boolean; caseVersion: number; accessEpoch: string };
}

async function teamProjectionStatus(fixture: Fixture): Promise<string> {
  const response = await injectTeam(fixture, fixture.admin.email, {
    method: 'GET',
    url: `/tasks/${fixture.task.key}/support-case-links`
  });
  expect(response.statusCode).toBe(200);
  return response.json().items[0].status as string;
}

function supportActor(fixture: Fixture): RequestActor {
  return {
    workspace: fixture.supportWorkspace,
    user: fixture.admin,
    role: 'OWNER',
    actorType: 'USER',
    actorRuntime: null,
    source: 'WEB'
  };
}

function injectSupport(fixture: Fixture, email: string, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      'x-workspace-slug': fixture.supportWorkspace.slug,
      'x-user-email': email,
      ...(options.headers || {})
    }
  });
}

function injectTeam(fixture: Fixture, email: string, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      'x-workspace-slug': fixture.teamWorkspace.slug,
      'x-user-email': email,
      ...(options.headers || {})
    }
  });
}
