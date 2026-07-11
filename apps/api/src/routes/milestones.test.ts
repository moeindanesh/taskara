import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type WorkspaceRole } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { appendMilestoneProgressSyncEvents } from '../services/milestones';
import { appendSyncEvent } from '../services/sync';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];

describe('milestone routes and invariants', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    const userIds = cleanupUserIds.splice(0);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('round-trips date-only values and derives transparent progress and overdue boundaries', async () => {
    const fixture = await createFixture();
    const today = dateOnly(0);
    const milestone = await createMilestone(fixture, 'owner', {
      projectId: fixture.projects.primary.id,
      name: 'Public beta',
      kind: 'PHASE',
      ownerId: fixture.users.member.id,
      startsOn: dateOnly(-10),
      targetOn: dateOnly(10)
    });

    await createTask(fixture, fixture.projects.primary.id, 'Open', 'TODO', 1, milestone.id);
    await createTask(fixture, fixture.projects.primary.id, 'Done', 'DONE', 3, milestone.id);
    await createTask(fixture, fixture.projects.primary.id, 'Canceled', 'CANCELED', 5, milestone.id);
    await createTask(fixture, fixture.projects.primary.id, 'Blocked overdue', 'BLOCKED', 2, milestone.id, new Date(Date.now() - 86_400_000));

    const detail = await injectAs(fixture, 'member', { method: 'GET', url: `/milestones/${milestone.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().startsOn).toBe(dateOnly(-10));
    expect(detail.json().targetOn).toBe(dateOnly(10));
    expect(detail.json().progress).toEqual({
      totalTasks: 4,
      eligibleTasks: 3,
      completedTasks: 1,
      canceledTasks: 1,
      blockedTasks: 1,
      overdueTasks: 1,
      totalWeight: 6,
      completedWeight: 3,
      percentage: 33
    });
    expect(detail.json().readyToComplete).toBe(false);

    const empty = await createMilestone(fixture, 'owner', {
      projectId: fixture.projects.primary.id,
      name: 'Empty scope',
      kind: 'FEATURE'
    });
    expect(empty.progress.percentage).toBeNull();
    expect(empty.progress.eligibleTasks).toBe(0);

    const yesterday = await createMilestone(fixture, 'owner', {
      projectId: fixture.projects.primary.id,
      name: 'Yesterday',
      kind: 'OTHER',
      targetOn: dateOnly(-1)
    });
    const dueToday = await createMilestone(fixture, 'owner', {
      projectId: fixture.projects.primary.id,
      name: 'Due today',
      kind: 'OTHER',
      targetOn: today
    });
    const overdue = await injectAs(fixture, 'member', { method: 'GET', url: '/milestones?overdue=true&limit=200' });
    expect(overdue.statusCode).toBe(200);
    expect(ids(overdue.json().items)).toContain(yesterday.id);
    expect(ids(overdue.json().items)).not.toContain(dueToday.id);

    const firstPage = await injectAs(fixture, 'member', { method: 'GET', url: '/milestones?limit=1&offset=0' });
    const secondPage = await injectAs(fixture, 'member', { method: 'GET', url: '/milestones?limit=1&offset=1' });
    expect(firstPage.json().total).toBe(4);
    expect(firstPage.json().items).toHaveLength(1);
    expect(secondPage.json().items).toHaveLength(1);
    expect(firstPage.json().items[0].id).toBe(yesterday.id);
    expect(secondPage.json().items[0].id).not.toBe(firstPage.json().items[0].id);
    const allPages = await injectAs(fixture, 'member', { method: 'GET', url: '/milestones?limit=200&offset=0' });
    expect(ids(allPages.json().items)).toContain(empty.id);
    expect(allPages.json().items).toHaveLength(allPages.json().total);

    const invalidDate = await injectAs(fixture, 'owner', {
      method: 'POST',
      url: '/milestones',
      payload: {
        projectId: fixture.projects.primary.id,
        name: 'Impossible date',
        kind: 'PHASE',
        startsOn: '2026-02-30'
      }
    });
    expect(invalidDate.statusCode).toBe(400);

    const reversedRange = await injectAs(fixture, 'owner', {
      method: 'PATCH',
      url: `/milestones/${milestone.id}`,
      payload: { version: milestone.version, startsOn: dateOnly(20) }
    });
    expect(reversedRange.statusCode).toBe(400);
  });

  test('accepts a client-allocated UUID once and rejects collisions deterministically', async () => {
    const fixture = await createFixture();
    const id = crypto.randomUUID();
    const payload = {
      id,
      projectId: fixture.projects.primary.id,
      name: 'Client id',
      kind: 'FEATURE'
    };
    const created = await injectAs(fixture, 'member', { method: 'POST', url: '/milestones', payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().id).toBe(id);
    const duplicate = await injectAs(fixture, 'member', { method: 'POST', url: '/milestones', payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().message).toBe('Milestone id already exists');
  });

  test('requires an explicit unfinished-work policy across completion, cancel, archive, restore, and reactivation', async () => {
    const fixture = await createFixture();
    const source = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Source phase',
      kind: 'PHASE'
    });
    const target = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Next phase',
      kind: 'PHASE'
    });
    const openOne = await createTask(fixture, fixture.projects.primary.id, 'Open one', 'TODO', 1, source.id);
    const openTwo = await createTask(fixture, fixture.projects.primary.id, 'Open two', 'BLOCKED', 2, source.id);
    const done = await createTask(fixture, fixture.projects.primary.id, 'Done', 'DONE', 3, source.id);

    const implicit = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/complete`,
      payload: { version: source.version }
    });
    expect(implicit.statusCode).toBe(409);

    const kept = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/complete`,
      payload: { version: source.version, unfinishedTaskPolicy: 'KEEP', note: 'Deliberately retained' }
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().milestone.status).toBe('COMPLETED');
    expect(kept.json().disposition).toEqual({ policy: 'KEEP', affectedTasks: 2, targetMilestoneId: null });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: openOne.id } })).milestoneId).toBe(source.id);

    const linkedTerminalTask = await injectAs(fixture, 'member', { method: 'GET', url: `/tasks/${openOne.key}` });
    expect(linkedTerminalTask.statusCode).toBe(200);
    expect(linkedTerminalTask.json().milestone.status).toBe('COMPLETED');

    const reopened = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/reopen`,
      payload: { version: kept.json().milestone.version }
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe('ACTIVE');
    expect(reopened.json().completedAt).toBeNull();

    const canceled = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/cancel`,
      payload: { version: reopened.json().version, unfinishedTaskPolicy: 'UNASSIGN' }
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().milestone.status).toBe('CANCELED');
    expect(canceled.json().disposition.affectedTasks).toBe(2);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: openOne.id } })).milestoneId).toBeNull();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done.id } })).milestoneId).toBe(source.id);

    const reactivated = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/activate`,
      payload: { version: canceled.json().milestone.version }
    });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().status).toBe('ACTIVE');
    expect(reactivated.json().canceledAt).toBeNull();

    for (const task of [openOne, openTwo]) {
      const assigned = await injectAs(fixture, 'member', {
        method: 'PATCH',
        url: `/tasks/${task.key}`,
        payload: { milestoneId: source.id }
      });
      expect(assigned.statusCode).toBe(200);
    }

    const moved = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/complete`,
      payload: {
        version: reactivated.json().version,
        unfinishedTaskPolicy: 'MOVE',
        targetMilestoneId: target.id
      }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().disposition).toEqual({ policy: 'MOVE', affectedTasks: 2, targetMilestoneId: target.id });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: openOne.id } })).milestoneId).toBe(target.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: done.id } })).milestoneId).toBe(source.id);

    const archived = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/archive`,
      payload: { version: moved.json().milestone.version }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toBeString();

    const archivedOnly = await injectAs(fixture, 'member', {
      method: 'GET',
      url: '/milestones?includeArchived=true&archivedOnly=true&limit=200'
    });
    expect(archivedOnly.statusCode).toBe(200);
    expect(archivedOnly.json().total).toBe(1);
    expect(ids(archivedOnly.json().items)).toEqual([source.id]);

    const keptTaskUpdate = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${done.key}`,
      payload: { title: 'Done task edited after archive' }
    });
    expect(keptTaskUpdate.statusCode).toBe(200);
    const archivedProgressEvent = await prisma.syncEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        entityType: 'milestone',
        entityId: source.id,
        operation: 'progress_updated'
      },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect((archivedProgressEvent.payload as { after?: unknown }).after).toBeUndefined();
    expect(((archivedProgressEvent.payload as { before?: { archivedAt?: string | null } }).before?.archivedAt)).toBeString();

    const readOnly = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/milestones/${source.id}`,
      payload: { version: archived.json().version, name: 'Should not change' }
    });
    expect(readOnly.statusCode).toBe(409);

    const restored = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${source.id}/restore`,
      payload: { version: archived.json().version }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe('COMPLETED');
    expect(restored.json().archivedAt).toBeNull();

    const newTask = await createTask(fixture, fixture.projects.primary.id, 'New work', 'TODO', 1, null);
    const terminalAssignment = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${newTask.key}`,
      payload: { milestoneId: source.id }
    });
    expect(terminalAssignment.statusCode).toBe(400);

    const activeArchive = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${target.id}/archive`,
      payload: { version: target.version }
    });
    expect(activeArchive.statusCode).toBe(409);
  });

  test('enforces planning permission precedence and owner eligibility', async () => {
    const fixture = await createFixture();
    const expected: Array<[Persona, number]> = [
      ['owner', 201],
      ['admin', 201],
      ['lead', 201],
      ['member', 201],
      ['agentGranted', 201],
      ['viewer', 403],
      ['guest', 403],
      ['agentDenied', 403],
      ['outsider', 404]
    ];

    for (const [persona, statusCode] of expected) {
      const response = await injectAs(fixture, persona, {
        method: 'POST',
        url: '/milestones',
        payload: {
          projectId: fixture.projects.primary.id,
          name: `Permission ${persona}`,
          kind: 'OTHER'
        }
      });
      expect(response.statusCode).toBe(statusCode);
    }

    const ordinaryNoTeam = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/milestones',
      payload: { projectId: fixture.projects.noTeam.id, name: 'No team denied', kind: 'OTHER' }
    });
    expect(ordinaryNoTeam.statusCode).toBe(403);
    const leadNoTeam = await injectAs(fixture, 'lead', {
      method: 'POST',
      url: '/milestones',
      payload: { projectId: fixture.projects.noTeam.id, name: 'No team lead', kind: 'OTHER' }
    });
    expect(leadNoTeam.statusCode).toBe(201);

    const candidates = await injectAs(fixture, 'member', {
      method: 'GET',
      url: `/milestones/owner-candidates?projectId=${fixture.projects.primary.id}&limit=200`
    });
    expect(candidates.statusCode).toBe(200);
    const candidateIds = ids(candidates.json().items);
    for (const persona of ['owner', 'admin', 'lead', 'member', 'viewer', 'guest', 'agentGranted', 'agentDenied'] as Persona[]) {
      expect(candidateIds).toContain(fixture.users[persona].id);
    }
    expect(candidateIds).not.toContain(fixture.users.outsider.id);
    expect(candidates.json().total).toBe(candidateIds.length);

    const invalidOwner = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/milestones',
      payload: {
        projectId: fixture.projects.primary.id,
        name: 'Invalid owner',
        kind: 'FEATURE',
        ownerId: fixture.users.outsider.id
      }
    });
    expect(invalidOwner.statusCode).toBe(400);

    const viewerOwner = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/milestones',
      payload: {
        projectId: fixture.projects.primary.id,
        name: 'Viewer can own',
        kind: 'FEATURE',
        ownerId: fixture.users.viewer.id
      }
    });
    expect(viewerOwner.statusCode).toBe(201);
  });

  test('keeps task and milestone scope valid across assignment and project moves', async () => {
    const fixture = await createFixture();
    const primary = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Primary scope',
      kind: 'FEATURE'
    });
    const secondary = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.secondary.id,
      name: 'Secondary scope',
      kind: 'FEATURE'
    });

    const created = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/tasks',
      payload: {
        projectId: fixture.projects.primary.id,
        milestoneId: primary.id,
        title: 'Scoped task'
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().milestoneId).toBe(primary.id);

    const crossProject = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${created.json().key}`,
      payload: { milestoneId: secondary.id }
    });
    expect(crossProject.statusCode).toBe(400);

    const cleared = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${created.json().key}`,
      payload: { projectId: fixture.projects.secondary.id }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().project.id).toBe(fixture.projects.secondary.id);
    expect(cleared.json().milestoneId).toBeNull();
    expect(cleared.json().milestone).toBeNull();

    const clearEvent = await prisma.syncEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, entityType: 'task', entityId: created.json().id, operation: 'updated' },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect((clearEvent.payload as { changedFields?: string[] }).changedFields).toContain('milestoneId');

    const atomicMove = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${cleared.json().key}`,
      payload: { projectId: fixture.projects.primary.id, milestoneId: primary.id }
    });
    expect(atomicMove.statusCode).toBe(200);
    expect(atomicMove.json().project.id).toBe(fixture.projects.primary.id);
    expect(atomicMove.json().milestoneId).toBe(primary.id);

    const other = await createForeignMilestone();
    const crossWorkspace = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${atomicMove.json().key}`,
      payload: { milestoneId: other.milestoneId }
    });
    expect(crossWorkspace.statusCode).toBe(400);

    const completed = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${primary.id}/complete`,
      payload: { version: primary.version, unfinishedTaskPolicy: 'KEEP' }
    });
    expect(completed.statusCode).toBe(200);
    const existingLink = await injectAs(fixture, 'member', { method: 'GET', url: `/tasks/${atomicMove.json().key}` });
    expect(existingLink.statusCode).toBe(200);
    expect(existingLink.json().milestone.status).toBe('COMPLETED');

    const unassigned = await createTask(fixture, fixture.projects.primary.id, 'Unassigned', 'TODO', 1, null);
    const terminalTarget = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${unassigned.key}`,
      payload: { milestoneId: primary.id }
    });
    expect(terminalTarget.statusCode).toBe(400);

    const filtered = await injectAs(fixture, 'member', { method: 'GET', url: `/tasks?milestoneId=${primary.id}` });
    expect(filtered.statusCode).toBe(200);
    expect(ids(filtered.json().items)).toContain(created.json().id);
  });

  test('reorders by intuitive predecessor/successor semantics and rebalances each version once', async () => {
    const fixture = await createFixture();
    const first = await createMilestone(fixture, 'member', { projectId: fixture.projects.primary.id, name: 'First', kind: 'PHASE' });
    const second = await createMilestone(fixture, 'member', { projectId: fixture.projects.primary.id, name: 'Second', kind: 'PHASE' });
    const third = await createMilestone(fixture, 'member', { projectId: fixture.projects.primary.id, name: 'Third', kind: 'PHASE' });

    const between = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${third.id}/reorder`,
      payload: { version: third.version, beforeId: first.id, afterId: second.id }
    });
    expect(between.statusCode).toBe(200);
    expect(between.json().position).toBeGreaterThan(first.position);
    expect(between.json().position).toBeLessThan(second.position);
    expect(between.json().version).toBe(third.version + 1);

    const stale = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${third.id}/reorder`,
      payload: { version: third.version, beforeId: second.id }
    });
    expect(stale.statusCode).toBe(409);

    await prisma.milestone.update({ where: { id: first.id }, data: { position: 1024 } });
    await prisma.milestone.update({ where: { id: second.id }, data: { position: 1025 } });
    await prisma.milestone.update({ where: { id: third.id }, data: { position: 3072 } });
    const targetBefore = await prisma.milestone.findUniqueOrThrow({ where: { id: third.id } });
    const rebalanced = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${third.id}/reorder`,
      payload: { version: targetBefore.version, beforeId: first.id, afterId: second.id }
    });
    expect(rebalanced.statusCode).toBe(200);
    expect(rebalanced.json().version).toBe(targetBefore.version + 1);

    const ordered = await prisma.milestone.findMany({
      where: { id: { in: [first.id, second.id, third.id] } },
      orderBy: { position: 'asc' },
      select: { id: true, position: true }
    });
    expect(ordered.map((row) => row.id)).toEqual([first.id, third.id, second.id]);
    expect(ordered.map((row) => row.position)).toEqual([1024, 2048, 3072]);
  });

  test('allocates stable unique positions for concurrent milestone creation', async () => {
    const fixture = await createFixture();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => injectAs(fixture, 'member', {
        method: 'POST',
        url: '/milestones',
        payload: {
          projectId: fixture.projects.primary.id,
          name: `Concurrent milestone ${index + 1}`,
          kind: 'FEATURE'
        }
      }))
    );
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);

    const rows = await prisma.milestone.findMany({
      where: { projectId: fixture.projects.primary.id },
      orderBy: { position: 'asc' },
      select: { position: true }
    });
    expect(rows.map((row) => row.position)).toEqual(
      Array.from({ length: 8 }, (_, index) => (index + 1) * 1024)
    );
  });

  test('does not append a stale milestone summary after a concurrent task progress event', async () => {
    const fixture = await createFixture();
    const milestone = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Concurrent summary',
      kind: 'FEATURE'
    });
    const task = await createTask(
      fixture,
      fixture.projects.primary.id,
      'Concurrent progress task',
      'TODO',
      1,
      milestone.id
    );

    let releaseTaskTransaction = () => {};
    const taskTransactionRelease = new Promise<void>((resolve) => {
      releaseTaskTransaction = resolve;
    });
    let taskCursorReserved = () => {};
    const taskCursorReservation = new Promise<void>((resolve) => {
      taskCursorReserved = resolve;
    });

    const taskMutation = prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: task.id },
        data: { status: 'DONE', completedAt: new Date(), version: { increment: 1 } }
      });
      await appendSyncEvent(tx, {
        workspaceId: fixture.workspace.id,
        entityType: 'task',
        entityId: task.id,
        operation: 'updated',
        actorId: fixture.users.member.id,
        payload: { changedFields: ['status', 'completedAt'] }
      });
      taskCursorReserved();
      await taskTransactionRelease;
      await appendMilestoneProgressSyncEvents(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.users.member.id,
        milestoneIds: [milestone.id]
      });
    }, { timeout: 15_000 });

    await taskCursorReservation;
    const milestoneMutation = injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/milestones/${milestone.id}`,
      payload: { version: milestone.version, name: 'Concurrent summary edited' }
    });

    try {
      await waitForWorkspaceSyncLockWait();
    } finally {
      releaseTaskTransaction();
    }

    const [, updated] = await Promise.all([taskMutation, milestoneMutation]);
    expect(updated.statusCode).toBe(200);

    const milestoneEvents = await prisma.syncEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entityType: 'milestone',
        entityId: milestone.id,
        operation: { in: ['progress_updated', 'updated'] }
      },
      orderBy: { workspaceSeq: 'asc' }
    });
    const progressEvent = milestoneEvents.find((event) => event.operation === 'progress_updated');
    const updateEvent = milestoneEvents.find((event) => event.operation === 'updated');
    expect(progressEvent).toBeDefined();
    expect(updateEvent).toBeDefined();
    expect(progressEvent!.workspaceSeq < updateEvent!.workspaceSeq).toBe(true);
    expect((progressEvent!.payload as { after: { progress: { completedTasks: number } } }).after.progress.completedTasks).toBe(1);
    expect((updateEvent!.payload as { after: { progress: { completedTasks: number } } }).after.progress.completedTasks).toBe(1);
  }, 20_000);

  test('serializes concurrent task assignment with completion disposition', async () => {
    const fixture = await createFixture();
    const milestone = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Assignment barrier',
      kind: 'FEATURE'
    });

    let releaseProject = () => {};
    const projectRelease = new Promise<void>((resolve) => {
      releaseProject = resolve;
    });
    let projectLocked = () => {};
    const projectLock = new Promise<void>((resolve) => {
      projectLocked = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Project"
        WHERE "id" = ${fixture.projects.primary.id}::uuid
        FOR UPDATE
      `;
      projectLocked();
      await projectRelease;
    }, { timeout: 15_000 });
    await projectLock;

    // Creation locks the open milestone before it reaches the deliberately
    // blocked project sequence reservation. Completion must then wait and
    // apply UNASSIGN to the newly committed task instead of snapshotting an
    // empty scope and letting a late assignment resurrect it.
    const createRequest = injectAs(fixture, 'member', {
      method: 'POST',
      url: '/tasks',
      payload: {
        projectId: fixture.projects.primary.id,
        milestoneId: milestone.id,
        title: 'Arrives during completion'
      }
    });
    await waitForDatabaseLockWait();
    const completionRequest = injectAs(fixture, 'member', {
      method: 'POST',
      url: `/milestones/${milestone.id}/complete`,
      payload: { version: milestone.version, unfinishedTaskPolicy: 'UNASSIGN' }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      releaseProject();
    }

    const [created, completed] = await Promise.all([createRequest, completionRequest]);
    await blocker;
    expect(created.statusCode).toBe(201);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().disposition).toEqual({
      policy: 'UNASSIGN',
      affectedTasks: 1,
      targetMilestoneId: null
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: created.json().id } })).milestoneId).toBeNull();
  }, 20_000);

  test('clears ownership transactionally on membership removal and does not leak restricted sync state', async () => {
    const fixture = await createFixture();
    const milestone = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Owned milestone',
      kind: 'FEATURE',
      ownerId: fixture.users.member.id
    });
    const progressTask = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/tasks',
      payload: {
        projectId: fixture.projects.primary.id,
        milestoneId: milestone.id,
        title: 'Progress task',
        weight: 2
      }
    });
    expect(progressTask.statusCode).toBe(201);

    const progressEvent = await prisma.syncEvent.findFirst({
      where: { workspaceId: fixture.workspace.id, entityType: 'milestone', entityId: milestone.id, operation: 'progress_updated' },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect(progressEvent).not.toBeNull();
    expect(((progressEvent!.payload as { after: { progress: { eligibleTasks: number } } }).after.progress.eligibleTasks)).toBe(1);

    const outsiderBootstrap = await injectAs(fixture, 'outsider', { method: 'GET', url: '/sync/bootstrap' });
    expect(outsiderBootstrap.statusCode).toBe(200);
    expect(ids(outsiderBootstrap.json().milestones)).not.toContain(milestone.id);
    const memberBootstrap = await injectAs(fixture, 'member', { method: 'GET', url: '/sync/bootstrap' });
    expect(memberBootstrap.statusCode).toBe(200);
    expect(ids(memberBootstrap.json().milestones)).toContain(milestone.id);

    const removed = await injectAs(fixture, 'owner', {
      method: 'DELETE',
      url: `/users/${fixture.users.member.id}/membership`
    });
    expect(removed.statusCode).toBe(204);

    const updated = await prisma.milestone.findUniqueOrThrow({ where: { id: milestone.id } });
    expect(updated.ownerId).toBeNull();
    expect(updated.version).toBe(milestone.version + 1);
    const ownerEvent = await prisma.syncEvent.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, entityType: 'milestone', entityId: milestone.id, operation: 'updated' },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect((ownerEvent.payload as { reason?: string }).reason).toBe('workspace_membership_removed');
    expect(((ownerEvent.payload as { after: { ownerId?: string | null } }).after.ownerId)).toBeNull();
    const audit = await prisma.activityLog.findFirst({
      where: { workspaceId: fixture.workspace.id, entityType: 'milestone', entityId: milestone.id, action: 'owner_cleared' }
    });
    expect(audit).not.toBeNull();

    const removedActor = await injectAs(fixture, 'member', { method: 'GET', url: `/milestones/${milestone.id}` });
    expect(removedActor.statusCode).toBe(403);
  });

  test('acknowledges a multi-event lifecycle mutation exactly once and deduplicates retries', async () => {
    const fixture = await createFixture();
    const milestone = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Sync completion',
      kind: 'PHASE'
    });
    const task = await createTask(fixture, fixture.projects.primary.id, 'Open sync task', 'TODO', 1, milestone.id);
    const mutationId = crypto.randomUUID();
    const payload = {
      clientId: `test-${crypto.randomUUID()}`,
      mutations: [{
        mutationId,
        name: 'milestone.complete',
        args: {
          id: milestone.id,
          completion: { version: milestone.version, unfinishedTaskPolicy: 'UNASSIGN' }
        }
      }]
    };

    const applied = await injectAs(fixture, 'member', { method: 'POST', url: '/sync/push', payload });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().results[0].status).toBe('applied');
    expect(applied.json().results[0].entity.milestone.status).toBe('COMPLETED');
    expect(applied.json().results[0].entity.disposition.affectedTasks).toBe(1);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).milestoneId).toBeNull();

    const mutationEvents = await prisma.syncEvent.findMany({ where: { workspaceId: fixture.workspace.id, mutationId } });
    expect(mutationEvents).toHaveLength(1);
    expect(mutationEvents[0].entityType).toBe('milestone');
    const ack = await prisma.clientMutation.findUniqueOrThrow({
      where: {
        workspaceId_clientId_mutationId: {
          workspaceId: fixture.workspace.id,
          clientId: payload.clientId,
          mutationId
        }
      }
    });
    expect(ack.resultWorkspaceSeq).toBe(mutationEvents[0].workspaceSeq);

    const duplicate = await injectAs(fixture, 'member', { method: 'POST', url: '/sync/push', payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().results[0].status).toBe('duplicate');
    expect(await prisma.syncEvent.count({ where: { workspaceId: fixture.workspace.id, mutationId } })).toBe(1);
  });

  test('replays an offline milestone create before a queued task assignment using the client UUID', async () => {
    const fixture = await createFixture();
    const task = await createTask(
      fixture,
      fixture.projects.primary.id,
      'Queued assignment',
      'TODO',
      1,
      null
    );
    const milestoneId = crypto.randomUUID();
    const createMutationId = crypto.randomUUID();
    const assignmentMutationId = crypto.randomUUID();
    const payload = {
      clientId: `offline-${crypto.randomUUID()}`,
      mutations: [
        {
          mutationId: createMutationId,
          name: 'milestone.create',
          args: {
            id: milestoneId,
            projectId: fixture.projects.primary.id,
            name: 'Offline-created feature',
            kind: 'FEATURE',
            status: 'PLANNED'
          }
        },
        {
          mutationId: assignmentMutationId,
          name: 'task.update',
          args: {
            idOrKey: task.key,
            patch: { milestoneId }
          }
        }
      ]
    };

    const applied = await injectAs(fixture, 'member', { method: 'POST', url: '/sync/push', payload });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().results.map((result: { status: string }) => result.status)).toEqual(['applied', 'applied']);
    expect(applied.json().results[0].entity.id).toBe(milestoneId);
    expect(applied.json().results[1].entity.milestoneId).toBe(milestoneId);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).milestoneId).toBe(milestoneId);
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } })).name).toBe('Offline-created feature');

    const duplicate = await injectAs(fixture, 'member', { method: 'POST', url: '/sync/push', payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().results.map((result: { status: string }) => result.status)).toEqual(['duplicate', 'duplicate']);
    expect(await prisma.syncEvent.count({
      where: { workspaceId: fixture.workspace.id, mutationId: { in: [createMutationId, assignmentMutationId] } }
    })).toBe(2);
  });

  test('refreshes progress for review decisions and preserves open milestone scope when splitting backlog work', async () => {
    const fixture = await createFixture();
    const reviewMilestone = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Review flow',
      kind: 'FEATURE'
    });
    const reviewTask = await createTask(
      fixture,
      fixture.projects.primary.id,
      'Review me',
      'TODO',
      2,
      reviewMilestone.id
    );

    const requested = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/tasks/${reviewTask.key}/reviews`,
      payload: { reviewerId: fixture.users.viewer.id }
    });
    expect(requested.statusCode).toBe(201);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: reviewTask.id } })).status).toBe('IN_REVIEW');

    const approved = await injectAs(fixture, 'viewer', {
      method: 'POST',
      url: `/reviews/${requested.json().id}/approve`,
      payload: {}
    });
    expect(approved.statusCode).toBe(200);
    const reviewDetail = await injectAs(fixture, 'member', {
      method: 'GET',
      url: `/milestones/${reviewMilestone.id}`
    });
    expect(reviewDetail.json().progress.completedTasks).toBe(1);
    expect(reviewDetail.json().progress.percentage).toBe(100);
    const reviewProgressEvent = await prisma.syncEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        entityType: 'milestone',
        entityId: reviewMilestone.id,
        operation: 'progress_updated'
      },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect(((reviewProgressEvent.payload as { after: { progress: { percentage: number } } }).after.progress.percentage)).toBe(100);

    const splitMilestone = await createMilestone(fixture, 'member', {
      projectId: fixture.projects.primary.id,
      name: 'Split flow',
      kind: 'PHASE'
    });
    const backlog = await createTask(
      fixture,
      fixture.projects.primary.id,
      'Oversized backlog item',
      'BACKLOG',
      3,
      splitMilestone.id
    );
    const split = await injectAs(fixture, 'member', {
      method: 'POST',
      url: `/triage/tasks/${backlog.key}/split`,
      payload: {
        items: [{ title: 'Slice one' }, { title: 'Slice two' }],
        reason: 'Independent outcomes'
      }
    });
    expect(split.statusCode).toBe(200);
    expect(split.json().task.status).toBe('CANCELED');
    expect(split.json().items).toHaveLength(2);
    expect(split.json().items.every((task: { milestoneId?: string | null }) => task.milestoneId === splitMilestone.id)).toBe(true);

    const splitDetail = await injectAs(fixture, 'member', {
      method: 'GET',
      url: `/milestones/${splitMilestone.id}`
    });
    expect(splitDetail.json().progress).toMatchObject({
      totalTasks: 3,
      eligibleTasks: 2,
      canceledTasks: 1,
      percentage: 0
    });
  });
});

type Persona = 'owner' | 'admin' | 'lead' | 'member' | 'viewer' | 'guest' | 'agentGranted' | 'agentDenied' | 'outsider';

interface Fixture {
  workspace: { id: string; slug: string };
  users: Record<Persona, { id: string; email: string; name: string }>;
  teams: { primary: { id: string } };
  projects: {
    primary: { id: string };
    secondary: { id: string };
    noTeam: { id: string };
  };
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Milestones ${suffix}`,
      slug: `milestones-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const users = {} as Fixture['users'];
  for (const persona of ['owner', 'admin', 'lead', 'member', 'viewer', 'guest', 'agentGranted', 'agentDenied', 'outsider'] as Persona[]) {
    const user = await prisma.user.create({
      data: { email: `${persona}-${suffix}@milestones.test`.toLowerCase(), name: persona },
      select: { id: true, email: true, name: true }
    });
    users[persona] = user;
    cleanupUserIds.push(user.id);
  }

  const roles: Record<Persona, WorkspaceRole> = {
    owner: 'OWNER',
    admin: 'ADMIN',
    lead: 'MEMBER',
    member: 'MEMBER',
    viewer: 'MEMBER',
    guest: 'GUEST',
    agentGranted: 'AGENT',
    agentDenied: 'AGENT',
    outsider: 'MEMBER'
  };
  await prisma.workspaceMember.createMany({
    data: (Object.keys(users) as Persona[]).map((persona) => ({
      workspaceId: workspace.id,
      userId: users[persona].id,
      role: roles[persona]
    }))
  });

  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Primary team', slug: uniqueSlug('primary') },
    select: { id: true }
  });
  await prisma.teamMember.createMany({
    data: [
      { teamId: team.id, userId: users.member.id, role: 'MEMBER' },
      { teamId: team.id, userId: users.viewer.id, role: 'MEMBER' },
      { teamId: team.id, userId: users.guest.id, role: 'GUEST' },
      { teamId: team.id, userId: users.agentDenied.id, role: 'AGENT' }
    ]
  });

  const primary = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: team.id,
      leadId: users.lead.id,
      name: 'Primary',
      keyPrefix: uniquePrefix('PRI')
    },
    select: { id: true }
  });
  const secondary = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: team.id,
      name: 'Secondary',
      keyPrefix: uniquePrefix('SEC')
    },
    select: { id: true }
  });
  const noTeam = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      leadId: users.lead.id,
      name: 'No team',
      keyPrefix: uniquePrefix('NTP')
    },
    select: { id: true }
  });
  await prisma.projectMember.createMany({
    data: [
      { projectId: primary.id, userId: users.viewer.id, role: 'VIEWER' },
      { projectId: primary.id, userId: users.agentGranted.id, role: 'MEMBER' }
    ]
  });

  return {
    workspace,
    users,
    teams: { primary: team },
    projects: { primary, secondary, noTeam }
  };
}

async function injectAs(fixture: Fixture, persona: Persona, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      'x-workspace-slug': fixture.workspace.slug,
      'x-user-email': fixture.users[persona].email,
      ...(options.headers || {})
    }
  });
}

async function createMilestone(
  fixture: Fixture,
  persona: Persona,
  input: Record<string, unknown>
) {
  const response = await injectAs(fixture, persona, { method: 'POST', url: '/milestones', payload: input });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function createTask(
  fixture: Fixture,
  projectId: string,
  title: string,
  status: 'BACKLOG' | 'TODO' | 'BLOCKED' | 'DONE' | 'CANCELED',
  weight: number,
  milestoneId: string | null,
  dueAt?: Date
) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { keyPrefix: true } });
  const aggregate = await prisma.task.aggregate({ where: { projectId }, _max: { sequence: true } });
  const sequence = (aggregate._max.sequence ?? 0) + 1;
  return prisma.task.create({
    data: {
      workspaceId: fixture.workspace.id,
      projectId,
      milestoneId,
      sequence,
      key: `${project.keyPrefix}-${sequence}`,
      title,
      status,
      weight,
      dueAt,
      completedAt: status === 'DONE' ? new Date() : null
    },
    select: { id: true, key: true }
  });
}

async function createForeignMilestone() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `Foreign ${suffix}`, slug: `foreign-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60) },
    select: { id: true }
  });
  cleanupWorkspaceIds.push(workspace.id);
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Foreign', keyPrefix: uniquePrefix('FOR') },
    select: { id: true }
  });
  const milestone = await prisma.milestone.create({
    data: { workspaceId: workspace.id, projectId: project.id, name: 'Foreign', kind: 'FEATURE' },
    select: { id: true }
  });
  return { milestoneId: milestone.id };
}

function dateOnly(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function ids(items: Array<{ id?: string }>): string[] {
  return items.map((item) => item.id).filter((id): id is string => Boolean(id));
}

function uniquePrefix(base: string): string {
  return `${base}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
}

function uniqueSlug(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 9)}`;
}

async function waitForDatabaseLockWait(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a concurrent database lock');
}

const waitForWorkspaceSyncLockWait = waitForDatabaseLockWait;
