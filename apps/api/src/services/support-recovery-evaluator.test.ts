import { afterEach, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import {
  SUPPORT_RECOVERY_JOB_KEY,
  evaluateSupportRecoveryWorkspace,
  runSupportJobLease,
  runSupportRecoveryWorkerTick,
  startSupportRecoveryWorker,
  supportAttentionCaseWhere,
  supportAttentionReasonsByCaseIds,
  supportRecoveryBucketKey,
  synchronizeSupportRecoveryAttention
} from './support-recovery-evaluator';
import {
  applySupportSlaCaseEvent,
  clockFromRow,
  parseSupportSlaPolicy,
  startSupportSlaClock
} from './support-sla';

const cleanupWorkspaceIds: string[] = [];

afterEach(async () => {
  while (cleanupWorkspaceIds.length) {
    const workspaceId = cleanupWorkspaceIds.pop();
    if (!workspaceId) continue;
    await prisma.supportCaseSlaClock.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }
});

describe('Support retryable job leases', () => {
  test('one worker owns a bucket, failure backs off, and a later retry completes exactly once', async () => {
    const fixture = await createSupportFixture();
    const firstAt = new Date('2026-08-23T12:00:00.000Z');
    let runs = 0;
    const input = {
      workspaceId: fixture.workspace.id,
      jobKey: 'test_support_retry',
      bucketKey: '2026-08-23T12:00Z',
      workerId: 'worker-a',
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error('temporary evaluator failure');
        return { cases: 1 };
      }
    };

    const failed = await runSupportJobLease(input, { now: firstAt, baseRetryMilliseconds: 30_000 });
    expect(failed.claimed).toBe(true);
    expect(failed.lease.status).toBe('RETRY_PENDING');
    expect(failed.lease.attemptCount).toBe(1);

    const tooSoon = await runSupportJobLease(input, { now: new Date(firstAt.getTime() + 29_000), baseRetryMilliseconds: 30_000 });
    expect(tooSoon.claimed).toBe(false);
    expect(runs).toBe(1);

    const retried = await runSupportJobLease(input, { now: new Date(firstAt.getTime() + 30_000), baseRetryMilliseconds: 30_000 });
    expect(retried.claimed).toBe(true);
    expect(retried.lease.status).toBe('COMPLETED');
    expect(retried.lease.attemptCount).toBe(2);
    expect(runs).toBe(2);

    const duplicate = await runSupportJobLease(input, { now: new Date(firstAt.getTime() + 60_000) });
    expect(duplicate.claimed).toBe(false);
    expect(runs).toBe(2);
  });

  test('an expired worker cannot overwrite the newer lease owner result', async () => {
    const fixture = await createSupportFixture();
    const firstAt = new Date('2026-08-23T12:00:00.000Z');
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const common = {
      workspaceId: fixture.workspace.id,
      jobKey: 'test_support_fencing',
      bucketKey: '2026-08-23T12:00Z'
    };

    const stalePromise = runSupportJobLease({
      ...common,
      workerId: 'worker-a',
      run: async () => {
        markFirstStarted?.();
        await firstReleased;
        return 'stale';
      }
    }, { now: firstAt, leaseMilliseconds: 1_000 });
    await firstStarted;

    const currentAt = new Date(firstAt.getTime() + 1_001);
    const current = await runSupportJobLease({
      ...common,
      workerId: 'worker-b',
      run: async () => 'current'
    }, { now: currentAt, leaseMilliseconds: 1_000 });
    releaseFirst?.();
    const stale = await stalePromise;

    expect(current.result).toBe('current');
    expect(stale.result).toBeUndefined();
    expect(stale.leaseLost).toBe(true);
    expect(stale.lease.completedAt?.toISOString()).toBe(currentAt.toISOString());
    expect(stale.lease.attemptCount).toBe(2);
  });

  test('a crashed final attempt becomes a dead letter after its lease expires', async () => {
    const fixture = await createSupportFixture();
    const now = new Date('2026-08-23T12:00:00.000Z');
    await prisma.supportJobLease.create({ data: {
      workspaceId: fixture.workspace.id,
      jobKey: 'test_support_final_crash',
      bucketKey: '2026-08-23T11:45Z',
      status: 'RUNNING',
      attemptCount: 1,
      nextAttemptAt: new Date('2026-08-23T11:45:00.000Z'),
      leaseOwner: 'dead-worker',
      leaseExpiresAt: new Date('2026-08-23T11:59:59.000Z')
    } });
    let ran = false;
    const result = await runSupportJobLease({
      workspaceId: fixture.workspace.id,
      jobKey: 'test_support_final_crash',
      bucketKey: '2026-08-23T11:45Z',
      workerId: 'replacement',
      run: async () => { ran = true; }
    }, { now, maxAttempts: 1 });
    expect(result.claimed).toBe(false);
    expect(result.lease.status).toBe('DEAD_LETTER');
    expect(result.lease.lastErrorCode).toBe('SUPPORT_JOB_LEASE_EXPIRED');
    expect(ran).toBe(false);
  });
});

describe('Support recovery worker', () => {
  test('uses stable five-minute UTC bucket identities', () => {
    expect(supportRecoveryBucketKey(new Date('2026-08-23T12:04:59.999Z')))
      .toBe('2026-08-23T12:00:00.000Z');
    expect(supportRecoveryBucketKey(new Date('2026-08-23T15:34:59.999+03:30')))
      .toBe('2026-08-23T12:00:00.000Z');
    expect(supportRecoveryBucketKey(new Date('2026-08-23T12:05:00.000Z')))
      .toBe('2026-08-23T12:05:00.000Z');
  });

  test('paginates Support workspaces and executes a current bucket only once', async () => {
    const fixture = await createSupportFixture();
    const now = new Date('2026-08-23T12:04:59.000Z');
    const bucketKey = supportRecoveryBucketKey(now);

    const first = await runSupportRecoveryWorkerTick({
      owner: 'support-recovery-current-a',
      now,
      workspaceBatchSize: 1
    });
    await runSupportRecoveryWorkerTick({
      owner: 'support-recovery-current-b',
      now,
      workspaceBatchSize: 1
    });

    const lease = await prisma.supportJobLease.findUniqueOrThrow({
      where: {
        jobKey_workspaceId_bucketKey: {
          jobKey: SUPPORT_RECOVERY_JOB_KEY,
          workspaceId: fixture.workspace.id,
          bucketKey
        }
      }
    });
    expect(first.workspaces).toBeGreaterThanOrEqual(1);
    expect(lease.status).toBe('COMPLETED');
    expect(lease.attemptCount).toBe(1);
  });

  test('retries a due failed bucket in addition to the current bucket', async () => {
    const fixture = await createSupportFixture();
    const now = new Date('2026-08-23T12:04:00.000Z');
    const failedBucketKey = '2026-08-23T11:55:00.000Z';
    await prisma.supportJobLease.create({ data: {
      workspaceId: fixture.workspace.id,
      jobKey: SUPPORT_RECOVERY_JOB_KEY,
      bucketKey: failedBucketKey,
      status: 'RETRY_PENDING',
      attemptCount: 1,
      nextAttemptAt: new Date('2000-01-01T00:00:00.000Z'),
      lastErrorCode: 'TRANSIENT_TEST_FAILURE',
      lastErrorMessage: 'Retry me'
    } });

    await runSupportRecoveryWorkerTick({
      owner: 'support-recovery-retry',
      now,
      retryBatchSize: 1_000
    });

    const retried = await prisma.supportJobLease.findUniqueOrThrow({
      where: {
        jobKey_workspaceId_bucketKey: {
          jobKey: SUPPORT_RECOVERY_JOB_KEY,
          workspaceId: fixture.workspace.id,
          bucketKey: failedBucketKey
        }
      }
    });
    expect(retried.status).toBe('COMPLETED');
    expect(retried.attemptCount).toBe(2);
  });

  test('never schedules recovery buckets for Team workspaces', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = await prisma.workspace.create({
      data: {
        name: `Team recovery ${suffix}`,
        slug: `team-recovery-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60),
        mode: 'TEAM'
      }
    });
    cleanupWorkspaceIds.push(workspace.id);
    await runSupportRecoveryWorkerTick({
      owner: 'support-recovery-team-skip',
      now: new Date('2026-08-23T12:04:00.000Z')
    });
    expect(await prisma.supportJobLease.count({
      where: { workspaceId: workspace.id, jobKey: SUPPORT_RECOVERY_JOB_KEY }
    })).toBe(0);
  });

  test('graceful stop releases this worker\'s unfinished leases for immediate retry', async () => {
    const fixture = await createSupportFixture();
    const owner = `support-recovery-stopping-${Date.now()}`;
    const lease = await prisma.supportJobLease.create({ data: {
      workspaceId: fixture.workspace.id,
      jobKey: SUPPORT_RECOVERY_JOB_KEY,
      bucketKey: 'owned-before-graceful-stop',
      status: 'RUNNING',
      attemptCount: 1,
      nextAttemptAt: new Date('2026-08-23T12:00:00.000Z'),
      leaseOwner: owner,
      leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000)
    } });
    const worker = startSupportRecoveryWorker({
      owner,
      enabled: true,
      intervalMilliseconds: 60 * 60 * 1000
    });
    await worker.stop();

    const released = await prisma.supportJobLease.findUniqueOrThrow({ where: { id: lease.id } });
    expect(released.status).toBe('RETRY_PENDING');
    expect(released.leaseOwner).toBeNull();
    expect(released.leaseExpiresAt).toBeNull();
    expect(released.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('Support SLA persistence and recovery evaluation', () => {
  test('freezes a referenced policy version and idempotently returns the same clock cycle', async () => {
    const fixture = await createSupportFixture();
    const policy = parseSupportSlaPolicy(fixture.policy);
    const calendar = {
      timezone: fixture.calendar.timezone,
      periods: fixture.periods,
      holidays: []
    };
    const input = {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      policy,
      calendar,
      metric: 'FIRST_RESPONSE' as const,
      cycle: 1,
      startedAt: new Date('2026-08-24T09:00:00.000Z')
    };
    const first = await startSupportSlaClock(input);
    const retry = await startSupportSlaClock(input);
    expect(retry.id).toBe(first.id);
    expect(retry.policyVersion).toBe(1);

    const concurrentInput = { ...input, cycle: 2 };
    const concurrent = await Promise.all([
      startSupportSlaClock(concurrentInput),
      startSupportSlaClock(concurrentInput)
    ]);
    expect(concurrent[0].id).toBe(concurrent[1].id);

    const error = await captureError(prisma.supportSlaPolicy.update({
      where: { id: fixture.policy.id },
      data: { targets: { FIRST_RESPONSE: { businessSeconds: 60 } } }
    }));
    expect(String(error)).toContain('A referenced Support SLA policy version is immutable');

    const retired = await prisma.supportSlaPolicy.update({
      where: { id: fixture.policy.id },
      data: { active: false, effectiveUntil: new Date('2026-08-25T00:00:00.000Z') }
    });
    expect(retired).toMatchObject({ active: false });

    const frozen = await prisma.supportCaseSlaClock.findUniqueOrThrow({ where: { id: first.id } });
    expect(frozen.targetBusinessSeconds).toBe(4 * 60 * 60);
    expect(frozen.pauseRulesSnapshot).toEqual({
      snapshotVersion: 1,
      pauseRules: {
        waitingOnCustomer: ['RESOLUTION'],
        waitingOnInternal: [],
        snoozed: [],
        automatedPublicResponseMeets: []
      },
      calendar: {
        timezone: 'UTC',
        periods: fixture.periods,
        holidays: []
      },
      atRiskSeconds: null
    });
  });

  test('applies aggregate events atomically across frozen clock cycles', async () => {
    const fixture = await createSupportFixture();
    const createdAt = new Date('2026-08-24T09:00:00.000Z');
    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'CASE_CREATED',
      at: createdAt
    }));

    const initial = await prisma.supportCaseSlaClock.findMany({
      where: { caseId: fixture.supportCase.id },
      orderBy: { metric: 'asc' }
    });
    expect(initial.map((clock) => clock.metric)).toEqual(['TRIAGE', 'FIRST_RESPONSE', 'RESOLUTION']);

    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'WAITING_ON_CUSTOMER',
      at: new Date('2026-08-24T10:00:00.000Z')
    }));
    await prisma.supportBusinessCalendar.update({
      where: { id: fixture.calendar.id },
      data: { timezone: 'America/New_York' }
    });
    await prisma.supportBusinessCalendarPeriod.deleteMany({ where: { calendarId: fixture.calendar.id } });
    await prisma.supportBusinessCalendarPeriod.createMany({
      data: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
        calendarId: fixture.calendar.id,
        dayOfWeek,
        startMinute: 0,
        endMinute: 60
      }))
    });

    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'CUSTOMER_ACTIVITY',
      at: new Date('2026-08-24T12:00:00.000Z')
    }));
    const resolution = await prisma.supportCaseSlaClock.findFirstOrThrow({
      where: { caseId: fixture.supportCase.id, metric: 'RESOLUTION', cycle: 1 }
    });
    const frozenResolution = clockFromRow(resolution);
    expect(frozenResolution.calendar.timezone).toBe('UTC');
    expect(frozenResolution.dueAt.toISOString()).toBe('2026-08-25T11:00:00.000Z');

    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'HUMAN_PUBLIC_RESPONSE',
      at: new Date('2026-08-24T13:00:00.000Z'),
      interaction: { visibility: 'PUBLIC', direction: 'OUTBOUND', humanAuthored: true, automated: false }
    }));
    expect(await prisma.supportCaseSlaClock.count({
      where: { caseId: fixture.supportCase.id, metric: { in: ['FIRST_RESPONSE', 'NEXT_RESPONSE'] }, state: 'MET' }
    })).toBe(2);

    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'RESOLVED',
      at: new Date('2026-08-24T14:00:00.000Z')
    }));
    await prisma.supportCase.update({
      where: { id: fixture.supportCase.id },
      data: { reopenCount: 1 }
    });
    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'REOPENED',
      at: new Date('2026-08-24T15:00:00.000Z')
    }));
    const reopened = await prisma.supportCaseSlaClock.findMany({
      where: { caseId: fixture.supportCase.id },
      orderBy: [{ metric: 'asc' }, { cycle: 'asc' }]
    });
    expect(reopened.filter((clock) => clock.metric === 'RESOLUTION').map((clock) => clock.cycle)).toEqual([1, 2]);
    expect(reopened.filter((clock) => clock.metric === 'NEXT_RESPONSE').map((clock) => clock.cycle)).toEqual([1, 2]);
    expect(reopened.find((clock) => clock.metric === 'FOLLOW_UP')?.state).toBe('CANCELED');
  });

  test('expired Case snoozes resume frozen SLA clocks and append one audited sync transition', async () => {
    const fixture = await createSupportFixture();
    await prisma.supportSlaPolicy.update({
      where: { id: fixture.policy.id },
      data: {
        pauseRules: {
          waitingOnCustomer: ['RESOLUTION'],
          waitingOnInternal: [],
          snoozed: ['RESOLUTION'],
          automatedPublicResponseMeets: []
        }
      }
    });
    const startedAt = new Date('2026-08-24T09:00:00.000Z');
    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'CASE_CREATED',
      at: startedAt
    }));
    await prisma.$transaction((tx) => applySupportSlaCaseEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      event: 'SNOOZED',
      at: new Date('2026-08-24T10:00:00.000Z')
    }));
    const snoozed = await prisma.supportCase.update({
      where: { id: fixture.supportCase.id },
      data: { snoozedUntil: new Date('2026-08-24T10:30:00.000Z') }
    });
    expect((await prisma.supportCaseSlaClock.findUniqueOrThrow({
      where: { caseId_metric_cycle: { caseId: fixture.supportCase.id, metric: 'RESOLUTION', cycle: 1 } }
    })).state).toBe('PAUSED');

    await evaluateSupportRecoveryWorkspace(
      fixture.workspace.id,
      new Date('2026-08-24T11:00:00.000Z')
    );

    const [supportCase, clock, events, syncEvents] = await Promise.all([
      prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.supportCase.id } }),
      prisma.supportCaseSlaClock.findUniqueOrThrow({
        where: { caseId_metric_cycle: { caseId: fixture.supportCase.id, metric: 'RESOLUTION', cycle: 1 } }
      }),
      prisma.supportCaseEvent.findMany({
        where: { caseId: fixture.supportCase.id, action: 'case.attention_snooze_expired' }
      }),
      prisma.syncEvent.findMany({
        where: {
          workspaceId: fixture.workspace.id,
          entityType: 'support_case',
          entityId: fixture.supportCase.id,
          operation: 'upsert'
        }
      })
    ]);
    expect(supportCase.snoozedUntil).toBeNull();
    expect(supportCase.version).toBe(snoozed.version + 1);
    expect(clock.state).toBe('RUNNING');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'SYSTEM', source: 'SYSTEM' });
    expect(syncEvents).toHaveLength(1);

    await evaluateSupportRecoveryWorkspace(
      fixture.workspace.id,
      new Date('2026-08-24T11:05:00.000Z')
    );
    expect(await prisma.supportCaseEvent.count({
      where: { caseId: fixture.supportCase.id, action: 'case.attention_snooze_expired' }
    })).toBe(1);
  });

  test('breaches due clocks and projects one idempotent alert per metric cycle', async () => {
    const fixture = await createSupportFixture();
    const dueAt = new Date('2026-08-23T10:00:00.000Z');
    const makeClock = (cycle: number) => prisma.supportCaseSlaClock.create({ data: {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      policyId: fixture.policy.id,
      calendarId: fixture.calendar.id,
      metric: 'NEXT_RESPONSE',
      cycle,
      policyVersion: 1,
      targetBusinessSeconds: 3600,
      pauseRulesSnapshot: parseSupportSlaPolicy(fixture.policy).pauseRules,
      state: 'RUNNING',
      startedAt: new Date('2026-08-23T09:00:00.000Z'),
      dueAt
    } });
    await makeClock(1);

    const exactDeadline = await evaluateSupportRecoveryWorkspace(fixture.workspace.id, dueAt);
    expect(exactDeadline.breachedClocks).toBe(0);
    expect((await prisma.supportCaseSlaClock.findFirstOrThrow({
      where: { caseId: fixture.supportCase.id, metric: 'NEXT_RESPONSE', cycle: 1 }
    })).state).toBe('RUNNING');

    const first = await evaluateSupportRecoveryWorkspace(fixture.workspace.id, new Date('2026-08-23T12:00:00.000Z'));
    const second = await evaluateSupportRecoveryWorkspace(fixture.workspace.id, new Date('2026-08-23T12:01:00.000Z'));
    expect(first.breachedClocks).toBe(1);
    expect(second.breachedClocks).toBe(0);
    expect(await prisma.attentionItem.count({
      where: { workspaceId: fixture.workspace.id, reason: 'SLA_BREACHED' }
    })).toBe(1);

    await makeClock(2);
    await evaluateSupportRecoveryWorkspace(fixture.workspace.id, new Date('2026-08-23T12:02:00.000Z'));
    const alerts = await prisma.attentionItem.findMany({
      where: { workspaceId: fixture.workspace.id, reason: 'SLA_BREACHED' },
      orderBy: { createdAt: 'asc' }
    });
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((item) => item.entityId)).size).toBe(2);
  });

  test('resolves a projected reason when its source condition clears', async () => {
    const fixture = await createSupportFixture();
    const candidate = {
      workspaceId: fixture.workspace.id,
      entityType: 'support_case' as const,
      entityId: fixture.supportCase.id,
      supportCaseId: fixture.supportCase.id,
      reason: 'NO_NEXT_ACTION' as const,
      severity: 'MEDIUM' as const,
      assigneeId: null,
      dueAt: null,
      conditionKey: `NO_NEXT_ACTION:${fixture.supportCase.id}:OPEN`,
      title: `${fixture.supportCase.key}: ${fixture.supportCase.title}`,
      description: 'No next action.'
    };
    await synchronizeSupportRecoveryAttention(fixture.workspace.id, [candidate]);
    await synchronizeSupportRecoveryAttention(fixture.workspace.id, []);
    const item = await prisma.attentionItem.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, reason: 'NO_NEXT_ACTION' }
    });
    expect(item.status).toBe('RESOLVED');
    expect(item.resolvedAt).not.toBeNull();
  });

  test('a dismissed condition stays hidden while active and reopens after it clears and recurs', async () => {
    const fixture = await createSupportFixture();
    const candidate = {
      workspaceId: fixture.workspace.id,
      entityType: 'support_case' as const,
      entityId: fixture.supportCase.id,
      supportCaseId: fixture.supportCase.id,
      reason: 'NO_NEXT_ACTION' as const,
      severity: 'MEDIUM' as const,
      assigneeId: null,
      dueAt: null,
      conditionKey: `NO_NEXT_ACTION:${fixture.supportCase.id}:OPEN`,
      title: `${fixture.supportCase.key}: ${fixture.supportCase.title}`,
      description: 'No next action.'
    };
    const firstAt = new Date('2026-08-23T12:00:00.000Z');
    await synchronizeSupportRecoveryAttention(fixture.workspace.id, [candidate], firstAt);
    await prisma.attentionItem.updateMany({
      where: { workspaceId: fixture.workspace.id, reason: 'NO_NEXT_ACTION' },
      data: { status: 'DISMISSED', dismissedAt: firstAt, dismissalReason: 'Accepted temporarily' }
    });

    await synchronizeSupportRecoveryAttention(
      fixture.workspace.id,
      [candidate],
      new Date('2026-08-23T12:01:00.000Z')
    );
    expect((await prisma.attentionItem.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, reason: 'NO_NEXT_ACTION' }
    })).status).toBe('DISMISSED');

    await synchronizeSupportRecoveryAttention(
      fixture.workspace.id,
      [],
      new Date('2026-08-23T12:02:00.000Z')
    );
    await synchronizeSupportRecoveryAttention(
      fixture.workspace.id,
      [candidate],
      new Date('2026-08-23T12:03:00.000Z')
    );
    const reopened = await prisma.attentionItem.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, reason: 'NO_NEXT_ACTION' }
    });
    expect(reopened.status).toBe('OPEN');
    expect(reopened.dismissedAt).toBeNull();
    expect(reopened.resolvedAt).toBeNull();
  });

  test('exposes an access-neutral Case filter and reason map for active projections', async () => {
    const fixture = await createSupportFixture();
    const candidate = {
      workspaceId: fixture.workspace.id,
      entityType: 'support_case_sla_clock' as const,
      entityId: '80000000-0000-4000-8000-000000000001',
      supportCaseId: fixture.supportCase.id,
      reason: 'SLA_AT_RISK' as const,
      severity: 'MEDIUM' as const,
      assigneeId: null,
      dueAt: new Date('2026-08-23T13:00:00.000Z'),
      conditionKey: `SLA_AT_RISK:${fixture.supportCase.id}:FIRST_RESPONSE:1`,
      title: `${fixture.supportCase.key}: ${fixture.supportCase.title}`,
      description: 'At risk.',
      metric: 'FIRST_RESPONSE' as const,
      cycle: 1
    };
    const now = new Date('2026-08-23T12:00:00.000Z');
    await synchronizeSupportRecoveryAttention(fixture.workspace.id, [candidate], now);

    expect(await supportAttentionCaseWhere(fixture.workspace.id, now)).toEqual({
      id: { in: [fixture.supportCase.id] }
    });
    expect(await supportAttentionReasonsByCaseIds(
      fixture.workspace.id,
      [fixture.supportCase.id],
      now
    )).toEqual(new Map([[fixture.supportCase.id, ['SLA_AT_RISK']]]));

    await prisma.attentionItem.updateMany({
      where: { workspaceId: fixture.workspace.id, reason: 'SLA_AT_RISK' },
      data: { status: 'SNOOZED', snoozedUntil: new Date('2026-08-23T13:00:00.000Z') }
    });
    expect(await supportAttentionCaseWhere(fixture.workspace.id, now)).toEqual({ id: { in: [] } });
  });

  test('an older projection run cannot resolve a signal seen by a newer run', async () => {
    const fixture = await createSupportFixture();
    const candidate = {
      workspaceId: fixture.workspace.id,
      entityType: 'support_case' as const,
      entityId: fixture.supportCase.id,
      supportCaseId: fixture.supportCase.id,
      reason: 'NO_NEXT_ACTION' as const,
      severity: 'MEDIUM' as const,
      assigneeId: null,
      dueAt: null,
      conditionKey: `NO_NEXT_ACTION:${fixture.supportCase.id}:OPEN`,
      title: `${fixture.supportCase.key}: ${fixture.supportCase.title}`,
      description: 'No next action.'
    };
    const newerAt = new Date('2026-08-23T12:01:00.000Z');
    await synchronizeSupportRecoveryAttention(fixture.workspace.id, [candidate], newerAt);
    await synchronizeSupportRecoveryAttention(
      fixture.workspace.id,
      [],
      new Date('2026-08-23T12:00:00.000Z')
    );
    const item = await prisma.attentionItem.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, reason: 'NO_NEXT_ACTION' }
    });
    expect(item.status).toBe('OPEN');
    expect(item.lastSeenAt.toISOString()).toBe(newerAt.toISOString());
  });

  test('unrelated events do not reset the age of a waiting-state transition', async () => {
    const fixture = await createSupportFixture();
    const now = new Date('2026-08-26T12:00:00.000Z');
    await prisma.supportCase.update({
      where: { id: fixture.supportCase.id },
      data: {
        status: 'WAITING_ON_INTERNAL',
        waitingReason: 'Pending an internal dependency',
        nextActionAt: new Date('2026-08-27T12:00:00.000Z'),
        lastMeaningfulActivityAt: now
      }
    });
    await prisma.supportCaseEvent.createMany({ data: [
      {
        workspaceId: fixture.workspace.id,
        caseId: fixture.supportCase.id,
        sequence: 1,
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        action: 'case.waiting_on_internal',
        before: { status: 'OPEN', departmentId: null },
        after: { status: 'WAITING_ON_INTERNAL', departmentId: null },
        occurredAt: new Date('2026-08-23T10:00:00.000Z')
      },
      {
        workspaceId: fixture.workspace.id,
        caseId: fixture.supportCase.id,
        sequence: 2,
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        action: 'case.interaction_recorded',
        after: { status: 'WAITING_ON_INTERNAL', departmentId: null },
        occurredAt: new Date('2026-08-26T11:59:00.000Z')
      }
    ] });

    await evaluateSupportRecoveryWorkspace(fixture.workspace.id, now);
    expect(await prisma.attentionItem.count({
      where: { workspaceId: fixture.workspace.id, reason: 'WAITING_ON_INTERNAL_TOO_LONG', status: 'OPEN' }
    })).toBe(1);
  });

  test('uses the referenced policy version at-risk window during evaluation', async () => {
    const fixture = await createSupportFixture();
    await prisma.supportCaseSlaClock.create({ data: {
      workspaceId: fixture.workspace.id,
      caseId: fixture.supportCase.id,
      policyId: fixture.policy.id,
      calendarId: fixture.calendar.id,
      metric: 'NEXT_RESPONSE',
      cycle: 1,
      policyVersion: 1,
      targetBusinessSeconds: 2 * 60 * 60,
      pauseRulesSnapshot: parseSupportSlaPolicy(fixture.policy).pauseRules,
      state: 'RUNNING',
      startedAt: new Date('2026-08-23T11:30:00.000Z'),
      dueAt: new Date('2026-08-23T13:30:00.000Z')
    } });
    await evaluateSupportRecoveryWorkspace(fixture.workspace.id, new Date('2026-08-23T12:00:00.000Z'));
    expect(await prisma.attentionItem.count({
      where: { workspaceId: fixture.workspace.id, reason: 'SLA_AT_RISK', status: 'OPEN' }
    })).toBe(1);
  });
});

async function createSupportFixture() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `Support SLA ${suffix}`, slug: `support-sla-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60), mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({ data: { workspaceId: workspace.id, keyPrefix: 'SLA', nextCaseNumber: 2 } });
  const supportCase = await prisma.supportCase.create({ data: {
    workspaceId: workspace.id,
    key: 'SLA-1',
    sequence: 1,
    title: 'SLA fixture',
    sourceChannel: 'MANUAL',
    typeKey: 'incident',
    priority: 'NORMAL',
    status: 'OPEN',
    receivedAt: new Date('2026-08-23T09:00:00.000Z'),
    lastMeaningfulActivityAt: new Date('2026-08-23T09:00:00.000Z')
  } });
  const calendar = await prisma.supportBusinessCalendar.create({
    data: { workspaceId: workspace.id, name: 'UTC weekdays', timezone: 'UTC' }
  });
  const periods = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60 }));
  await prisma.supportBusinessCalendarPeriod.createMany({
    data: periods.map((period) => ({ calendarId: calendar.id, ...period }))
  });
  const policy = await prisma.supportSlaPolicy.create({ data: {
    workspaceId: workspace.id,
    calendarId: calendar.id,
    policyKey: 'default',
    name: 'Default',
    version: 1,
    conditions: {},
    targets: {
      TRIAGE: { businessSeconds: 60 * 60 },
      FIRST_RESPONSE: { businessSeconds: 4 * 60 * 60 },
      NEXT_RESPONSE: { businessSeconds: 2 * 60 * 60, atRiskSeconds: 2 * 60 * 60 },
      RESOLUTION: { businessSeconds: 8 * 60 * 60 },
      FOLLOW_UP: { businessSeconds: 4 * 60 * 60 },
      MEMBER_ASSIGNMENT: { businessSeconds: 60 * 60 }
    },
    pauseRules: {
      waitingOnCustomer: ['RESOLUTION'],
      waitingOnInternal: [],
      snoozed: [],
      automatedPublicResponseMeets: []
    },
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z')
  } });
  return { workspace, supportCase, calendar, periods, policy };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}
