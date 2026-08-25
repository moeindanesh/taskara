import {
  prisma,
  type Prisma,
  type SupportCase,
  type SupportCaseResolutionCode,
  type SupportCaseSlaClock,
  type SupportCaseStatus,
  type SupportInteractionDirection,
  type SupportInteractionVisibility,
  type SupportSlaClockState,
  type SupportSlaMetric,
  type SupportSlaPolicy
} from '@taskara/db';
import { z } from 'zod';
import {
  addSupportBusinessSeconds,
  snapshotSupportBusinessCalendar,
  supportBusinessSecondsBetween,
  type SupportBusinessCalendarInput,
  type SupportBusinessCalendarSnapshot
} from './support-business-time';

export const supportSlaMetricsInEvaluationOrder = [
  'TRIAGE',
  'FIRST_RESPONSE',
  'NEXT_RESPONSE',
  'RESOLUTION',
  'FOLLOW_UP',
  'MEMBER_ASSIGNMENT'
] as const satisfies readonly SupportSlaMetric[];

export const supportClockEvents = [
  'CASE_CREATED',
  'ROUTED',
  'ASSIGNED',
  'UNASSIGNED',
  'DEPARTMENT_ASSIGNED',
  'MEMBER_ASSIGNED',
  'HUMAN_PUBLIC_RESPONSE',
  'AUTOMATED_PUBLIC_RESPONSE',
  'PUBLIC_HUMAN_RESPONSE',
  'PUBLIC_AUTOMATED_RESPONSE',
  'INTERNAL_NOTE',
  'CUSTOMER_ACTIVITY',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
  'TRANSFERRED',
  'WAITING_ON_CUSTOMER',
  'WAITING_ON_INTERNAL',
  'SNOOZED',
  'RESUMED',
  'FOLLOW_UP_REQUESTED'
] as const;

export type SupportClockEvent = (typeof supportClockEvents)[number];

const metricTargetSchema = z.object({
  businessSeconds: z.number().int().positive(),
  atRiskSeconds: z.number().int().nonnegative().optional()
}).strict();

export const supportSlaTargetsSchema = z.object({
  TRIAGE: metricTargetSchema.optional(),
  FIRST_RESPONSE: metricTargetSchema.optional(),
  NEXT_RESPONSE: metricTargetSchema.optional(),
  RESOLUTION: metricTargetSchema.optional(),
  FOLLOW_UP: metricTargetSchema.optional(),
  MEMBER_ASSIGNMENT: metricTargetSchema.optional()
}).strict();

export const supportSlaPauseRulesSchema = z.object({
  waitingOnCustomer: z.array(z.enum(supportSlaMetricsInEvaluationOrder)).default([]),
  waitingOnInternal: z.array(z.enum(supportSlaMetricsInEvaluationOrder)).default([]),
  snoozed: z.array(z.enum(supportSlaMetricsInEvaluationOrder)).default([]),
  automatedPublicResponseMeets: z.array(z.enum(['FIRST_RESPONSE', 'NEXT_RESPONSE'])).default([])
}).strict();

const supportBusinessCalendarSnapshotSchema = z.object({
  timezone: z.string().min(1),
  periods: z.array(z.object({
    dayOfWeek: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440)
  }).strict()),
  holidays: z.array(z.object({
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    working: z.boolean()
  }).strict())
}).strict();

/**
 * `pauseRulesSnapshot` predates complete calendar freezing. New rows store this versioned envelope
 * in that JSON column; legacy rows containing only pause rules remain readable with an explicit
 * fallback calendar. No active clock ever consults a mutable calendar after it has this envelope.
 */
const supportSlaClockConfigSchema = z.object({
  snapshotVersion: z.literal(1),
  pauseRules: supportSlaPauseRulesSchema,
  calendar: supportBusinessCalendarSnapshotSchema,
  atRiskSeconds: z.number().int().nonnegative().nullable()
}).strict();

export const supportSlaConditionsSchema = z.object({
  caseTypes: z.array(z.string().min(1)).optional(),
  priorities: z.array(z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])).optional(),
  sourceChannels: z.array(z.enum(['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING'])).optional(),
  departmentIds: z.array(z.string().uuid()).optional(),
  impact: z.array(z.enum(['LOW', 'MEDIUM', 'HIGH'])).optional(),
  urgency: z.array(z.enum(['LOW', 'MEDIUM', 'HIGH'])).optional()
}).strict();

export type SupportSlaTargets = z.infer<typeof supportSlaTargetsSchema>;
export type SupportSlaPauseRules = z.infer<typeof supportSlaPauseRulesSchema>;
export type SupportSlaConditions = z.infer<typeof supportSlaConditionsSchema>;

export interface SupportSlaCaseFacts {
  id: string;
  workspaceId: string;
  typeKey: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  sourceChannel: 'API' | 'CALL' | 'MANUAL' | 'EMAIL' | 'MESSAGING';
  departmentId: string | null;
  impact: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | null;
}

export interface SupportSlaPolicyDefinition {
  id: string;
  workspaceId: string;
  calendarId: string;
  policyKey: string;
  version: number;
  priority: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  conditions: SupportSlaConditions;
  targets: SupportSlaTargets;
  pauseRules: SupportSlaPauseRules;
}

export interface SupportSlaClockSnapshot {
  id: string;
  workspaceId: string;
  caseId: string;
  policyId: string;
  calendarId: string;
  metric: SupportSlaMetric;
  cycle: number;
  policyVersion: number;
  targetBusinessSeconds: number;
  atRiskSeconds: number | null;
  pauseRules: SupportSlaPauseRules;
  calendar: SupportBusinessCalendarSnapshot;
  state: SupportSlaClockState;
  startedAt: Date;
  dueAt: Date;
  pausedAt: Date | null;
  metAt: Date | null;
  breachedAt: Date | null;
  canceledAt: Date | null;
  accumulatedPausedSeconds: bigint;
}

export interface StartSupportSlaCycleInput {
  workspaceId: string;
  caseId: string;
  policy: SupportSlaPolicyDefinition;
  calendar: SupportBusinessCalendarInput;
  metric: SupportSlaMetric;
  startedAt: Date;
  cycle: number;
}

export interface SupportInteractionQualification {
  visibility: SupportInteractionVisibility;
  direction: SupportInteractionDirection;
  humanAuthored: boolean;
  automated: boolean;
}

export interface ApplySupportSlaCaseEventInput {
  workspaceId: string;
  caseId: string;
  event: SupportClockEvent;
  at: Date;
  interaction?: SupportInteractionQualification;
  /** Optional deterministic cycle supplied by an intake/event ledger replay. */
  cycle?: number;
}

export interface ApplySupportSlaCaseEventResult {
  clocks: SupportCaseSlaClock[];
  startedClockIds: string[];
  transitionedClockIds: string[];
  nextSlaDueAt: Date | null;
}

export function parseSupportSlaPolicy(policy: Pick<SupportSlaPolicy,
  'id' | 'workspaceId' | 'calendarId' | 'policyKey' | 'version' | 'priority' |
  'effectiveFrom' | 'effectiveUntil' | 'conditions' | 'targets' | 'pauseRules'
>): SupportSlaPolicyDefinition {
  return {
    id: policy.id,
    workspaceId: policy.workspaceId,
    calendarId: policy.calendarId,
    policyKey: policy.policyKey,
    version: policy.version,
    priority: policy.priority,
    effectiveFrom: policy.effectiveFrom,
    effectiveUntil: policy.effectiveUntil,
    conditions: supportSlaConditionsSchema.parse(policy.conditions),
    targets: supportSlaTargetsSchema.parse(policy.targets),
    pauseRules: supportSlaPauseRulesSchema.parse(policy.pauseRules)
  };
}

export function selectSupportSlaPolicy(
  policies: readonly SupportSlaPolicyDefinition[],
  supportCase: SupportSlaCaseFacts,
  at: Date
): SupportSlaPolicyDefinition | null {
  return [...policies]
    .filter((policy) =>
      policy.workspaceId === supportCase.workspaceId &&
      policy.effectiveFrom.getTime() <= at.getTime() &&
      (policy.effectiveUntil === null || policy.effectiveUntil.getTime() > at.getTime()) &&
      supportSlaConditionsMatch(policy.conditions, supportCase)
    )
    .sort((left, right) =>
      left.priority - right.priority ||
      right.version - left.version ||
      right.effectiveFrom.getTime() - left.effectiveFrom.getTime()
    )[0] ?? null;
}

export function supportSlaConditionsMatch(
  conditions: SupportSlaConditions,
  supportCase: SupportSlaCaseFacts
): boolean {
  return matchesOptional(conditions.caseTypes, supportCase.typeKey) &&
    matchesOptional(conditions.priorities, supportCase.priority) &&
    matchesOptional(conditions.sourceChannels, supportCase.sourceChannel) &&
    matchesOptional(conditions.departmentIds, supportCase.departmentId) &&
    matchesOptional(conditions.impact, supportCase.impact) &&
    matchesOptional(conditions.urgency, supportCase.urgency);
}

export function buildSupportSlaClock(input: StartSupportSlaCycleInput): Omit<SupportSlaClockSnapshot, 'id'> {
  const target = input.policy.targets[input.metric];
  if (!target) throw new Error(`Policy ${input.policy.policyKey}@${input.policy.version} has no ${input.metric} target`);
  if (input.policy.workspaceId !== input.workspaceId) throw new Error('SLA policy belongs to another Workspace');
  if (input.policy.calendarId === '') throw new Error('SLA policy has no business calendar');
  const calendar = snapshotSupportBusinessCalendar(input.calendar);
  return {
    workspaceId: input.workspaceId,
    caseId: input.caseId,
    policyId: input.policy.id,
    calendarId: input.policy.calendarId,
    metric: input.metric,
    cycle: input.cycle,
    policyVersion: input.policy.version,
    targetBusinessSeconds: target.businessSeconds,
    atRiskSeconds: target.atRiskSeconds ?? null,
    pauseRules: clonePauseRules(input.policy.pauseRules),
    calendar,
    state: 'RUNNING',
    startedAt: new Date(input.startedAt),
    dueAt: addSupportBusinessSeconds(calendar, input.startedAt, target.businessSeconds),
    pausedAt: null,
    metAt: null,
    breachedAt: null,
    canceledAt: null,
    accumulatedPausedSeconds: 0n
  };
}

export function pauseSupportSlaClock(
  clock: SupportSlaClockSnapshot,
  event: Extract<SupportClockEvent, 'WAITING_ON_CUSTOMER' | 'WAITING_ON_INTERNAL' | 'SNOOZED'>,
  at: Date
): SupportSlaClockSnapshot {
  if (clock.state !== 'RUNNING') return cloneClock(clock);
  if (at.getTime() < clock.startedAt.getTime()) return cloneClock(clock);
  if (at.getTime() > clock.dueAt.getTime()) return breachSupportSlaClock(clock, at);
  if (!supportSlaEventPauses(clock.pauseRules, clock.metric, event)) return cloneClock(clock);
  return { ...cloneClock(clock), state: 'PAUSED', pausedAt: new Date(at) };
}

export function resumeSupportSlaClock(
  clock: SupportSlaClockSnapshot,
  at: Date
): SupportSlaClockSnapshot {
  if (clock.state !== 'PAUSED' || !clock.pausedAt) return cloneClock(clock);
  if (at.getTime() < clock.pausedAt.getTime()) throw new Error('SLA clock cannot resume before it was paused');
  const pausedBusinessSeconds = supportBusinessSecondsBetween(clock.calendar, clock.pausedAt, at);
  return {
    ...cloneClock(clock),
    state: 'RUNNING',
    pausedAt: null,
    dueAt: addSupportBusinessSeconds(clock.calendar, clock.dueAt, pausedBusinessSeconds),
    accumulatedPausedSeconds: clock.accumulatedPausedSeconds + BigInt(pausedBusinessSeconds)
  };
}

export function meetSupportSlaClock(clock: SupportSlaClockSnapshot, at: Date): SupportSlaClockSnapshot {
  // A late response does not erase a breach. Keep BREACHED as the attainment result and record
  // `metAt` so recovery can stop paging while reports still count the missed commitment.
  if (clock.state === 'BREACHED') return { ...cloneClock(clock), metAt: clock.metAt ?? new Date(at) };
  if (clock.state === 'MET' || clock.state === 'CANCELED') return cloneClock(clock);
  if (at.getTime() < clock.startedAt.getTime()) return cloneClock(clock);
  if (clock.state === 'PAUSED') return meetSupportSlaClock(resumeSupportSlaClock(clock, at), at);
  if (at.getTime() > clock.dueAt.getTime()) {
    return {
      ...cloneClock(clock),
      state: 'BREACHED',
      metAt: new Date(at),
      breachedAt: clock.breachedAt ?? new Date(clock.dueAt),
      pausedAt: null
    };
  }
  return { ...cloneClock(clock), state: 'MET', metAt: new Date(at), pausedAt: null };
}

export function breachSupportSlaClock(clock: SupportSlaClockSnapshot, at: Date): SupportSlaClockSnapshot {
  if (clock.state !== 'RUNNING' || at.getTime() <= clock.dueAt.getTime()) return cloneClock(clock);
  return { ...cloneClock(clock), state: 'BREACHED', breachedAt: new Date(clock.dueAt), pausedAt: null };
}

export function cancelSupportSlaClock(clock: SupportSlaClockSnapshot, at: Date): SupportSlaClockSnapshot {
  if (clock.state === 'BREACHED') return { ...cloneClock(clock), canceledAt: clock.canceledAt ?? new Date(at), pausedAt: null };
  if (clock.state === 'MET' || clock.state === 'CANCELED') return cloneClock(clock);
  return { ...cloneClock(clock), state: 'CANCELED', canceledAt: new Date(at), pausedAt: null };
}

export function supportInteractionMeetsResponseClock(
  interaction: SupportInteractionQualification,
  _metric: Extract<SupportSlaMetric, 'FIRST_RESPONSE' | 'NEXT_RESPONSE'>,
  _pauseRules?: SupportSlaPauseRules
): boolean {
  return isQualifyingHumanPublicInteraction(interaction);
}

export function applySupportSlaEvent(
  clock: SupportSlaClockSnapshot,
  event: SupportClockEvent,
  at: Date,
  options: {
    interaction?: SupportInteractionQualification;
  } = {}
): SupportSlaClockSnapshot {
  const canonicalEvent = canonicalClockEvent(event);
  if (canonicalEvent === 'TRANSFERRED') {
    return clock.metric === 'MEMBER_ASSIGNMENT' ? cancelSupportSlaClock(clock, at) : cloneClock(clock);
  }
  if (canonicalEvent === 'WAITING_ON_CUSTOMER' || canonicalEvent === 'WAITING_ON_INTERNAL' || canonicalEvent === 'SNOOZED') {
    return pauseSupportSlaClock(clock, canonicalEvent, at);
  }
  if (
    ((canonicalEvent === 'REOPENED' &&
      (clock.metric === 'FOLLOW_UP' || clock.metric === 'NEXT_RESPONSE' || clock.metric === 'RESOLUTION')) ||
    (canonicalEvent === 'CUSTOMER_ACTIVITY' && clock.metric === 'NEXT_RESPONSE')) &&
    clock.startedAt.getTime() < at.getTime() &&
    isOutstandingSupportSlaClock(clock)
  ) return cancelSupportSlaClock(clock, at);
  if (
    canonicalEvent === 'FOLLOW_UP_REQUESTED' &&
    clock.metric === 'FOLLOW_UP' &&
    clock.startedAt.getTime() < at.getTime() &&
    isOutstandingSupportSlaClock(clock)
  ) {
    return cancelSupportSlaClock(clock, at);
  }
  if (canonicalEvent === 'RESUMED' || canonicalEvent === 'CUSTOMER_ACTIVITY' || canonicalEvent === 'REOPENED') {
    return clock.state === 'PAUSED' ? resumeSupportSlaClock(clock, at) : cloneClock(clock);
  }
  if (canonicalEvent === 'CLOSED') return cancelSupportSlaClock(clock, at);
  if (
    (clock.metric === 'TRIAGE' && canonicalEvent === 'ROUTED') ||
    (clock.metric === 'MEMBER_ASSIGNMENT' && canonicalEvent === 'ASSIGNED') ||
    (clock.metric === 'RESOLUTION' && canonicalEvent === 'RESOLVED')
  ) return meetSupportSlaClock(clock, at);
  if (
    (clock.metric === 'FIRST_RESPONSE' || clock.metric === 'NEXT_RESPONSE' || clock.metric === 'FOLLOW_UP') &&
    (canonicalEvent === 'HUMAN_PUBLIC_RESPONSE' || canonicalEvent === 'AUTOMATED_PUBLIC_RESPONSE') &&
    options.interaction && isQualifyingHumanPublicInteraction(options.interaction)
  ) return meetSupportSlaClock(clock, at);
  return cloneClock(clock);
}

export function nextSupportSlaCycle(
  clocks: readonly Pick<SupportSlaClockSnapshot, 'metric' | 'cycle'>[],
  metric: SupportSlaMetric
): number {
  return Math.max(0, ...clocks.filter((clock) => clock.metric === metric).map((clock) => clock.cycle)) + 1;
}

/** Metrics whose next frozen cycle may begin after the named aggregate event. */
export function supportSlaMetricsForEvent(
  event: Extract<SupportClockEvent, 'CASE_CREATED' | 'ROUTED' | 'ASSIGNED' | 'UNASSIGNED' | 'DEPARTMENT_ASSIGNED' | 'MEMBER_ASSIGNED' | 'TRANSFERRED' | 'CUSTOMER_ACTIVITY' | 'RESOLVED' | 'REOPENED' | 'FOLLOW_UP_REQUESTED'>
): SupportSlaMetric[] {
  if (event === 'CASE_CREATED') return ['TRIAGE', 'FIRST_RESPONSE', 'RESOLUTION'];
  if (event === 'CUSTOMER_ACTIVITY') return ['NEXT_RESPONSE'];
  if (event === 'REOPENED') return ['NEXT_RESPONSE', 'RESOLUTION'];
  if (event === 'ROUTED' || event === 'UNASSIGNED' || event === 'DEPARTMENT_ASSIGNED' || event === 'TRANSFERRED') return ['MEMBER_ASSIGNMENT'];
  if (event === 'RESOLVED' || event === 'FOLLOW_UP_REQUESTED') return ['FOLLOW_UP'];
  return [];
}

export function supportCaseNextSlaDueAt(
  clocks: readonly Pick<SupportSlaClockSnapshot, 'state' | 'dueAt' | 'metAt' | 'canceledAt'>[]
): Date | null {
  const actionable = clocks.filter((clock) =>
    clock.state === 'RUNNING' ||
    (clock.state === 'BREACHED' && !clock.metAt && !clock.canceledAt)
  ).sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  return actionable[0] ? new Date(actionable[0].dueAt) : null;
}

export async function loadApplicableSupportSlaPolicy(
  supportCase: SupportSlaCaseFacts,
  at: Date,
  tx: Pick<Prisma.TransactionClient, 'supportSlaPolicy'> = prisma
): Promise<SupportSlaPolicyDefinition | null> {
  const rows = await tx.supportSlaPolicy.findMany({
    where: {
      workspaceId: supportCase.workspaceId,
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }]
    },
    orderBy: [{ priority: 'asc' }, { version: 'desc' }, { effectiveFrom: 'desc' }]
  });
  return selectSupportSlaPolicy(rows.map(parseSupportSlaPolicy), supportCase, at);
}

export async function loadSupportBusinessCalendar(
  workspaceId: string,
  calendarId: string,
  tx: Pick<Prisma.TransactionClient, 'supportBusinessCalendar'> = prisma
): Promise<SupportBusinessCalendarSnapshot> {
  const row = await tx.supportBusinessCalendar.findFirstOrThrow({
    where: { workspaceId, id: calendarId, active: true },
    include: { periods: true, holidays: true }
  });
  return snapshotSupportBusinessCalendar(row);
}

/**
 * Transaction-aware and idempotent: a repeated command for one Case/metric/cycle returns the
 * frozen existing clock rather than re-reading a newly edited policy or consuming another cycle.
 */
export async function startSupportSlaClock(
  input: Omit<StartSupportSlaCycleInput, 'policy' | 'calendar'> & {
    policy: SupportSlaPolicyDefinition;
    calendar: SupportBusinessCalendarInput;
  },
  tx: Pick<Prisma.TransactionClient, 'supportCaseSlaClock' | 'supportCase'> = prisma,
  options: { refreshCaseDueAt?: boolean } = {}
): Promise<SupportCaseSlaClock> {
  const built = buildSupportSlaClock(input);
  const pauseRulesSnapshot = supportSlaClockConfigJson(built);
  await tx.supportCaseSlaClock.createMany({
    data: {
      workspaceId: built.workspaceId,
      caseId: built.caseId,
      policyId: built.policyId,
      calendarId: built.calendarId,
      metric: built.metric,
      cycle: built.cycle,
      policyVersion: built.policyVersion,
      targetBusinessSeconds: built.targetBusinessSeconds,
      pauseRulesSnapshot,
      state: built.state,
      startedAt: built.startedAt,
      dueAt: built.dueAt,
      accumulatedPausedSeconds: built.accumulatedPausedSeconds
    },
    skipDuplicates: true
  });
  const created = await tx.supportCaseSlaClock.findUniqueOrThrow({
    where: { caseId_metric_cycle: { caseId: input.caseId, metric: input.metric, cycle: input.cycle } }
  });
  if (options.refreshCaseDueAt !== false) {
    await refreshSupportCaseNextSlaDueAt(input.workspaceId, input.caseId, tx);
  }
  return created;
}

export async function transitionSupportSlaClock(
  clockId: string,
  event: SupportClockEvent,
  at: Date,
  options: { legacyCalendar?: SupportBusinessCalendarInput; interaction?: SupportInteractionQualification } = {},
  tx: Pick<Prisma.TransactionClient, 'supportCaseSlaClock' | 'supportCase' | 'supportBusinessCalendar'> = prisma
): Promise<SupportCaseSlaClock> {
  const current = await tx.supportCaseSlaClock.findUniqueOrThrow({ where: { id: clockId } });
  const fallbackCalendar = options.legacyCalendar ??
    (hasFrozenSupportSlaClockConfig(current.pauseRulesSnapshot)
      ? undefined
      : await loadSupportBusinessCalendar(current.workspaceId, current.calendarId, tx));
  const transitioned = applySupportSlaEvent(clockFromRow(current, fallbackCalendar), event, at, {
    interaction: options.interaction
  });
  const updated = clocksEqual(current, transitioned)
    ? current
    : await tx.supportCaseSlaClock.update({ where: { id: clockId }, data: clockUpdate(transitioned) });
  await refreshSupportCaseNextSlaDueAt(current.workspaceId, current.caseId, tx);
  return updated;
}

export async function refreshSupportCaseNextSlaDueAt(
  workspaceId: string,
  caseId: string,
  tx: Pick<Prisma.TransactionClient, 'supportCaseSlaClock' | 'supportCase'> = prisma
): Promise<Date | null> {
  const earliest = await tx.supportCaseSlaClock.findFirst({
    where: {
      workspaceId,
      caseId,
      OR: [
        { state: 'RUNNING' },
        { state: 'BREACHED', metAt: null, canceledAt: null }
      ]
    },
    orderBy: { dueAt: 'asc' },
    select: { dueAt: true }
  });
  await tx.supportCase.updateMany({
    where: { workspaceId, id: caseId },
    data: { nextSlaDueAt: earliest?.dueAt ?? null }
  });
  return earliest?.dueAt ?? null;
}

export function clockFromRow(
  clock: SupportCaseSlaClock,
  legacyCalendar?: SupportBusinessCalendarInput
): SupportSlaClockSnapshot {
  const config = parseSupportSlaClockConfig(clock.pauseRulesSnapshot, legacyCalendar);
  return {
    id: clock.id,
    workspaceId: clock.workspaceId,
    caseId: clock.caseId,
    policyId: clock.policyId,
    calendarId: clock.calendarId,
    metric: clock.metric,
    cycle: clock.cycle,
    policyVersion: clock.policyVersion,
    targetBusinessSeconds: clock.targetBusinessSeconds,
    atRiskSeconds: config.atRiskSeconds,
    pauseRules: config.pauseRules,
    calendar: config.calendar,
    state: clock.state,
    startedAt: clock.startedAt,
    dueAt: clock.dueAt,
    pausedAt: clock.pausedAt,
    metAt: clock.metAt,
    breachedAt: clock.breachedAt,
    canceledAt: clock.canceledAt,
    accumulatedPausedSeconds: clock.accumulatedPausedSeconds
  };
}

/**
 * Applies one Case command to all clocks inside the caller's existing transaction. The Case command
 * must already hold the Case row lock; this helper deliberately never opens a nested transaction.
 * New cycles select the policy effective at the event instant and freeze both its rules and its
 * complete calendar snapshot.
 */
export async function applySupportSlaCaseEvent(
  tx: Prisma.TransactionClient,
  input: ApplySupportSlaCaseEventInput
): Promise<ApplySupportSlaCaseEventResult> {
  assertValidEventInstant(input.at);
  if (input.cycle !== undefined && (!Number.isInteger(input.cycle) || input.cycle < 1)) {
    throw new Error('SLA cycle must be a positive integer');
  }
  const canonicalInputEvent = canonicalClockEvent(input.event);
  if (canonicalInputEvent === 'HUMAN_PUBLIC_RESPONSE' && !input.interaction) {
    throw new Error('A human public-response SLA event requires explicit interaction qualification');
  }
  const supportCase = await tx.supportCase.findFirstOrThrow({
    where: { id: input.caseId, workspaceId: input.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      typeKey: true,
      priority: true,
      sourceChannel: true,
      departmentId: true,
      assigneeMembershipId: true,
      impact: true,
      urgency: true,
      reopenCount: true
    }
  });
  let rows = await tx.supportCaseSlaClock.findMany({
    where: { workspaceId: input.workspaceId, caseId: input.caseId },
    orderBy: [{ metric: 'asc' }, { cycle: 'asc' }]
  });
  const clockIdsPresentAtStart = new Set(rows.map((row) => row.id));
  const calendarCache = new Map<string, SupportBusinessCalendarSnapshot>();
  const snapshots: SupportSlaClockSnapshot[] = [];
  for (const row of rows) {
    let fallback: SupportBusinessCalendarSnapshot | undefined;
    if (!hasFrozenSupportSlaClockConfig(row.pauseRulesSnapshot)) {
      fallback = calendarCache.get(row.calendarId);
      if (!fallback) {
        fallback = await loadSupportBusinessCalendar(input.workspaceId, row.calendarId, tx);
        calendarCache.set(row.calendarId, fallback);
      }
    }
    snapshots.push(clockFromRow(row, fallback));
  }

  const transitionedClockIds: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const transitioned = applySupportSlaEvent(snapshots[index], input.event, input.at, {
      interaction: input.interaction
    });
    if (clocksEqual(current, transitioned)) continue;
    rows[index] = await tx.supportCaseSlaClock.update({
      where: { id: current.id },
      data: clockUpdate(transitioned)
    });
    snapshots[index] = transitioned;
    transitionedClockIds.push(current.id);
  }

  const canonicalEvent = canonicalInputEvent;
  const metrics = metricsToStartForCaseEvent(canonicalEvent, supportCase.departmentId !== null);
  const policy = metrics.length
    ? await loadApplicableSupportSlaPolicy(supportCaseFactsFromRow(supportCase), input.at, tx)
    : null;
  const startedClockIds: string[] = [];
  if (policy) {
    let calendar = calendarCache.get(policy.calendarId);
    if (!calendar) {
      calendar = await loadSupportBusinessCalendar(input.workspaceId, policy.calendarId, tx);
      calendarCache.set(policy.calendarId, calendar);
    }
    for (const metric of metrics) {
      if (!policy.targets[metric]) continue;
      if (snapshots.some((clock) => clock.metric === metric && clock.startedAt.getTime() === input.at.getTime())) {
        continue;
      }
      const cycle = input.cycle ?? deterministicCycleForEvent(
        canonicalEvent,
        metric,
        supportCase.reopenCount,
        snapshots
      );
      const row = await startSupportSlaClock({
        workspaceId: input.workspaceId,
        caseId: input.caseId,
        policy,
        calendar,
        metric,
        cycle,
        startedAt: input.at
      }, tx, { refreshCaseDueAt: false });
      let snapshot = clockFromRow(row);
      const shouldMeetImmediately =
        (metric === 'TRIAGE' && canonicalEvent === 'CASE_CREATED' && supportCase.departmentId !== null) ||
        (metric === 'MEMBER_ASSIGNMENT' && supportCase.assigneeMembershipId !== null);
      if (shouldMeetImmediately && isOutstandingSupportSlaClock(snapshot)) {
        snapshot = meetSupportSlaClock(snapshot, input.at);
        const met = await tx.supportCaseSlaClock.update({ where: { id: row.id }, data: clockUpdate(snapshot) });
        const rowIndex = rows.findIndex((candidate) => candidate.id === row.id);
        if (rowIndex >= 0) rows[rowIndex] = met;
        else rows.push(met);
        transitionedClockIds.push(row.id);
      } else {
        const rowIndex = rows.findIndex((candidate) => candidate.id === row.id);
        if (rowIndex >= 0) rows[rowIndex] = row;
        else rows.push(row);
      }
      const snapshotIndex = snapshots.findIndex((candidate) => candidate.id === row.id);
      if (snapshotIndex >= 0) snapshots[snapshotIndex] = snapshot;
      else snapshots.push(snapshot);
      if (!clockIdsPresentAtStart.has(row.id) && !startedClockIds.includes(row.id)) startedClockIds.push(row.id);
    }
  }

  const nextSlaDueAt = await refreshSupportCaseNextSlaDueAt(input.workspaceId, input.caseId, tx);
  return {
    clocks: await tx.supportCaseSlaClock.findMany({
      where: { workspaceId: input.workspaceId, caseId: input.caseId },
      orderBy: [{ metric: 'asc' }, { cycle: 'asc' }]
    }),
    startedClockIds,
    transitionedClockIds: [...new Set(transitionedClockIds)],
    nextSlaDueAt
  };
}

export function supportCaseFactsFromRow(supportCase: Pick<SupportCase,
  'id' | 'workspaceId' | 'typeKey' | 'priority' | 'sourceChannel' | 'departmentId' | 'impact' | 'urgency'
>): SupportSlaCaseFacts {
  return { ...supportCase };
}

export function isNonFixedResolution(code: SupportCaseResolutionCode | null): boolean {
  return code === 'WORKAROUND' || code === 'NOT_REPRODUCIBLE' || code === 'NO_RESPONSE';
}

export function isNonClosedSupportStatus(status: SupportCaseStatus): boolean {
  return status !== 'CLOSED';
}

function supportSlaEventPauses(
  rules: SupportSlaPauseRules,
  metric: SupportSlaMetric,
  event: Extract<SupportClockEvent, 'WAITING_ON_CUSTOMER' | 'WAITING_ON_INTERNAL' | 'SNOOZED'>
): boolean {
  const metrics = event === 'WAITING_ON_CUSTOMER'
    ? rules.waitingOnCustomer
    : event === 'WAITING_ON_INTERNAL'
      ? rules.waitingOnInternal
      : rules.snoozed;
  return metrics.includes(metric);
}

function matchesOptional<T>(allowed: readonly T[] | undefined, actual: T | null): boolean {
  return !allowed || (actual !== null && allowed.includes(actual));
}

function clonePauseRules(rules: SupportSlaPauseRules): SupportSlaPauseRules {
  return {
    waitingOnCustomer: [...rules.waitingOnCustomer],
    waitingOnInternal: [...rules.waitingOnInternal],
    snoozed: [...rules.snoozed],
    automatedPublicResponseMeets: [...rules.automatedPublicResponseMeets]
  };
}

function cloneClock(clock: SupportSlaClockSnapshot): SupportSlaClockSnapshot {
  return {
    ...clock,
    pauseRules: clonePauseRules(clock.pauseRules),
    calendar: snapshotSupportBusinessCalendar(clock.calendar),
    startedAt: new Date(clock.startedAt),
    dueAt: new Date(clock.dueAt),
    pausedAt: clock.pausedAt ? new Date(clock.pausedAt) : null,
    metAt: clock.metAt ? new Date(clock.metAt) : null,
    breachedAt: clock.breachedAt ? new Date(clock.breachedAt) : null,
    canceledAt: clock.canceledAt ? new Date(clock.canceledAt) : null
  };
}

function clocksEqual(left: SupportCaseSlaClock, right: SupportSlaClockSnapshot): boolean {
  return left.state === right.state &&
    left.dueAt.getTime() === right.dueAt.getTime() &&
    left.pausedAt?.getTime() === right.pausedAt?.getTime() &&
    left.metAt?.getTime() === right.metAt?.getTime() &&
    left.breachedAt?.getTime() === right.breachedAt?.getTime() &&
    left.canceledAt?.getTime() === right.canceledAt?.getTime() &&
    left.accumulatedPausedSeconds === right.accumulatedPausedSeconds;
}

function clockUpdate(clock: SupportSlaClockSnapshot): Prisma.SupportCaseSlaClockUpdateInput {
  return {
    state: clock.state,
    dueAt: clock.dueAt,
    pausedAt: clock.pausedAt,
    metAt: clock.metAt,
    breachedAt: clock.breachedAt,
    canceledAt: clock.canceledAt,
    accumulatedPausedSeconds: clock.accumulatedPausedSeconds
  };
}

function isQualifyingHumanPublicInteraction(interaction: SupportInteractionQualification): boolean {
  return interaction.visibility === 'PUBLIC' &&
    interaction.direction === 'OUTBOUND' &&
    interaction.humanAuthored &&
    !interaction.automated;
}

function canonicalClockEvent(event: SupportClockEvent): SupportClockEvent {
  if (event === 'DEPARTMENT_ASSIGNED') return 'ROUTED';
  if (event === 'MEMBER_ASSIGNED') return 'ASSIGNED';
  if (event === 'PUBLIC_HUMAN_RESPONSE') return 'HUMAN_PUBLIC_RESPONSE';
  if (event === 'PUBLIC_AUTOMATED_RESPONSE') return 'AUTOMATED_PUBLIC_RESPONSE';
  return event;
}

function metricsToStartForCaseEvent(
  event: SupportClockEvent,
  hasDepartment: boolean
): SupportSlaMetric[] {
  if (event === 'CASE_CREATED') {
    return hasDepartment
      ? ['TRIAGE', 'FIRST_RESPONSE', 'RESOLUTION', 'MEMBER_ASSIGNMENT']
      : ['TRIAGE', 'FIRST_RESPONSE', 'RESOLUTION'];
  }
  if (event === 'CUSTOMER_ACTIVITY') return ['NEXT_RESPONSE'];
  if (event === 'REOPENED') return ['NEXT_RESPONSE', 'RESOLUTION'];
  if (event === 'ROUTED' || event === 'UNASSIGNED' || event === 'TRANSFERRED') return ['MEMBER_ASSIGNMENT'];
  if (event === 'RESOLVED' || event === 'FOLLOW_UP_REQUESTED') return ['FOLLOW_UP'];
  return [];
}

function deterministicCycleForEvent(
  event: SupportClockEvent,
  metric: SupportSlaMetric,
  reopenCount: number,
  clocks: readonly SupportSlaClockSnapshot[]
): number {
  if (event === 'CASE_CREATED' && ['TRIAGE', 'FIRST_RESPONSE', 'RESOLUTION', 'MEMBER_ASSIGNMENT'].includes(metric)) {
    return 1;
  }
  if (event === 'REOPENED' && metric === 'RESOLUTION') {
    return reopenCount + 1;
  }
  if (event === 'RESOLVED' && metric === 'FOLLOW_UP') {
    return reopenCount + 1;
  }
  return nextSupportSlaCycle(clocks, metric);
}

export function isOutstandingSupportSlaClock(
  clock: Pick<SupportSlaClockSnapshot, 'state' | 'metAt' | 'canceledAt'>
): boolean {
  return (clock.state === 'RUNNING' || clock.state === 'PAUSED') ||
    (clock.state === 'BREACHED' && !clock.metAt && !clock.canceledAt);
}

function supportSlaClockConfigJson(
  clock: Pick<SupportSlaClockSnapshot, 'pauseRules' | 'calendar' | 'atRiskSeconds'>
): Prisma.InputJsonValue {
  return toJson({
    snapshotVersion: 1,
    pauseRules: clonePauseRules(clock.pauseRules),
    calendar: snapshotSupportBusinessCalendar(clock.calendar),
    atRiskSeconds: clock.atRiskSeconds
  });
}

export function hasFrozenSupportSlaClockConfig(value: Prisma.JsonValue): boolean {
  return supportSlaClockConfigSchema.safeParse(value).success;
}

function parseSupportSlaClockConfig(
  value: Prisma.JsonValue,
  legacyCalendar?: SupportBusinessCalendarInput
): {
  pauseRules: SupportSlaPauseRules;
  calendar: SupportBusinessCalendarSnapshot;
  atRiskSeconds: number | null;
} {
  const frozen = supportSlaClockConfigSchema.safeParse(value);
  if (frozen.success) {
    return {
      pauseRules: clonePauseRules(frozen.data.pauseRules),
      calendar: snapshotSupportBusinessCalendar({
        timezone: frozen.data.calendar.timezone,
        periods: frozen.data.calendar.periods,
        holidays: frozen.data.calendar.holidays.map((holiday) => ({
          date: holiday.dateKey,
          working: holiday.working
        }))
      }),
      atRiskSeconds: frozen.data.atRiskSeconds
    };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'snapshotVersion' in value) {
    throw frozen.error;
  }
  const pauseRules = supportSlaPauseRulesSchema.parse(value);
  if (!legacyCalendar) {
    throw new Error('Legacy Support SLA clock requires an explicit calendar snapshot');
  }
  return {
    pauseRules,
    calendar: snapshotSupportBusinessCalendar(legacyCalendar),
    atRiskSeconds: null
  };
}

function assertValidEventInstant(at: Date): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error('SLA event time must be a valid Date');
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
