import { createHmac, randomBytes } from 'node:crypto';
import { Prisma, prisma, type SupportSlaMetric } from '@taskara/db';
import { config } from '../config';
import type { RequestActor } from './actor';
import { snapshotSupportBusinessCalendar } from './support-business-time';
import {
  assertCanConfigureSupport,
  assertCanWorkCase,
  canReadSupportCase,
  departmentWhereForAccess,
  resolveSupportAccess,
  supportCaseWhereForAccess
} from './support-access';
import {
  appendSupportCaseEvent,
  serializeSupportCase,
  supportAttentionCaseWhere,
  supportCaseInclude,
  supportNeedsAttentionWhere,
  supportQueueCounts
} from './support-cases';
import { HttpError } from './http';
import {
  applySupportSlaCaseEvent,
  supportSlaConditionsSchema,
  supportSlaPauseRulesSchema,
  supportSlaTargetsSchema
} from './support-sla';
import { appendSupportCaseSyncEvent } from './support-sync';
import { publishSyncEvent } from './sync';
import { assertSupportWorkspace } from './workspace-mode';

export interface SupportCalendarPeriodInput {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface SupportCalendarHolidayInput {
  date: string;
  name: string;
  working: boolean;
}

export interface CreateSupportCalendarInput {
  name: string;
  timezone: string;
  departmentId?: string | null;
  periods: SupportCalendarPeriodInput[];
  holidays: SupportCalendarHolidayInput[];
}

export interface UpdateSupportCalendarInput {
  name?: string;
  timezone?: string;
  departmentId?: string | null;
  active?: boolean;
  periods?: SupportCalendarPeriodInput[];
  holidays?: SupportCalendarHolidayInput[];
}

export interface CreateSupportSlaPolicyInput {
  calendarId: string;
  policyKey: string;
  name: string;
  priority: number;
  conditions: unknown;
  targets: unknown;
  pauseRules: unknown;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
}

const calendarInclude = {
  department: { select: { id: true, name: true, slug: true } },
  periods: { orderBy: [{ dayOfWeek: 'asc' as const }, { startMinute: 'asc' as const }, { endMinute: 'asc' as const }] },
  holidays: { orderBy: { date: 'asc' as const } }
} satisfies Prisma.SupportBusinessCalendarInclude;

// The fallback is process-local so an installation without connector encryption configured still
// avoids a dictionary-recoverable digest in audit rows. Cross-restart correlation is deliberately
// unavailable until the deployment supplies its Support data secret.
const contactSearchAuditKey = config.TASKARA_SUPPORT_DATA_SECRET ?? randomBytes(32).toString('base64url');

export async function listSupportCalendars(actor: RequestActor) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const calendars = await prisma.supportBusinessCalendar.findMany({
    where: { workspaceId: actor.workspace.id },
    orderBy: [{ active: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    include: calendarInclude
  });
  return calendars.map(serializeCalendar);
}

export async function createSupportCalendar(actor: RequestActor, input: CreateSupportCalendarInput) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  await assertCalendarDepartment(actor.workspace.id, input.departmentId);
  validateCalendar(input.timezone, input.periods, input.holidays);
  try {
    const calendar = await prisma.$transaction(async (tx) => {
      const created = await tx.supportBusinessCalendar.create({
        data: {
          workspaceId: actor.workspace.id,
          name: input.name,
          timezone: input.timezone,
          departmentId: input.departmentId ?? null,
          periods: { create: input.periods },
          holidays: { create: input.holidays.map((holiday) => ({
            date: supportDate(holiday.date),
            name: holiday.name,
            working: holiday.working
          })) }
        },
        include: calendarInclude
      });
      await appendSupportConfigurationAudit(actor, 'support_calendar', created.id, 'created', {
        name: created.name,
        timezone: created.timezone,
        departmentId: created.departmentId
      }, tx);
      return created;
    });
    return serializeCalendar(calendar);
  } catch (error) {
    throw mapSupportConfigurationError(error, 'A Support calendar with this name already exists');
  }
}

export async function updateSupportCalendar(
  actor: RequestActor,
  calendarId: string,
  input: UpdateSupportCalendarInput
) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const current = await prisma.supportBusinessCalendar.findFirst({
    where: { id: calendarId, workspaceId: actor.workspace.id },
    include: calendarInclude
  });
  if (!current) throw new HttpError(404, 'Support business calendar not found');
  const departmentId = input.departmentId === undefined ? current.departmentId : input.departmentId;
  const timezone = input.timezone ?? current.timezone;
  const periods = input.periods ?? current.periods.map(({ dayOfWeek, startMinute, endMinute }) => ({
    dayOfWeek,
    startMinute,
    endMinute
  }));
  const holidays = input.holidays ?? current.holidays.map((holiday) => ({
    date: supportDateKey(holiday.date),
    name: holiday.name,
    working: holiday.working
  }));
  await assertCalendarDepartment(actor.workspace.id, departmentId);
  validateCalendar(timezone, periods, holidays);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      await tx.supportBusinessCalendar.update({
        where: { id: current.id },
        data: {
          name: input.name,
          timezone: input.timezone,
          departmentId: input.departmentId,
          active: input.active
        }
      });
      if (input.periods) {
        await tx.supportBusinessCalendarPeriod.deleteMany({ where: { calendarId: current.id } });
        await tx.supportBusinessCalendarPeriod.createMany({
          data: input.periods.map((period) => ({ calendarId: current.id, ...period }))
        });
      }
      if (input.holidays) {
        await tx.supportBusinessCalendarHoliday.deleteMany({ where: { calendarId: current.id } });
        if (input.holidays.length) {
          await tx.supportBusinessCalendarHoliday.createMany({
            data: input.holidays.map((holiday) => ({
              calendarId: current.id,
              date: supportDate(holiday.date),
              name: holiday.name,
              working: holiday.working
            }))
          });
        }
      }
      const refreshed = await tx.supportBusinessCalendar.findUniqueOrThrow({
        where: { id: current.id },
        include: calendarInclude
      });
      await appendSupportConfigurationAudit(actor, 'support_calendar', current.id, 'updated', {
        name: refreshed.name,
        timezone: refreshed.timezone,
        departmentId: refreshed.departmentId,
        active: refreshed.active
      }, tx);
      return refreshed;
    });
    return serializeCalendar(updated);
  } catch (error) {
    throw mapSupportConfigurationError(error, 'A Support calendar with this name already exists');
  }
}

export async function listSupportSlaPolicies(actor: RequestActor) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const policies = await prisma.supportSlaPolicy.findMany({
    where: { workspaceId: actor.workspace.id },
    orderBy: [{ active: 'desc' }, { priority: 'asc' }, { policyKey: 'asc' }, { version: 'desc' }],
    include: { calendar: { select: { id: true, name: true, timezone: true, active: true } } }
  });
  return policies.map(serializeSlaPolicy);
}

export async function createSupportSlaPolicyVersion(actor: RequestActor, input: CreateSupportSlaPolicyInput) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const conditions = supportSlaConditionsSchema.parse(input.conditions);
  const targets = supportSlaTargetsSchema.parse(input.targets);
  const pauseRules = supportSlaPauseRulesSchema.parse(input.pauseRules);
  if (!Object.keys(targets).length) throw new HttpError(400, 'At least one SLA target is required');
  if (input.effectiveUntil && input.effectiveUntil <= input.effectiveFrom) {
    throw new HttpError(400, 'SLA policy effectiveUntil must be after effectiveFrom');
  }
  const departmentIds = [...new Set(conditions.departmentIds ?? [])];

  try {
    const policy = await prisma.$transaction(async (tx) => {
      const calendar = await tx.supportBusinessCalendar.findFirst({
        where: { id: input.calendarId, workspaceId: actor.workspace.id, active: true },
        select: { id: true }
      });
      if (!calendar) throw new HttpError(400, 'Active Support business calendar not found');
      if (departmentIds.length) {
        const count = await tx.department.count({
          where: { workspaceId: actor.workspace.id, id: { in: departmentIds }, active: true }
        });
        if (count !== departmentIds.length) {
          throw new HttpError(400, 'SLA policy references an inactive or foreign Department');
        }
      }
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`support-sla-policy:${actor.workspace.id}:${input.policyKey}`}))
      `);
      const latest = await tx.supportSlaPolicy.aggregate({
        where: { workspaceId: actor.workspace.id, policyKey: input.policyKey },
        _max: { version: true }
      });
      const created = await tx.supportSlaPolicy.create({
        data: {
          workspaceId: actor.workspace.id,
          calendarId: input.calendarId,
          policyKey: input.policyKey,
          name: input.name,
          version: (latest._max.version ?? 0) + 1,
          priority: input.priority,
          conditions: conditions as Prisma.InputJsonValue,
          targets: targets as Prisma.InputJsonValue,
          pauseRules: pauseRules as Prisma.InputJsonValue,
          effectiveFrom: input.effectiveFrom,
          effectiveUntil: input.effectiveUntil ?? null
        },
        include: { calendar: { select: { id: true, name: true, timezone: true, active: true } } }
      });
      await appendSupportConfigurationAudit(actor, 'support_sla_policy', created.id, 'version_created', {
        policyKey: created.policyKey,
        version: created.version
      }, tx);
      return created;
    });
    return serializeSlaPolicy(policy);
  } catch (error) {
    throw mapSupportConfigurationError(error, 'This SLA policy version already exists');
  }
}

export async function deactivateSupportSlaPolicy(actor: RequestActor, policyId: string) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const current = await prisma.supportSlaPolicy.findFirst({
    where: { id: policyId, workspaceId: actor.workspace.id },
    include: { calendar: { select: { id: true, name: true, timezone: true, active: true } } }
  });
  if (!current) throw new HttpError(404, 'Support SLA policy not found');
  if (!current.active) return serializeSlaPolicy(current);
  const deactivatedAt = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const policy = await tx.supportSlaPolicy.update({
      where: { id: current.id },
      data: {
        active: false,
        effectiveUntil: current.effectiveFrom < deactivatedAt
          ? current.effectiveUntil && current.effectiveUntil < deactivatedAt
            ? current.effectiveUntil
            : deactivatedAt
          : current.effectiveUntil
      },
      include: { calendar: { select: { id: true, name: true, timezone: true, active: true } } }
    });
    await appendSupportConfigurationAudit(actor, 'support_sla_policy', current.id, 'deactivated', {
      policyKey: current.policyKey,
      version: current.version
    }, tx);
    return policy;
  });
  return serializeSlaPolicy(updated);
}

export async function snoozeSupportCaseAttention(
  actor: RequestActor,
  idOrKey: string,
  input: { snoozedUntil: Date; reason: string; baseVersion: number }
) {
  if (input.snoozedUntil.getTime() <= Date.now()) throw new HttpError(400, 'Snooze time must be in the future');
  return mutateSupportCaseSnooze(actor, idOrKey, input.baseVersion, async (tx, current) => {
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: { snoozedUntil: input.snoozedUntil, version: { increment: 1 } },
      include: supportCaseInclude
    });
    await applySupportSlaCaseEvent(tx, {
      workspaceId: updated.workspaceId,
      caseId: updated.id,
      event: 'SNOOZED',
      at: new Date()
    });
    const refreshed = await tx.supportCase.findUniqueOrThrow({ where: { id: updated.id }, include: supportCaseInclude });
    await appendSupportCaseEvent(tx, actor, refreshed, {
      action: 'case.attention_snoozed',
      before: { snoozedUntil: current.snoozedUntil?.toISOString() ?? null },
      after: { snoozedUntil: input.snoozedUntil.toISOString() },
      reason: input.reason
    });
    return refreshed;
  });
}

export async function resumeSupportCaseAttention(
  actor: RequestActor,
  idOrKey: string,
  input: { reason: string; baseVersion: number }
) {
  return mutateSupportCaseSnooze(actor, idOrKey, input.baseVersion, async (tx, current) => {
    if (!current.snoozedUntil) throw new HttpError(409, 'Support Case attention is not snoozed');
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: { snoozedUntil: null, version: { increment: 1 } },
      include: supportCaseInclude
    });
    await applySupportSlaCaseEvent(tx, {
      workspaceId: updated.workspaceId,
      caseId: updated.id,
      event: 'RESUMED',
      at: new Date()
    });
    const refreshed = await tx.supportCase.findUniqueOrThrow({ where: { id: updated.id }, include: supportCaseInclude });
    await appendSupportCaseEvent(tx, actor, refreshed, {
      action: 'case.attention_resumed',
      before: { snoozedUntil: current.snoozedUntil.toISOString() },
      after: { snoozedUntil: null },
      reason: input.reason
    });
    return refreshed;
  });
}

export async function searchSupportContacts(
  actor: RequestActor,
  query: string,
  limit: number,
  now = new Date()
) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  // INTAKE credentials are write-only: allowing exact contact lookup would turn a connector token
  // into a directory-exfiltration capability. A credential needs explicit CASE_READ in addition to
  // intake before it may use the audited human-style lookup surface.
  if (!access.canIntake || (access.credentialActor && !access.workspaceWide)) {
    throw new HttpError(403, 'Support contact lookup access required');
  }
  const normalized = query.trim();
  if (normalized.length < 2) throw new HttpError(400, 'Contact search requires at least two characters');
  const normalizedPhone = normalized.replace(/[^+\d]/g, '');
  const queryHash = createHmac('sha256', contactSearchAuditKey)
    .update(normalized.toLocaleLowerCase('en-US'))
    .digest('hex');
  const windowStartedAt = new Date(now.getTime() - 60_000);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext(${`support-contact-search:${actor.workspace.id}:${actor.user.id}`}))
    `);
    const recent = await tx.activityLog.count({
      where: {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        action: 'support_contact_search',
        createdAt: { gte: windowStartedAt }
      }
    });
    if (recent >= 20) {
      await tx.activityLog.create({
        data: {
          workspaceId: actor.workspace.id,
          actorId: actor.user.id,
          actorType: actor.actorType,
          actorRuntime: actor.actorRuntime,
          entityType: 'support_contact_search',
          entityId: actor.user.id,
          action: 'support_contact_search_rate_limited',
          after: { queryHash, windowSeconds: 60 },
          source: actor.source,
          createdAt: now
        }
      });
      return { rateLimited: true as const, items: [] };
    }
    const items = await tx.supportContact.findMany({
      where: {
        workspaceId: actor.workspace.id,
        redactedAt: null,
        OR: [
          { name: { contains: normalized, mode: 'insensitive' } },
          { normalizedEmail: { contains: normalized.toLocaleLowerCase('en-US') } },
          ...(normalizedPhone ? [{ normalizedPhone: { contains: normalizedPhone } }] : [])
        ]
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, name: true, email: true, phone: true }
    });
    await tx.activityLog.create({
      data: {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        actorType: actor.actorType,
        actorRuntime: actor.actorRuntime,
        entityType: 'support_contact_search',
        entityId: actor.user.id,
        action: 'support_contact_search',
        after: { queryHash, resultCount: items.length, limit },
        source: actor.source,
        createdAt: now
      }
    });
    return { rateLimited: false as const, items };
  });
  if (result.rateLimited) throw new HttpError(429, 'Support contact search rate limit exceeded');
  return result.items;
}

export async function getSupportOperationalReport(
  actor: RequestActor,
  input: { from: Date; to: Date; departmentId?: string }
) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  if (input.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: input.departmentId, ...departmentWhereForAccess(access) },
      select: { id: true }
    });
    if (!department) throw new HttpError(404, 'Department not found');
  }
  const accessWhere = supportCaseWhereForAccess(access);
  const visibleWhere: Prisma.SupportCaseWhereInput = {
    AND: [
      accessWhere,
      ...(input.departmentId ? [{ departmentId: input.departmentId }] : [])
    ]
  };
  const cohortWhere: Prisma.SupportCaseWhereInput = {
    AND: [visibleWhere, { receivedAt: { gte: input.from, lt: input.to } }]
  };
  const now = new Date();
  const [cases, backlog, clocks, queues, timezoneCalendar] = await Promise.all([
    prisma.supportCase.findMany({
      where: cohortWhere,
      orderBy: { receivedAt: 'asc' },
      select: {
        id: true,
        status: true,
        priority: true,
        sourceChannel: true,
        typeKey: true,
        resolutionCode: true,
        receivedAt: true,
        firstResponseAt: true,
        resolvedAt: true,
        closedAt: true,
        reopenCount: true,
        departmentId: true,
        department: { select: { name: true } }
      }
    }),
    prisma.supportCase.findMany({
      where: { AND: [visibleWhere, { status: { not: 'CLOSED' } }] },
      select: { receivedAt: true }
    }),
    prisma.supportCaseSlaClock.findMany({
      where: {
        workspaceId: actor.workspace.id,
        startedAt: { gte: input.from, lt: input.to },
        case: { is: visibleWhere }
      },
      select: { metric: true, state: true }
    }),
    input.departmentId ? scopedQueueCounts(access, visibleWhere, now) : supportQueueCounts(access, now),
    prisma.supportBusinessCalendar.findFirst({
      where: {
        workspaceId: actor.workspace.id,
        active: true,
        ...(input.departmentId
          ? { OR: [{ departmentId: input.departmentId }, { departmentId: null }] }
          : { departmentId: null })
      },
      orderBy: [{ departmentId: 'desc' }, { createdAt: 'asc' }],
      select: { timezone: true }
    })
  ]);

  const firstResponseDurations = cases.flatMap((supportCase) => supportCase.firstResponseAt
    ? [secondsBetween(supportCase.receivedAt, supportCase.firstResponseAt)]
    : []);
  const resolutionDurations = cases.flatMap((supportCase) => supportCase.resolvedAt
    ? [secondsBetween(supportCase.receivedAt, supportCase.resolvedAt)]
    : []);
  const backlogAges = backlog.map((supportCase) => secondsBetween(supportCase.receivedAt, now));
  const sla = new Map<SupportSlaMetric, { met: number; breached: number; active: number; canceled: number }>();
  for (const clock of clocks) {
    const current = sla.get(clock.metric) ?? { met: 0, breached: 0, active: 0, canceled: 0 };
    if (clock.state === 'MET') current.met += 1;
    else if (clock.state === 'BREACHED') current.breached += 1;
    else if (clock.state === 'CANCELED') current.canceled += 1;
    else current.active += 1;
    sla.set(clock.metric, current);
  }

  return {
    generatedAt: now.toISOString(),
    timezone: timezoneCalendar?.timezone ?? 'UTC',
    scope: {
      kind: access.workspaceWide
        ? input.departmentId ? 'DEPARTMENT' : 'WORKSPACE'
        : access.managedDepartmentIds.length ? 'MANAGED_DEPARTMENTS' : 'ASSIGNED_CASES',
      departmentId: input.departmentId ?? null
    },
    cohort: {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      definition: 'Cases currently visible to the caller and received at or after from and before to.'
    },
    summary: {
      received: cases.length,
      resolved: cases.filter((supportCase) => Boolean(supportCase.resolvedAt)).length,
      closed: cases.filter((supportCase) => Boolean(supportCase.closedAt)).length,
      reopened: cases.filter((supportCase) => supportCase.reopenCount > 0).length,
      firstResponseRate: cases.length ? firstResponseDurations.length / cases.length : null,
      firstResponseSeconds: durationSummary(firstResponseDurations),
      resolutionSeconds: durationSummary(resolutionDurations)
    },
    backlog: {
      open: backlog.length,
      ageSeconds: durationSummary(backlogAges)
    },
    queues,
    breakdowns: {
      status: frequency(cases.map((supportCase) => supportCase.status)),
      priority: frequency(cases.map((supportCase) => supportCase.priority)),
      sourceChannel: frequency(cases.map((supportCase) => supportCase.sourceChannel)),
      type: frequency(cases.map((supportCase) => supportCase.typeKey)),
      resolutionCode: frequency(cases.flatMap((supportCase) => supportCase.resolutionCode ? [supportCase.resolutionCode] : [])),
      department: [...groupDepartmentCounts(cases).values()]
    },
    sla: [...sla.entries()].map(([metric, values]) => ({
      metric,
      ...values,
      decided: values.met + values.breached,
      attainmentRate: values.met + values.breached ? values.met / (values.met + values.breached) : null
    })).sort((left, right) => left.metric.localeCompare(right.metric)),
    privacy: {
      perMemberBreakdownIncluded: false,
      note: 'Every aggregate uses the same Case access predicate as queues and detail reads.'
    }
  };
}

async function mutateSupportCaseSnooze(
  actor: RequestActor,
  idOrKey: string,
  baseVersion: number,
  mutate: (
    tx: Prisma.TransactionClient,
    current: Prisma.SupportCaseGetPayload<{ include: typeof supportCaseInclude }>
  ) => Promise<Prisma.SupportCaseGetPayload<{ include: typeof supportCaseInclude }>>
) {
  assertSupportWorkspace(actor.workspace);
  const result = await prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    const normalized = idOrKey.trim();
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "SupportCase"
      WHERE "workspaceId" = ${actor.workspace.id}::uuid
        AND ("id"::text = ${normalized} OR "key" = ${normalized.toUpperCase()})
      FOR UPDATE
    `);
    if (!rows[0]) throw new HttpError(404, 'Support Case not found');
    const current = await tx.supportCase.findUnique({ where: { id: rows[0].id }, include: supportCaseInclude });
    if (!current || !canReadSupportCase(access, current)) throw new HttpError(404, 'Support Case not found');
    assertCanWorkCase(access, current);
    if (current.version !== baseVersion) {
      throw new HttpError(409, 'Support Case changed on another client', {
        code: 'SUPPORT_VERSION_CONFLICT',
        current: serializeSupportCase(current, access)
      });
    }
    const updated = await mutate(tx, current);
    const event = await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
    return { updated, access, event };
  });
  publishSyncEvent(result.event);
  return serializeSupportCase(result.updated, result.access);
}

async function scopedQueueCounts(
  access: Awaited<ReturnType<typeof resolveSupportAccess>>,
  visibleWhere: Prisma.SupportCaseWhereInput,
  now: Date
) {
  const projectedAttentionWhere = await supportAttentionCaseWhere(access.workspaceId, now);
  const futureSnoozeExcluded: Prisma.SupportCaseWhereInput = {
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
  };
  const count = (where: Prisma.SupportCaseWhereInput) => prisma.supportCase.count({
    where: { AND: [visibleWhere, where] }
  });
  const entries = await Promise.all([
    access.triager || access.workspaceWide
      ? count({ departmentId: null, status: { notIn: ['RESOLVED', 'CLOSED'] } }).then((value) => ['TRIAGE', value] as const)
      : null,
    access.workspaceWide || access.managedDepartmentIds.length
      ? count({ departmentId: { not: null }, assigneeMembershipId: null, status: { notIn: ['RESOLVED', 'CLOSED'] } })
        .then((value) => ['DEPARTMENT_INBOX', value] as const)
      : null,
    access.memberMembershipIds.length
      ? count({ assigneeMembershipId: { in: access.memberMembershipIds }, status: { not: 'CLOSED' } })
        .then((value) => ['MY_CASES', value] as const)
      : null,
    count({ AND: [futureSnoozeExcluded, { OR: [supportNeedsAttentionWhere(now), projectedAttentionWhere] }] })
      .then((value) => ['NEEDS_ATTENTION', value] as const)
  ]);
  const result: Record<string, number> = {};
  for (const entry of entries) {
    if (entry) result[entry[0]] = entry[1];
  }
  return result;
}

function validateCalendar(
  timezone: string,
  periods: SupportCalendarPeriodInput[],
  holidays: SupportCalendarHolidayInput[]
): void {
  try {
    snapshotSupportBusinessCalendar({
      timezone,
      periods,
      holidays: holidays.map((holiday) => ({ dateKey: holiday.date, working: holiday.working }))
    });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid Support business calendar');
  }
}

async function assertCalendarDepartment(workspaceId: string, departmentId?: string | null): Promise<void> {
  if (!departmentId) return;
  const department = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId, active: true },
    select: { id: true }
  });
  if (!department) throw new HttpError(400, 'Calendar Department is inactive or belongs to another workspace');
}

function serializeCalendar(calendar: Prisma.SupportBusinessCalendarGetPayload<{ include: typeof calendarInclude }>) {
  return {
    id: calendar.id,
    name: calendar.name,
    timezone: calendar.timezone,
    department: calendar.department,
    active: calendar.active,
    periods: calendar.periods.map(({ dayOfWeek, startMinute, endMinute }) => ({ dayOfWeek, startMinute, endMinute })),
    holidays: calendar.holidays.map((holiday) => ({
      date: supportDateKey(holiday.date),
      name: holiday.name,
      working: holiday.working
    })),
    createdAt: calendar.createdAt.toISOString(),
    updatedAt: calendar.updatedAt.toISOString()
  };
}

function serializeSlaPolicy(policy: Prisma.SupportSlaPolicyGetPayload<{
  include: { calendar: { select: { id: true; name: true; timezone: true; active: true } } }
}>) {
  return {
    id: policy.id,
    policyKey: policy.policyKey,
    name: policy.name,
    version: policy.version,
    priority: policy.priority,
    active: policy.active,
    calendar: policy.calendar,
    conditions: policy.conditions,
    targets: policy.targets,
    pauseRules: policy.pauseRules,
    effectiveFrom: policy.effectiveFrom.toISOString(),
    effectiveUntil: policy.effectiveUntil?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString()
  };
}

async function appendSupportConfigurationAudit(
  actor: RequestActor,
  entityType: string,
  entityId: string,
  action: string,
  after: Prisma.InputJsonValue,
  client: Pick<Prisma.TransactionClient, 'activityLog'> = prisma
) {
  await client.activityLog.create({
    data: {
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      entityType,
      entityId,
      action,
      after,
      source: actor.source
    }
  });
}

function mapSupportConfigurationError(error: unknown, conflictMessage: string): unknown {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
    return new HttpError(409, conflictMessage);
  }
  return error;
}

function supportDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function supportDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

function durationSummary(values: number[]) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9)
  };
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

function frequency(values: string[]): Record<string, number> {
  return Object.fromEntries([...values.reduce((counts, value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function groupDepartmentCounts(cases: Array<{ departmentId: string | null; department: { name: string } | null }>) {
  const result = new Map<string, { departmentId: string | null; name: string; count: number }>();
  for (const supportCase of cases) {
    const key = supportCase.departmentId ?? 'UNROUTED';
    const current = result.get(key) ?? {
      departmentId: supportCase.departmentId,
      name: supportCase.department?.name ?? 'Unrouted',
      count: 0
    };
    current.count += 1;
    result.set(key, current);
  }
  return result;
}
