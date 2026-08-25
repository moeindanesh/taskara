import { randomUUID } from 'node:crypto';
import {
  Prisma,
  prisma,
  type AttentionItem,
  type SupportJobLease,
  type SupportJobLeaseStatus
} from '@taskara/db';
import { supportAttentionReasons, type SupportAttentionReasonValue } from '@taskara/shared';
import { config } from '../config';
import {
  defaultSupportRecoveryThresholds,
  deriveSupportRecoveryCandidates,
  type SupportRecoveryCandidate,
  type SupportRecoveryCaseFacts,
  type SupportRecoveryThresholds
} from './support-recovery';
import {
  clockFromRow,
  hasFrozenSupportSlaClockConfig,
  applySupportSlaCaseEvent,
  refreshSupportCaseNextSlaDueAt,
  supportSlaTargetsSchema
} from './support-sla';
import { snapshotSupportBusinessCalendar } from './support-business-time';
import { appendSupportCaseSyncEvent } from './support-sync';

export const SUPPORT_RECOVERY_JOB_KEY = 'support_recovery';
const DEFAULT_SUPPORT_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_SUPPORT_RECOVERY_BUCKET_MS = 5 * 60_000;

export interface SupportJobLeaseOptions {
  now?: Date;
  leaseMilliseconds?: number;
  maxAttempts?: number;
  baseRetryMilliseconds?: number;
}

export interface RunSupportJobResult<T> {
  claimed: boolean;
  lease: SupportJobLease;
  result?: T;
  error?: unknown;
  leaseLost?: boolean;
}

export interface SupportJobLeaseControl {
  renew: (at?: Date) => Promise<boolean>;
}

export class SupportJobLeaseLostError extends Error {
  readonly code = 'SUPPORT_JOB_LEASE_LOST';

  constructor() {
    super('Support job lease ownership was lost before completion');
    this.name = 'SupportJobLeaseLostError';
  }
}

export interface SupportRecoveryEvaluationResult {
  evaluatedCases: number;
  breachedClocks: number;
  activeAttentionItems: number;
  resolvedAttentionItems: number;
}

export interface SupportRecoveryWorkerOptions extends Omit<SupportJobLeaseOptions, 'now'> {
  owner?: string;
  enabled?: boolean;
  intervalMilliseconds?: number;
  bucketMilliseconds?: number;
  workspaceBatchSize?: number;
  retryBatchSize?: number;
  now?: Date;
  thresholds?: Partial<SupportRecoveryThresholds>;
}

export interface SupportRecoveryWorkerTickResult {
  workspaces: number;
  bucketsClaimed: number;
  bucketsCompleted: number;
  bucketsRetryPending: number;
  bucketsDeadLettered: number;
}

export interface SupportRecoveryWorkerHandle {
  owner: string;
  stop: () => Promise<void>;
}

/**
 * Stable UTC identity for an idempotent recovery evaluation window.
 *
 * The key is derived from epoch time rather than server-local calendar fields, so every API
 * process names the same bucket even when hosts use different timezones.
 */
export function supportRecoveryBucketKey(
  at = new Date(),
  bucketMilliseconds = DEFAULT_SUPPORT_RECOVERY_BUCKET_MS
): string {
  if (!Number.isFinite(at.getTime())) throw new Error('Support recovery bucket time must be valid');
  if (!Number.isInteger(bucketMilliseconds) || bucketMilliseconds <= 0) {
    throw new Error('Support recovery bucketMilliseconds must be a positive integer');
  }
  return new Date(Math.floor(at.getTime() / bucketMilliseconds) * bucketMilliseconds).toISOString();
}

/**
 * Evaluates the current bucket for every Support workspace and also drains due retries from older
 * buckets. Workspace pagination bounds memory without making one page a scheduling boundary.
 */
export async function runSupportRecoveryWorkerTick(
  options: SupportRecoveryWorkerOptions = {}
): Promise<SupportRecoveryWorkerTickResult> {
  const owner = options.owner ?? `support-recovery-worker-${randomUUID()}`;
  if (!owner.trim()) throw new Error('Support recovery worker owner cannot be empty');
  const now = options.now ?? new Date();
  const bucketKey = supportRecoveryBucketKey(now, options.bucketMilliseconds);
  const workspaceBatchSize = boundedWorkerBatchSize(options.workspaceBatchSize, 100);
  const retryBatchSize = boundedWorkerBatchSize(options.retryBatchSize, 100);
  const stats: SupportRecoveryWorkerTickResult = {
    workspaces: 0,
    bucketsClaimed: 0,
    bucketsCompleted: 0,
    bucketsRetryPending: 0,
    bucketsDeadLettered: 0
  };
  const attempted = new Set<string>();

  const runBucket = async (workspaceId: string, candidateBucketKey: string) => {
    const identity = `${workspaceId}:${candidateBucketKey}`;
    if (attempted.has(identity)) return;
    attempted.add(identity);
    const outcome = await runSupportRecoveryBucket(workspaceId, candidateBucketKey, owner, {
      now,
      thresholds: options.thresholds,
      leaseMilliseconds: options.leaseMilliseconds,
      maxAttempts: options.maxAttempts,
      baseRetryMilliseconds: options.baseRetryMilliseconds
    });
    if (outcome.claimed) stats.bucketsClaimed += 1;
    if (outcome.leaseLost) return;
    if (outcome.claimed && outcome.lease.status === 'COMPLETED') stats.bucketsCompleted += 1;
    if (outcome.claimed && outcome.lease.status === 'RETRY_PENDING') stats.bucketsRetryPending += 1;
    // A crashed final attempt is converted to DEAD_LETTER while trying to claim it, so this one
    // terminal transition is intentionally counted even though no new attempt was claimed.
    if (outcome.lease.status === 'DEAD_LETTER') stats.bucketsDeadLettered += 1;
  };

  const dueRetries = await prisma.supportJobLease.findMany({
    where: {
      jobKey: SUPPORT_RECOVERY_JOB_KEY,
      bucketKey: { not: bucketKey },
      workspace: { is: { mode: 'SUPPORT' } },
      OR: [
        { status: { in: ['PENDING', 'RETRY_PENDING'] }, nextAttemptAt: { lte: now } },
        { status: 'RUNNING', leaseExpiresAt: { lte: now } }
      ]
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: retryBatchSize,
    select: { workspaceId: true, bucketKey: true }
  });
  for (const retry of dueRetries) await runBucket(retry.workspaceId, retry.bucketKey);

  let afterWorkspaceId: string | undefined;
  while (true) {
    const workspaces = await prisma.workspace.findMany({
      where: {
        mode: 'SUPPORT',
        ...(afterWorkspaceId ? { id: { gt: afterWorkspaceId } } : {})
      },
      orderBy: { id: 'asc' },
      take: workspaceBatchSize,
      select: { id: true }
    });
    if (!workspaces.length) break;
    stats.workspaces += workspaces.length;
    for (const workspace of workspaces) await runBucket(workspace.id, bucketKey);
    if (workspaces.length < workspaceBatchSize) break;
    afterWorkspaceId = workspaces.at(-1)?.id;
    if (!afterWorkspaceId) break;
  }

  return stats;
}

export function startSupportRecoveryWorker(
  options: Omit<SupportRecoveryWorkerOptions, 'now'> = {}
): SupportRecoveryWorkerHandle {
  const owner = options.owner ?? `support-recovery-worker-${randomUUID()}`;
  if (!owner.trim()) throw new Error('Support recovery worker owner cannot be empty');
  if (!(options.enabled ?? config.TASKARA_SUPPORT_RECOVERY_WORKER_ENABLED)) {
    return { owner, stop: async () => undefined };
  }
  const intervalMilliseconds = options.intervalMilliseconds ?? DEFAULT_SUPPORT_RECOVERY_INTERVAL_MS;
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error('Support recovery intervalMilliseconds must be a positive integer');
  }

  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  const run = () => {
    if (stopped || inFlight) return;
    inFlight = runSupportRecoveryWorkerTick({ ...options, owner })
      .catch(() => undefined)
      .finally(() => { inFlight = null; });
  };
  const timer = setInterval(run, intervalMilliseconds);
  timer.unref?.();
  run();

  return {
    owner,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await releaseSupportRecoveryWorkerLeases(owner);
    }
  };
}

/** Makes unfinished work immediately claimable during graceful process shutdown. */
export async function releaseSupportRecoveryWorkerLeases(
  owner: string,
  now = new Date()
): Promise<number> {
  if (!owner.trim()) throw new Error('Support recovery worker owner cannot be empty');
  if (!Number.isFinite(now.getTime())) throw new Error('Support recovery release time must be valid');
  const released = await prisma.supportJobLease.updateMany({
    where: {
      jobKey: SUPPORT_RECOVERY_JOB_KEY,
      status: 'RUNNING',
      leaseOwner: owner
    },
    data: {
      status: 'RETRY_PENDING',
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null
    }
  });
  return released.count;
}

export async function runSupportJobLease<T>(
  input: {
    workspaceId: string;
    jobKey: string;
    bucketKey: string;
    workerId: string;
    run: (lease: SupportJobLease, control: SupportJobLeaseControl) => Promise<T>;
  },
  options: SupportJobLeaseOptions = {}
): Promise<RunSupportJobResult<T>> {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? 8;
  const leaseMilliseconds = options.leaseMilliseconds ?? 2 * 60 * 1000;
  const baseRetryMilliseconds = options.baseRetryMilliseconds ?? 30 * 1000;
  validateSupportJobLeaseInput(input, { maxAttempts, leaseMilliseconds, baseRetryMilliseconds });
  await ensureSupportJobLease(input.workspaceId, input.jobKey, input.bucketKey, now);
  const lease = await claimSupportJobLease(
    input.workspaceId,
    input.jobKey,
    input.bucketKey,
    input.workerId,
    now,
    leaseMilliseconds,
    maxAttempts
  );
  if (!lease) {
    return {
      claimed: false,
      lease: await prisma.supportJobLease.findUniqueOrThrow({
        where: { jobKey_workspaceId_bucketKey: { jobKey: input.jobKey, workspaceId: input.workspaceId, bucketKey: input.bucketKey } }
      })
    };
  }

  try {
    const result = await input.run(lease, {
      renew: (at = new Date()) => renewSupportJobLease(
        lease.id,
        input.workerId,
        lease.attemptCount,
        at,
        leaseMilliseconds
      )
    });
    const finishedAt = options.now ?? new Date();
    const completed = await prisma.supportJobLease.updateMany({
      where: {
        id: lease.id,
        status: 'RUNNING',
        leaseOwner: input.workerId,
        attemptCount: lease.attemptCount,
        leaseExpiresAt: { gt: finishedAt }
      },
      data: {
        status: 'COMPLETED',
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: finishedAt,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });
    const authoritative = await prisma.supportJobLease.findUniqueOrThrow({ where: { id: lease.id } });
    return completed.count === 1
      ? { claimed: true, lease: authoritative, result }
      : { claimed: true, lease: authoritative, leaseLost: true, error: new SupportJobLeaseLostError() };
  } catch (error) {
    const finalAttempt = lease.attemptCount >= maxAttempts;
    const failedAt = options.now ?? new Date();
    const status: SupportJobLeaseStatus = finalAttempt ? 'DEAD_LETTER' : 'RETRY_PENDING';
    const retryDelay = Math.min(24 * 60 * 60 * 1000, baseRetryMilliseconds * 2 ** Math.max(0, lease.attemptCount - 1));
    const failed = await prisma.supportJobLease.updateMany({
      where: {
        id: lease.id,
        status: 'RUNNING',
        leaseOwner: input.workerId,
        attemptCount: lease.attemptCount,
        leaseExpiresAt: { gt: failedAt }
      },
      data: {
        status,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(failedAt.getTime() + retryDelay),
        deadLetteredAt: finalAttempt ? failedAt : null,
        lastErrorCode: errorCode(error),
        lastErrorMessage: safeErrorMessage(error)
      }
    });
    const authoritative = await prisma.supportJobLease.findUniqueOrThrow({ where: { id: lease.id } });
    return failed.count === 1
      ? { claimed: true, lease: authoritative, error }
      : { claimed: true, lease: authoritative, error, leaseLost: true };
  }
}

export async function runSupportRecoveryBucket(
  workspaceId: string,
  bucketKey: string,
  workerId: string,
  options: SupportJobLeaseOptions & {
    now?: Date;
    thresholds?: Partial<SupportRecoveryThresholds>;
  } = {}
): Promise<RunSupportJobResult<SupportRecoveryEvaluationResult>> {
  const now = options.now ?? new Date();
  return runSupportJobLease({
    workspaceId,
    jobKey: SUPPORT_RECOVERY_JOB_KEY,
    bucketKey,
    workerId,
    run: () => evaluateSupportRecoveryWorkspace(workspaceId, now, options.thresholds)
  }, { ...options, now });
}

export async function evaluateSupportRecoveryWorkspace(
  workspaceId: string,
  now = new Date(),
  thresholds: Partial<SupportRecoveryThresholds> = {}
): Promise<SupportRecoveryEvaluationResult> {
  await resumeExpiredSupportSnoozes(workspaceId, now);
  const breachedCount = await prisma.$transaction(async (tx) => {
    const due = await tx.supportCaseSlaClock.findMany({
      where: { workspaceId, state: 'RUNNING', dueAt: { lt: now } },
      select: { id: true, dueAt: true }
    });
    let count = 0;
    for (const clock of due) {
      const updated = await tx.supportCaseSlaClock.updateMany({
        where: { id: clock.id, state: 'RUNNING', dueAt: { lt: now } },
        data: { state: 'BREACHED', breachedAt: clock.dueAt, pausedAt: null }
      });
      count += updated.count;
    }
    return count;
  });
  const cases = await prisma.supportCase.findMany({
    where: { workspaceId, status: { not: 'CLOSED' } },
    include: {
      assigneeMembership: { select: { userId: true } },
      slaClocks: {
        include: {
          policy: { select: { targets: true } },
          calendar: { include: { periods: true, holidays: true } }
        }
      },
      interactions: {
        where: { kind: 'CALL', call: { isNot: null } },
        select: { id: true, call: true }
      },
      events: {
        orderBy: { sequence: 'asc' },
        select: { action: true, before: true, after: true, occurredAt: true }
      },
      taskLinks: {
        where: { unlinkedAt: null },
        select: {
          taskStatusSnapshot: true,
          taskDeletedAt: true,
          connectionRevokedAt: true,
          task: { select: { status: true, dueAt: true } }
        }
      }
    },
    orderBy: { id: 'asc' }
  });

  const candidates: SupportRecoveryCandidate[] = [];
  for (const supportCase of cases) {
    const recoveryFacts = supportRecoveryFactsFromRow(supportCase, now);
    candidates.push(...deriveSupportRecoveryCandidates({
      supportCase: recoveryFacts,
      clocks: supportCase.slaClocks.map((clock) => {
        const frozen = clockFromRow(
          clock,
          hasFrozenSupportSlaClockConfig(clock.pauseRulesSnapshot)
            ? undefined
            : snapshotSupportBusinessCalendar(clock.calendar)
        );
        return {
          id: clock.id,
          metric: clock.metric,
          cycle: clock.cycle,
          state: clock.state,
          dueAt: clock.dueAt,
          breachedAt: clock.breachedAt,
          metAt: clock.metAt,
          canceledAt: clock.canceledAt,
          atRiskSeconds: frozen.atRiskSeconds ?? supportSlaTargetsSchema.parse(clock.policy.targets)[clock.metric]?.atRiskSeconds,
          frozenCalendar: frozen.calendar
        };
      }),
      calls: supportCase.interactions.flatMap((interaction) => interaction.call ? [{
        interactionId: interaction.id,
        disposition: interaction.call.disposition,
        callbackOwnerId: interaction.call.callbackOwnerId,
        callbackDueAt: interaction.call.callbackDueAt
      }] : []),
      now,
      thresholds: { ...defaultSupportRecoveryThresholds, ...thresholds }
    }));
    await refreshSupportCaseNextSlaDueAt(workspaceId, supportCase.id);
  }

  const synchronized = await synchronizeSupportRecoveryAttention(workspaceId, candidates, now);
  return {
    evaluatedCases: cases.length,
    breachedClocks: breachedCount,
    activeAttentionItems: synchronized.active,
    resolvedAttentionItems: synchronized.resolved
  };
}

/**
 * A future snooze suppresses recovery presentation, not the Case itself. Expiry is therefore a
 * real aggregate/SLA event: clear it under the Case lock, resume only clocks whose frozen policy
 * paused them for SNOOZED, and leave an append-only audit and payload-free sync wakeup.
 */
async function resumeExpiredSupportSnoozes(workspaceId: string, now: Date): Promise<void> {
  const candidates = await prisma.supportCase.findMany({
    where: { workspaceId, snoozedUntil: { lte: now } },
    orderBy: { id: 'asc' },
    select: { id: true }
  });
  for (const candidate of candidates) {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; snoozedUntil: Date; version: number }>>(Prisma.sql`
        SELECT "id", "snoozedUntil", "version"
        FROM "SupportCase"
        WHERE "id" = ${candidate.id}::uuid
          AND "workspaceId" = ${workspaceId}::uuid
          AND "snoozedUntil" <= ${now}
        FOR UPDATE
      `);
      const current = rows[0];
      if (!current) return;
      const updated = await tx.supportCase.update({
        where: { id: current.id },
        data: { snoozedUntil: null, version: { increment: 1 } },
        select: { id: true, workspaceId: true, version: true }
      });
      await applySupportSlaCaseEvent(tx, {
        workspaceId,
        caseId: current.id,
        event: 'RESUMED',
        at: now
      });
      const latest = await tx.supportCaseEvent.findFirst({
        where: { caseId: current.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true }
      });
      await tx.supportCaseEvent.create({
        data: {
          workspaceId,
          caseId: current.id,
          sequence: (latest?.sequence ?? 0) + 1,
          actorType: 'SYSTEM',
          source: 'SYSTEM',
          action: 'case.attention_snooze_expired',
          before: { snoozedUntil: current.snoozedUntil.toISOString() },
          after: { snoozedUntil: null },
          reason: 'Configured snooze window elapsed'
        }
      });
      await appendSupportCaseSyncEvent(tx, {
        workspaceId,
        caseId: current.id,
        caseVersion: updated.version,
        operation: 'upsert',
        actorId: null
      });
    });
  }
}

export async function synchronizeSupportRecoveryAttention(
  workspaceId: string,
  candidates: readonly SupportRecoveryCandidate[],
  now = new Date(),
  tx: Pick<Prisma.TransactionClient, 'attentionItem'> = prisma
): Promise<{ active: number; resolved: number }> {
  const candidateKeys = new Set(candidates.map(attentionCandidateKey));
  for (const candidate of candidates) {
    const where = {
      workspaceId_entityType_entityId_reason: {
        workspaceId,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        reason: candidate.reason
      }
    } as const;
    let current = await tx.attentionItem.findUnique({ where });
    const payload = supportAttentionPayload(candidate, now);
    if (!current) {
      const inserted = await tx.attentionItem.createMany({ data: {
        workspaceId,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        reason: candidate.reason,
        severity: candidate.severity,
        assigneeId: candidate.assigneeId,
        status: 'OPEN',
        firstSeenAt: now,
        lastSeenAt: now,
        payload
      }, skipDuplicates: true });
      if (inserted.count === 1) continue;
      current = await tx.attentionItem.findUnique({ where });
      if (!current) continue;
    }

    if (current.lastSeenAt.getTime() > now.getTime()) continue;
    const sameCondition = attentionConditionKey(current) === candidate.conditionKey;
    if (current.status === 'DISMISSED' && sameCondition) {
      await tx.attentionItem.updateMany({
        where: { id: current.id, status: 'DISMISSED', lastSeenAt: { lte: now } },
        data: { lastSeenAt: now, payload }
      });
      continue;
    }
    const reopen = current.status === 'RESOLVED' ||
      (current.status === 'DISMISSED' && !sameCondition);
    await tx.attentionItem.updateMany({
      where: { id: current.id, lastSeenAt: { lte: now } },
      data: {
        severity: candidate.severity,
        assigneeId: candidate.assigneeId,
        status: reopen ? 'OPEN' : current.status === 'SNOOZED' && current.snoozedUntil && current.snoozedUntil <= now ? 'OPEN' : current.status,
        firstSeenAt: reopen ? now : current.firstSeenAt,
        lastSeenAt: now,
        snoozedUntil: reopen ? null : current.snoozedUntil,
        resolvedAt: reopen ? null : current.resolvedAt,
        dismissedAt: reopen ? null : current.dismissedAt,
        dismissalReason: reopen ? null : current.dismissalReason,
        payload
      }
    });
  }

  const current = await tx.attentionItem.findMany({
    where: {
      workspaceId,
      reason: { in: [...supportAttentionReasons] },
      entityType: { in: ['support_case', 'support_case_sla_clock', 'support_call'] },
      status: { in: ['OPEN', 'SNOOZED', 'DISMISSED'] },
      lastSeenAt: { lte: now }
    }
  });
  let resolved = 0;
  for (const item of current) {
    if (candidateKeys.has(attentionItemKey(item))) continue;
    const updated = await tx.attentionItem.updateMany({
      where: { id: item.id, status: { in: ['OPEN', 'SNOOZED', 'DISMISSED'] }, lastSeenAt: { lte: now } },
      data: { status: 'RESOLVED', resolvedAt: now, snoozedUntil: null }
    });
    resolved += updated.count;
  }
  return { active: candidates.length, resolved };
}

/** Access-neutral projection helper. Callers must still AND the result with Support access scope. */
export async function supportAttentionCaseWhere(
  workspaceId: string,
  now = new Date(),
  tx: Pick<Prisma.TransactionClient, 'attentionItem'> = prisma
): Promise<Prisma.SupportCaseWhereInput> {
  const items = await loadActiveSupportAttentionItems(workspaceId, now, tx);
  const caseIds = [...new Set(items.map(attentionSupportCaseId).filter((id): id is string => Boolean(id)))];
  return { id: { in: caseIds } };
}

/** Returns projected reasons only; on-read source derivation can be merged as a correctness fallback. */
export async function supportAttentionReasonsByCaseIds(
  workspaceId: string,
  caseIds: readonly string[],
  now = new Date(),
  tx: Pick<Prisma.TransactionClient, 'attentionItem'> = prisma
): Promise<Map<string, SupportAttentionReasonValue[]>> {
  const requested = new Set(caseIds);
  const result = new Map<string, SupportAttentionReasonValue[]>();
  if (!requested.size) return result;
  for (const item of await loadActiveSupportAttentionItems(workspaceId, now, tx)) {
    const caseId = attentionSupportCaseId(item);
    if (!caseId || !requested.has(caseId) || !isKnownSupportAttentionReason(item.reason)) continue;
    const reasons = result.get(caseId) ?? [];
    if (!reasons.includes(item.reason)) reasons.push(item.reason);
    result.set(caseId, reasons);
  }
  return result;
}

function supportRecoveryFactsFromRow(
  supportCase: Awaited<ReturnType<typeof loadSupportCaseShape>>,
  now: Date
): SupportRecoveryCaseFacts {
  const statusEvent = [...supportCase.events].reverse().find((event) => {
    const before = jsonString(event.before, 'status');
    const after = jsonString(event.after, 'status');
    return after === supportCase.status && (
      (before !== null && before !== after) ||
      (before === null && SUPPORT_STATUS_TRANSITION_ACTIONS.has(event.action))
    );
  });
  const departmentEvent = supportCase.departmentId
    ? [...supportCase.events].reverse().find((event) => {
        const before = jsonString(event.before, 'departmentId');
        const after = jsonString(event.after, 'departmentId');
        return after === supportCase.departmentId && (
          (before !== null && before !== after) ||
          (before === null && SUPPORT_DEPARTMENT_TRANSITION_ACTIONS.has(event.action))
        );
      })
    : undefined;
  const transferCount = supportCase.events.filter((event) =>
    event.action === 'case.transferred' ||
    (jsonString(event.before, 'departmentId') !== null && jsonString(event.after, 'departmentId') !== null && jsonString(event.before, 'departmentId') !== jsonString(event.after, 'departmentId'))
  ).length;
  return {
    id: supportCase.id,
    workspaceId: supportCase.workspaceId,
    key: supportCase.key,
    title: supportCase.title,
    status: supportCase.status,
    priority: supportCase.priority,
    departmentId: supportCase.departmentId,
    assigneeMembershipId: supportCase.assigneeMembershipId,
    assigneeUserId: supportCase.assigneeMembership?.userId ?? null,
    receivedAt: supportCase.receivedAt,
    lastMeaningfulActivityAt: supportCase.lastMeaningfulActivityAt,
    nextActionAt: supportCase.nextActionAt,
    reopenedAt: supportCase.reopenedAt,
    resolvedAt: supportCase.resolvedAt,
    resolutionCode: supportCase.resolutionCode,
    // Never use updatedAt for recovery. The authoritative event timestamp wins; immutable lifecycle
    // timestamps are a safe fallback for pre-ledger rows.
    statusSince: statusEvent?.occurredAt ?? supportCase.reopenedAt ?? supportCase.resolvedAt ?? supportCase.receivedAt,
    departmentAssignedAt: supportCase.departmentId
      ? departmentEvent?.occurredAt ?? supportCase.receivedAt
      : null,
    transferCount,
    handoffRejectedOrExpired: supportCase.taskLinks.some((link) => Boolean(link.connectionRevokedAt)),
    linkedTaskBlockedOrOverdue: supportCase.taskLinks.some((link) =>
      Boolean(link.taskDeletedAt) || (
        link.taskStatusSnapshot === 'BLOCKED' ||
        link.task?.status === 'BLOCKED' ||
        Boolean(
          link.task?.dueAt &&
          link.task.dueAt.getTime() < now.getTime() &&
          link.task.status !== 'DONE' &&
          link.task.status !== 'CANCELED'
        )
      )
    )
  };
}

const SUPPORT_STATUS_TRANSITION_ACTIONS = new Set([
  'case.created',
  'case.created_from_closed_followup',
  'case.routed',
  'case.waiting_on_customer',
  'case.waiting_on_internal',
  'case.resolved',
  'case.closed',
  'case.reopened',
  'case.reopened_by_customer',
  'case.customer_replied'
]);

const SUPPORT_DEPARTMENT_TRANSITION_ACTIONS = new Set([
  'case.created',
  'case.routed',
  'case.transferred'
]);

function loadSupportCaseShape() {
  return prisma.supportCase.findFirstOrThrow({
    include: {
      assigneeMembership: { select: { userId: true } },
      slaClocks: {
        include: { policy: { select: { targets: true } } }
      },
      interactions: { select: { id: true, call: true } },
      events: { select: { action: true, before: true, after: true, occurredAt: true } },
      taskLinks: {
        select: {
          taskStatusSnapshot: true,
          taskDeletedAt: true,
          connectionRevokedAt: true,
          task: { select: { status: true, dueAt: true } }
        }
      }
    }
  });
}

function supportAttentionPayload(candidate: SupportRecoveryCandidate, now: Date): Prisma.InputJsonValue {
  return toJson({
    version: 1,
    source: 'support_recovery',
    supportCaseId: candidate.supportCaseId,
    title: candidate.title,
    description: candidate.description,
    reason: candidate.reason,
    severity: candidate.severity,
    metric: candidate.metric,
    cycle: candidate.cycle,
    dueAt: candidate.dueAt?.toISOString() ?? null,
    signal: { conditionKey: candidate.conditionKey, generatedAt: now.toISOString() }
  });
}

function attentionConditionKey(item: AttentionItem): string | null {
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return null;
  const signal = (item.payload as Record<string, unknown>).signal;
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return null;
  const key = (signal as Record<string, unknown>).conditionKey;
  return typeof key === 'string' ? key : null;
}

function attentionCandidateKey(candidate: SupportRecoveryCandidate): string {
  return [candidate.entityType, candidate.entityId, candidate.reason].join(':');
}

function attentionItemKey(item: Pick<AttentionItem, 'entityType' | 'entityId' | 'reason'>): string {
  return [item.entityType, item.entityId, item.reason].join(':');
}

async function loadActiveSupportAttentionItems(
  workspaceId: string,
  now: Date,
  tx: Pick<Prisma.TransactionClient, 'attentionItem'>
) {
  return tx.attentionItem.findMany({
    where: {
      workspaceId,
      reason: { in: [...supportAttentionReasons] },
      entityType: { in: ['support_case', 'support_case_sla_clock', 'support_call'] },
      OR: [
        { status: 'OPEN' },
        { status: 'SNOOZED', snoozedUntil: { lte: now } }
      ]
    },
    orderBy: [{ severity: 'desc' }, { lastSeenAt: 'asc' }, { reason: 'asc' }],
    select: { entityType: true, entityId: true, reason: true, payload: true }
  });
}

function attentionSupportCaseId(
  item: Pick<AttentionItem, 'entityType' | 'entityId' | 'payload'>
): string | null {
  if (item.entityType === 'support_case') return item.entityId;
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return null;
  const value = (item.payload as Record<string, unknown>).supportCaseId;
  return typeof value === 'string' ? value : null;
}

function isKnownSupportAttentionReason(reason: string): reason is SupportAttentionReasonValue {
  return (supportAttentionReasons as readonly string[]).includes(reason);
}

async function ensureSupportJobLease(workspaceId: string, jobKey: string, bucketKey: string, now: Date): Promise<void> {
  await prisma.supportJobLease.upsert({
    where: { jobKey_workspaceId_bucketKey: { jobKey, workspaceId, bucketKey } },
    update: {},
    create: { workspaceId, jobKey, bucketKey, nextAttemptAt: now }
  });
}

/** Extends only the exact fenced attempt currently owned by this worker. */
export async function renewSupportJobLease(
  leaseId: string,
  workerId: string,
  attemptCount: number,
  at = new Date(),
  leaseMilliseconds = 2 * 60 * 1000
): Promise<boolean> {
  if (!workerId.trim() || !Number.isInteger(attemptCount) || attemptCount < 1) return false;
  if (!Number.isFinite(leaseMilliseconds) || leaseMilliseconds <= 0) return false;
  const renewed = await prisma.supportJobLease.updateMany({
    where: {
      id: leaseId,
      status: 'RUNNING',
      leaseOwner: workerId,
      attemptCount,
      leaseExpiresAt: { gt: at }
    },
    data: { leaseExpiresAt: new Date(at.getTime() + leaseMilliseconds) }
  });
  return renewed.count === 1;
}

async function claimSupportJobLease(
  workspaceId: string,
  jobKey: string,
  bucketKey: string,
  workerId: string,
  now: Date,
  leaseMilliseconds: number,
  maxAttempts: number
): Promise<SupportJobLease | null> {
  return prisma.$transaction(async (tx) => {
    // A worker that dies during its last permitted attempt cannot report failure. Convert that
    // expired fenced attempt to a visible dead letter rather than leaving RUNNING forever.
    await tx.supportJobLease.updateMany({
      where: {
        workspaceId,
        jobKey,
        bucketKey,
        status: 'RUNNING',
        attemptCount: { gte: maxAttempts },
        leaseExpiresAt: { lte: now }
      },
      data: {
        status: 'DEAD_LETTER',
        leaseOwner: null,
        leaseExpiresAt: null,
        deadLetteredAt: now,
        lastErrorCode: 'SUPPORT_JOB_LEASE_EXPIRED',
        lastErrorMessage: 'The final worker attempt expired before reporting completion.'
      }
    });
    const updated = await tx.supportJobLease.updateMany({
      where: {
        workspaceId,
        jobKey,
        bucketKey,
        attemptCount: { lt: maxAttempts },
        nextAttemptAt: { lte: now },
        OR: [
          { status: { in: ['PENDING', 'RETRY_PENDING'] } },
          { status: 'RUNNING', leaseExpiresAt: { lte: now } }
        ]
      },
      data: {
        status: 'RUNNING',
        attemptCount: { increment: 1 },
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds),
        completedAt: null,
        deadLetteredAt: null,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });
    if (updated.count !== 1) return null;
    return tx.supportJobLease.findUniqueOrThrow({
      where: { jobKey_workspaceId_bucketKey: { jobKey, workspaceId, bucketKey } }
    });
  });
}

function validateSupportJobLeaseInput(
  input: { workspaceId: string; jobKey: string; bucketKey: string; workerId: string },
  options: { maxAttempts: number; leaseMilliseconds: number; baseRetryMilliseconds: number }
): void {
  for (const [name, value] of Object.entries({
    workspaceId: input.workspaceId,
    jobKey: input.jobKey,
    bucketKey: input.bucketKey,
    workerId: input.workerId
  })) {
    if (!value.trim()) throw new Error(`Support job ${name} cannot be empty`);
  }
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error('Support job maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(options.leaseMilliseconds) || options.leaseMilliseconds <= 0) {
    throw new Error('Support job leaseMilliseconds must be positive');
  }
  if (!Number.isFinite(options.baseRetryMilliseconds) || options.baseRetryMilliseconds < 0) {
    throw new Error('Support job baseRetryMilliseconds cannot be negative');
  }
}

function boundedWorkerBatchSize(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error('Support recovery worker batch sizes must be positive integers');
  }
  return Math.min(resolved, 1_000);
}

function jsonString(value: Prisma.JsonValue | null, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : null;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code.slice(0, 120);
  return 'SUPPORT_JOB_FAILED';
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
