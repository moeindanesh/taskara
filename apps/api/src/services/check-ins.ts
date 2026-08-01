import { prisma, type Prisma, type TaskKind, type UserKind } from '@taskara/db';
import type { z } from 'zod';
import type {
  carryForwardMeetingActionItemSchema,
  createCheckInResponseSchema,
  createMeetingActionItemSchema,
  createOneOnOneAgendaItemSchema,
  createOneOnOneSeriesSchema,
  createTaskFromMeetingActionItemSchema,
  meetingActionItemListQuerySchema,
  updateMeetingActionItemSchema
} from '@taskara/shared';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { attributedTo } from './actor-provenance';
import { logActivity } from './audit';
import { openBlockerEdgesInclude } from './blockers';
import { HttpError } from './http';
import { buildMeetingAccessWhere, canAccessMeeting, resolveMeetingAccessScope } from './meetings';
import { measuredMemberWhere } from './measured-people';
import { isWorkTask } from './measured-work';
import { DAILY_REPORT_REQUESTED_NOTIFICATION_TYPE } from './notifications';
import { appendSyncEvent, publishSyncEvent, type SyncMutationMeta } from './sync';
import { createTask, ensureDefaultProject, serializeTaskForResponse } from './tasks';
import { dateKeyRange, isWorkdayKey, shiftDateKey, workspaceDateKey } from './workspace-time';

type CreateCheckInInput = z.infer<typeof createCheckInResponseSchema>;
type CreateOneOnOneInput = z.infer<typeof createOneOnOneSeriesSchema>;
type CreateAgendaItemInput = z.infer<typeof createOneOnOneAgendaItemSchema>;
type CreateActionItemInput = z.infer<typeof createMeetingActionItemSchema>;
type CreateTaskFromActionItemInput = z.infer<typeof createTaskFromMeetingActionItemSchema>;
type MeetingActionItemListInput = z.infer<typeof meetingActionItemListQuerySchema>;
type UpdateMeetingActionItemInput = z.infer<typeof updateMeetingActionItemSchema>;
type CarryForwardMeetingActionItemInput = z.infer<typeof carryForwardMeetingActionItemSchema>;

const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

const checkInInclude = {
  user: { select: userSelect },
  author: { select: userSelect }
} satisfies Prisma.CheckInResponseInclude;

const oneOnOneInclude = {
  manager: { select: userSelect },
  participant: { select: userSelect },
  lastMeeting: { select: { id: true, title: true, scheduledAt: true, heldAt: true, status: true } },
  _count: { select: { agendaItems: true } }
} satisfies Prisma.OneOnOneSeriesInclude;

const agendaItemInclude = {
  createdBy: { select: userSelect },
  meeting: { select: { id: true, title: true, scheduledAt: true, heldAt: true, status: true } }
} satisfies Prisma.OneOnOneAgendaItemInclude;

const actionItemInclude = {
  assignee: { select: userSelect },
  createdBy: { select: userSelect },
  task: { select: { id: true, key: true, title: true, status: true } },
  meeting: {
    select: {
      id: true,
      title: true,
      status: true,
      scheduledAt: true,
      heldAt: true,
      teamId: true,
      projectId: true,
      ownerId: true,
      createdById: true,
      project: { select: { id: true, name: true, keyPrefix: true, teamId: true } },
      participants: { select: { userId: true } }
    }
  }
} satisfies Prisma.MeetingActionItemInclude;

export type CheckInWithRelations = Prisma.CheckInResponseGetPayload<{ include: typeof checkInInclude }>;
export type OneOnOneWithRelations = Prisma.OneOnOneSeriesGetPayload<{ include: typeof oneOnOneInclude }>;
export type AgendaItemWithRelations = Prisma.OneOnOneAgendaItemGetPayload<{ include: typeof agendaItemInclude }>;
export type MeetingActionItemWithRelations = Prisma.MeetingActionItemGetPayload<{ include: typeof actionItemInclude }>;

export interface CheckInMissingPerson {
  user: { id: string; name: string; email: string; phone: string | null; avatarUrl: string | null };
  lastCheckInAt: string | null;
  hoursSinceLastCheckIn: number | null;
}

export interface AgendaCandidate {
  sourceType: 'attention' | 'blocked_task' | 'overdue_task' | 'check_in' | 'action_item';
  sourceId: string;
  title: string;
  notes?: string | null;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
}

// A daily report is one row per member per workspace day, so resubmitting edits today's report
// instead of stacking duplicates. The day is always resolved on the server (see workspace-time).
export async function createCheckInResponse(actor: RequestActor, input: CreateCheckInInput, syncMutation?: SyncMutationMeta) {
  const targetUserId = input.userId || actor.user.id;
  const submittingForSelf = targetUserId === actor.user.id;
  // The daily report is a human ritual, and participation is measured against the people who were
  // asked for one. An agent filing a report puts a row in the numerator that no denominator counts,
  // so the gate sits on the write rather than on the reads that would have to keep apologising for
  // it. Not a role check: an agent may legitimately hold MEMBER or ADMIN.
  if (actor.user.kind === 'AGENT') {
    throw new HttpError(403, 'Agents do not file daily reports');
  }
  if (!submittingForSelf && !isWorkspaceAdminRole(actor.role)) {
    throw new HttpError(403, 'Only workspace admins can submit check-ins for another user');
  }
  const targetKind = await assertWorkspaceMember(actor.workspace.id, targetUserId);
  // Closes the backfill door too: an admin cannot file one on an agent's behalf either.
  if (targetKind === 'AGENT') {
    throw new HttpError(403, 'Agents do not file daily reports');
  }

  const today = workspaceDateKey();
  const requestedDateKey = input.dateKey
    || (input.submittedFor ? workspaceDateKey(new Date(input.submittedFor)) : today);
  if (requestedDateKey !== today && submittingForSelf) {
    throw new HttpError(400, 'You can only file your own report for the current day');
  }
  if (requestedDateKey > today) {
    throw new HttpError(400, 'Cannot file a report for a future day');
  }

  const existing = await prisma.checkInResponse.findUnique({
    where: { workspaceId_userId_dateKey: { workspaceId: actor.workspace.id, userId: targetUserId, dateKey: requestedDateKey } },
    include: checkInInclude
  });

  const fields = {
    completedText: normalizeText(input.completedText),
    unplannedText: normalizeText(input.unplannedText),
    blockersText: normalizeText(input.blockersText),
    planText: normalizeText(input.planText),
    helpText: normalizeText(input.helpText)
  };
  const submittedFor = input.submittedFor ? new Date(input.submittedFor) : new Date();

  const row = existing
    ? await prisma.checkInResponse.update({
      where: { id: existing.id },
      data: { ...fields, authorId: actor.user.id, submittedFor },
      include: checkInInclude
    })
    : await prisma.checkInResponse.create({
      data: {
        workspaceId: actor.workspace.id,
        userId: targetUserId,
        authorId: actor.user.id,
        dateKey: requestedDateKey,
        submittedFor,
        ...fields
      },
      include: checkInInclude
    });

  const action = existing ? 'updated' : 'created';
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'check_in',
    entityId: row.id,
    action,
    before: existing ? serializeCheckIn(existing) : undefined,
    after: serializeCheckIn(row),
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'check_in', row.id, action, {
    before: existing ? serializeCheckIn(existing) : undefined,
    after: serializeCheckIn(row)
  }, syncMutation);

  return serializeCheckIn(row);
}

// Daily reports are peer-visible team communication rather than a private manager inbox; only
// guests and agents are held to their own rows.
function canReadAllCheckIns(actor: RequestActor): boolean {
  return actor.role === 'OWNER' || actor.role === 'ADMIN' || actor.role === 'MEMBER';
}

export async function listCheckIns(
  actor: RequestActor,
  input: { userId?: string; since?: string; dateKey?: string; from?: string; to?: string; limit?: number; offset?: number } = {}
) {
  const dateKeyFilter = input.dateKey
    ? input.dateKey
    : input.from || input.to
      ? { gte: input.from, lte: input.to }
      : undefined;

  const where: Prisma.CheckInResponseWhereInput = {
    workspaceId: actor.workspace.id,
    userId: canReadAllCheckIns(actor) ? input.userId : actor.user.id,
    dateKey: dateKeyFilter,
    submittedFor: input.since ? { gte: new Date(input.since) } : undefined
  };

  const [items, total] = await Promise.all([
    // measured-people:allow — listCheckIns is a visibility read: an agent report already filed stays readable.

    prisma.checkInResponse.findMany({
      where,
      include: checkInInclude,
      orderBy: [{ submittedFor: 'desc' }, { createdAt: 'desc' }],
      take: input.limit ?? 50,
      skip: input.offset ?? 0
    }),
    // measured-people:allow — That list's total, over the same where.
    prisma.checkInResponse.count({ where })
  ]);

  return {
    items: items.map(serializeCheckIn),
    total,
    limit: input.limit ?? 50,
    offset: input.offset ?? 0
  };
}

// Day-scoped counterpart of listMissingCheckIns: who owes a report for a specific workspace day.
// The digest and the reminder job both need this exact answer.
export async function listMissingForDay(actor: RequestActor, dateKey: string) {
  const { measuredUserIds: _measuredUserIds, ...response } = await collectMissingForDay(actor, dateKey);
  return response;
}

// Same answer, plus the measured population itself. Kept off the wire shape because it exists to
// let the digest prove its numerator and denominator describe the same people, not to be rendered.
async function collectMissingForDay(actor: RequestActor, dateKey: string) {
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace admin access required');
  const [members, submitted] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id, ...measuredMemberWhere },
      include: { user: { select: userSelect } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }]
    }),
    // measured-people:allow — Only ever intersected against an already-filtered roster, so it cannot leak into a count.
    prisma.checkInResponse.findMany({
      where: { workspaceId: actor.workspace.id, dateKey },
      select: { userId: true }
    })
  ]);

  const submittedIds = new Set(submitted.map((row) => row.userId));
  const missing = members.filter((member) => !submittedIds.has(member.userId)).map((member) => member.user);
  // measuredUserIds is the denominator's population, handed to the caller so a numerator can be
  // proven to come from the same set of people instead of from a second, separately written filter.
  return {
    dateKey,
    items: missing,
    total: missing.length,
    expected: members.length,
    measuredUserIds: new Set(members.map((member) => member.userId))
  };
}

export async function listMissingCheckIns(actor: RequestActor, hours = 24, now = new Date()) {
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace admin access required');
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const [members, recent] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id, ...measuredMemberWhere },
      include: { user: { select: userSelect } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }]
    }),
    // measured-people:allow — Same: intersected against the filtered roster in listMissingCheckIns.
    prisma.checkInResponse.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: { submittedFor: 'desc' },
      select: { userId: true, submittedFor: true }
    })
  ]);

  const lastByUserId = latestCheckInByUser(recent);
  const missing = members
    .map((member) => {
      const last = lastByUserId.get(member.userId) || null;
      const missing = !last || last.getTime() < since.getTime();
      if (!missing) return null;
      return {
        user: member.user,
        lastCheckInAt: last?.toISOString() ?? null,
        hoursSinceLastCheckIn: last ? Math.floor((now.getTime() - last.getTime()) / (60 * 60 * 1000)) : null
      } satisfies CheckInMissingPerson;
    })
    .filter((item): item is CheckInMissingPerson => Boolean(item));

  return { items: missing, total: missing.length, thresholdHours: hours, generatedAt: now.toISOString() };
}

export interface DailyReportCandidate {
  taskId: string;
  key: string;
  title: string;
  reason: 'completed' | 'created' | 'commented' | 'blocked' | 'focus';
}

// Prefill material for the composer. Everything here is a suggestion the member opts into with a
// tap — nothing is written into their report automatically, because noisy auto-insertion is what
// makes people stop trusting (and stop reading) these reports.
export async function buildCheckInDraft(actor: RequestActor, dateKey = workspaceDateKey()) {
  const { start, end } = dateKeyRange(dateKey);
  const previousDateKey = shiftDateKey(dateKey, -1);

  const [activity, createdToday, openTasks, existing, yesterday] = await Promise.all([
    prisma.activityLog.findMany({
      where: {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        entityType: 'task',
        createdAt: { gte: start, lt: end }
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    }),
    prisma.task.findMany({
      where: {
        workspaceId: actor.workspace.id,
        assigneeId: actor.user.id,
        createdAt: { gte: start, lt: end }
      },
      select: { id: true, key: true, title: true },
      take: 25
    }),
    prisma.task.findMany({
      where: {
        workspaceId: actor.workspace.id,
        assigneeId: actor.user.id,
        status: { notIn: ['DONE', 'CANCELED'] }
      },
      // The same open-blocker filter as the daily plan. This list decides which tasks a human is
      // offered as "blocked" and which as today's focus in their daily report draft, so an
      // unfiltered count kept finished prerequisites nagging in the blocked column indefinitely.
      include: { blockingDependencies: { ...openBlockerEdgesInclude, select: { id: true } } },
      orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
      take: 25
    }),
    prisma.checkInResponse.findUnique({
      where: { workspaceId_userId_dateKey: { workspaceId: actor.workspace.id, userId: actor.user.id, dateKey } },
      include: checkInInclude
    }),
    prisma.checkInResponse.findUnique({
      where: { workspaceId_userId_dateKey: { workspaceId: actor.workspace.id, userId: actor.user.id, dateKey: previousDateKey } },
      include: checkInInclude
    })
  ]);

  // One chip per task, not per task-and-reason: both chips would insert the same line, so a second
  // one is pure noise. Where a task was touched several ways today, the most report-worthy wins.
  const byTaskKey = new Map<string, DailyReportCandidate>();
  for (const row of activity) {
    const task = taskFromActivitySnapshot(row.after);
    if (!task) continue;
    const reason = candidateReason(row.action, row.after, row.before);
    if (!reason) continue;
    const existingCandidate = byTaskKey.get(task.key);
    if (existingCandidate && candidateReasonRank(existingCandidate.reason) >= candidateReasonRank(reason)) continue;
    byTaskKey.set(task.key, { taskId: row.entityId, key: task.key, title: task.title, reason });
  }
  const completedCandidates: DailyReportCandidate[] = [...byTaskKey.values()];

  // Work that appeared today and was not on the plan is the raw material for "unexpected work".
  const plannedKeys = extractTaskKeys(yesterday?.planText ?? '');
  const unplannedCandidates: DailyReportCandidate[] = createdToday
    .filter((task) => !plannedKeys.has(task.key))
    .map((task) => ({ taskId: task.id, key: task.key, title: task.title, reason: 'created' as const }));

  const blockedTasks: DailyReportCandidate[] = openTasks
    .filter((task) => task.status === 'BLOCKED' || task.blockingDependencies.length > 0)
    .map((task) => ({ taskId: task.id, key: task.key, title: task.title, reason: 'blocked' as const }));

  const planCandidates: DailyReportCandidate[] = openTasks
    .filter((task) => task.status !== 'BLOCKED' && task.blockingDependencies.length === 0)
    .slice(0, 5)
    .map((task) => ({ taskId: task.id, key: task.key, title: task.title, reason: 'focus' as const }));

  return {
    dateKey,
    existing: existing ? serializeCheckIn(existing) : null,
    yesterday: yesterday ? serializeCheckIn(yesterday) : null,
    completedCandidates,
    unplannedCandidates,
    blockedTasks,
    planCandidates
  };
}

// Manager morning artifact: blockers first, then the day's unexpected work, then everyone's report,
// then who is missing. One request so the digest view never fans out.
export async function buildDailyReportDigest(actor: RequestActor, dateKey = workspaceDateKey()) {
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace admin access required');
  const previousDateKey = shiftDateKey(dateKey, -1);

  // The digest answers two different questions and must not conflate them. What a manager READS is
  // every report filed that day, whoever filed it — filtering the read is how a GUEST human, a real
  // contributor the ritual simply does not score, vanished from the digest along with their
  // blockers. What a manager is SCORED BY is the measured roster only. So the rows are fetched
  // unfiltered and narrowed once, in memory, for the stats.
  const [rows, previousRows, missing] = await Promise.all([
    // measured-people:allow — Every report filed that day, for a manager to read. Nothing is counted off this list; stats below are drawn from the measured subset of it.
    prisma.checkInResponse.findMany({
      where: { workspaceId: actor.workspace.id, dateKey },
      include: checkInInclude,
      orderBy: { submittedFor: 'asc' }
    }),
    // measured-people:allow — Yesterday's plans, used as a per-author lookup to pair against today's report. Never counted.
    prisma.checkInResponse.findMany({
      where: { workspaceId: actor.workspace.id, dateKey: previousDateKey },
      include: checkInInclude
    }),
    collectMissingForDay(actor, dateKey)
  ]);

  // VISIBILITY — reports, blockersFirst, unplanned and planVsDone are what the manager sees. Every
  // row filed today appears in them, including a guest's and including a legacy agent row.
  const reports = rows.map(serializeCheckIn);
  const previousByUser = new Map(previousRows.map((row) => [row.userId, row]));

  const blockersFirst = reports.filter((report) => report.blockersText || report.helpText);
  const unplanned = reports.filter((report) => report.unplannedText);
  const planVsDone = reports.map((report) => {
    const plannedYesterday = previousByUser.get(report.userId)?.planText ?? null;
    return {
      userId: report.userId,
      user: report.user,
      plannedYesterday,
      completedToday: report.completedText,
      // Task keys make yesterday's plan machine-comparable to today's report, so a manager sees
      // what slipped without reading two text blobs side by side.
      tasks: diffPlannedTasks(plannedYesterday, report.completedText)
    };
  }).filter((entry) => entry.plannedYesterday);

  // MEASUREMENT — everything in `stats`. The counted set comes from the denominator's own member
  // ids rather than from a second, separately written filter, so numerator and denominator are
  // provably one population. One report row per person per day makes `submitted <= expected` true
  // by construction, and every ratio below divides one counted quantity by another.
  //
  // The second axis is the day itself, and the digest used to have no opinion about it while trends
  // did — so on a Thursday the two endpoints described the same workspace differently: trends said
  // the day asks for nothing, the digest said 0 of N and named every human as missing. Nobody is
  // asked for a report on a weekend, so on a non-workday there is no denominator, nothing counted
  // against it, and nobody owes anything. The reports filed anyway are still read above.
  const workday = isWorkdayKey(dateKey);
  const countedReports = workday ? reports.filter((report) => missing.measuredUserIds.has(report.userId)) : [];
  const countedBlockers = countedReports.filter((report) => report.blockersText || report.helpText);
  const countedUnplanned = countedReports.filter((report) => report.unplannedText);

  const expected = workday ? missing.expected : 0;
  const missingItems = workday ? missing.items : [];
  const submittedCount = countedReports.length;

  return {
    dateKey,
    workday,
    reports,
    blockersFirst,
    unplanned,
    planVsDone,
    missing: missingItems,
    stats: {
      expected,
      submitted: submittedCount,
      missing: missingItems.length,
      participationRate: expected > 0 ? Math.round((submittedCount / expected) * 100) : 0,
      blockerCount: countedBlockers.length,
      // Share of the day's counted reports that included unexpected work — the team-health trend
      // that matters more than any single day's value. Both sides of the division come from
      // countedReports; mixing an all-rows numerator with a measured denominator is the same class
      // of bug as counting an agent in a human's participation rate.
      unplannedShare: submittedCount > 0 ? Math.round((countedUnplanned.length / submittedCount) * 100) : 0
    }
  };
}

// Trends over a window. Direction matters far more than any single day: a rising unplanned-work
// share is a process problem, and a falling participation rate means the ritual is dying.
export async function buildDailyReportTrends(actor: RequestActor, days = 14, today = workspaceDateKey()) {
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace admin access required');
  const from = shiftDateKey(today, -(days - 1));

  // Same two-sided rule as the digest, for the same reason: what the chart SHOWS and what the rates
  // COUNT are different questions, and answering both from one filtered list is what made people
  // disappear. Rows arrive unfiltered and are narrowed once, in memory, for the counted set.
  const [allRows, members] = await Promise.all([
    // measured-people:allow — Every report filed in the window, for the per-day display counts. Narrowed against the measured roster below before any of it becomes a rate.
    prisma.checkInResponse.findMany({
      where: {
        workspaceId: actor.workspace.id,
        dateKey: { gte: from, lte: today }
      },
      select: { userId: true, dateKey: true, unplannedText: true, blockersText: true, helpText: true }
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id, ...measuredMemberWhere },
      include: { user: { select: userSelect } }
    })
  ]);

  // Two axes have to agree with the denominator before any of these numbers mean anything, and
  // they are independent: WHO is counted, and WHICH DAYS are counted.
  //   - WHO: `members` is the measured roster, so a report by a guest or an agent is not a
  //     submission against it. Every rate below is over that roster.
  //   - WHICH DAYS: `expected` is `members.length` on workdays and 0 otherwise, and `possible` is
  //     roster × workdays. A report filed on a weekend therefore has no matching slot in any
  //     denominator here, and counting it produced submitted > expected on that day and a totals
  //     rate above 100% for a team that simply worked a Friday.
  // `rows` is that counted set. It feeds every rate — and only the rates. Narrowing what the chart
  // DISPLAYS to it as well is how a member who filed on a Thursday vanished from their own trends:
  // the day still had their report, the chart just had nothing left to draw. The per-day display
  // counts below therefore come from `allRows`, which is why the bar chart bothers to size itself
  // to `max(expected, submitted)` at all.
  const measuredUserIds = new Set(members.map((member) => member.userId));
  // A null dateKey predates the daily-report day key and belongs to no day in the window, so it has
  // no slot in any denominator either.
  const rows = allRows.filter(
    (row) => measuredUserIds.has(row.userId) && row.dateKey !== null && isWorkdayKey(row.dateKey)
  );

  const dayKeys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) dayKeys.push(shiftDateKey(today, -offset));

  const byDay = dayKeys.map((dateKey) => {
    const workday = isWorkdayKey(dateKey);
    // DISPLAYED — what was filed that day, by anyone. VISIBILITY, exactly like the digest's report
    // list: a weekend report and a guest's report both happened and both stay on the chart.
    const filed = allRows.filter((row) => row.dateKey === dateKey);
    // COUNTED — the subset with a slot in that day's denominator. Empty on a weekend, by design.
    const counted = rows.filter((row) => row.dateKey === dateKey);
    const countedUnplanned = counted.filter((row) => row.unplannedText).length;
    return {
      dateKey,
      workday,
      submitted: filed.length,
      // The rate-bearing count, the one `expected` is comparable to. `counted <= expected` holds by
      // construction: one report per person per day, and every counted author is in `members`.
      counted: counted.length,
      // Nobody is asked for a report on a weekend, so nobody is expected to have filed one.
      expected: workday ? members.length : 0,
      unplanned: filed.filter((row) => row.unplannedText).length,
      blockers: filed.filter((row) => row.blockersText || row.helpText).length,
      unplannedShare: counted.length ? Math.round((countedUnplanned / counted.length) * 100) : 0
    };
  });

  // Participation is measured against the days the ritual actually asks for a report. Counting
  // weekends in the denominator would cap a perfect team at roughly 71% and read as failure.
  const workdayCount = dayKeys.filter(isWorkdayKey).length;

  const byPerson = members.map((member) => {
    const personRows = rows.filter((row) => row.userId === member.userId);
    return {
      user: member.user,
      submitted: personRows.length,
      possible: workdayCount,
      unplannedDays: personRows.filter((row) => row.unplannedText).length,
      blockerDays: personRows.filter((row) => row.blockersText || row.helpText).length
    };
  }).sort((left, right) => right.submitted - left.submitted);

  const totalSubmitted = rows.length;
  return {
    from,
    to: today,
    days,
    workdays: workdayCount,
    byDay,
    byPerson,
    totals: {
      submitted: totalSubmitted,
      possible: members.length * workdayCount,
      unplannedShare: totalSubmitted ? Math.round((rows.filter((row) => row.unplannedText).length / totalSubmitted) * 100) : 0,
      blockerShare: totalSubmitted
        ? Math.round((rows.filter((row) => row.blockersText || row.helpText).length / totalSubmitted) * 100)
        : 0
    }
  };
}

// Turns the old copy-to-clipboard nudge into a real, delivered request.
export async function requestCheckIn(actor: RequestActor, userId: string, message?: string | null) {
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace admin access required');
  const targetKind = await assertWorkspaceMember(actor.workspace.id, userId);
  // Asking an agent for a report is asking it for something it is forbidden to file. The UI never
  // offers it — the ids come from the filtered missing list — but a direct API call would.
  if (targetKind === 'AGENT') throw new HttpError(400, 'Agents do not file daily reports');
  const notification = await prisma.notification.create({
    data: {
      workspaceId: actor.workspace.id,
      userId,
      ...attributedTo(actor),
      type: DAILY_REPORT_REQUESTED_NOTIFICATION_TYPE,
      title: `${actor.user.name} گزارش روزانه‌ات را خواسته است`,
      body: message?.trim() || 'لطفاً گزارش روزانه‌ی امروزت را ثبت کن.'
    }
  });
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'check_in',
    entityId: userId,
    action: 'requested',
    source: actor.source
  }).catch(() => undefined);
  return { requested: true, notificationId: notification?.id ?? null };
}

const taskKeyPattern = /\b[A-Z][A-Z0-9]*-\d+\b/g;

function extractTaskKeys(text: string): Set<string> {
  return new Set(text.match(taskKeyPattern) ?? []);
}

export interface PlannedTaskDiff {
  key: string;
  status: 'done' | 'slipped';
}

// Compares the task keys someone planned against the ones they reported finishing. Keys only —
// prose is left alone, because guessing intent from free text is how these features lose trust.
export function diffPlannedTasks(planText: string | null, completedText: string | null): PlannedTaskDiff[] {
  const planned = extractTaskKeys(planText ?? '');
  if (!planned.size) return [];
  const completed = extractTaskKeys(completedText ?? '');
  return [...planned].map((key) => ({ key, status: completed.has(key) ? 'done' : 'slipped' }));
}

function taskFromActivitySnapshot(snapshot: unknown): { key: string; title: string } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const record = snapshot as Record<string, unknown>;
  const key = record.key;
  const title = record.title;
  if (typeof key !== 'string' || typeof title !== 'string') return null;
  // WORK LIST — effort excluded. These become "what I did today" chips in someone's daily report,
  // and from there a task key in the manager's digest; an agent's map is not a person's day's work.
  //
  // Filtered here rather than at the query because ActivityLog has no `kind` column — logActivity
  // snapshots the whole task into JSON, so `kind` is only readable once the rows are materialised.
  // A snapshot written before the column existed carries none, and every one of those is WORK.
  if (typeof record.kind === 'string' && !isWorkTask({ kind: record.kind as TaskKind })) return null;
  return { key, title };
}

// "I finished it" beats "I opened it" beats "I said something about it" when one task qualifies
// under more than one of them.
function candidateReasonRank(reason: DailyReportCandidate['reason']): number {
  if (reason === 'completed') return 3;
  if (reason === 'created') return 2;
  return 1;
}

function candidateReason(
  action: string,
  after: unknown,
  before: unknown
): DailyReportCandidate['reason'] | null {
  if (action === 'commented') return 'commented';
  if (action === 'created') return 'created';
  if (action !== 'updated') return null;
  const afterStatus = (after as Record<string, unknown> | null)?.status;
  const beforeStatus = (before as Record<string, unknown> | null)?.status;
  // Only a real transition into DONE counts as "I finished this today".
  return afterStatus === 'DONE' && beforeStatus !== 'DONE' ? 'completed' : null;
}

export function latestCheckInByUser(rows: Array<{ userId: string; submittedFor: Date }>): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const row of rows) {
    const current = latest.get(row.userId);
    if (!current || row.submittedFor.getTime() > current.getTime()) {
      latest.set(row.userId, row.submittedFor);
    }
  }
  return latest;
}

export async function listOneOnOnes(
  actor: RequestActor,
  input: { participantId?: string; active?: boolean; limit?: number; offset?: number } = {}
) {
  const where: Prisma.OneOnOneSeriesWhereInput = {
    workspaceId: actor.workspace.id,
    participantId: input.participantId,
    active: input.active,
    ...(isWorkspaceAdminRole(actor.role)
      ? {}
      : {
          OR: [
            { managerId: actor.user.id },
            { participantId: actor.user.id }
          ]
        })
  };
  const [items, total] = await Promise.all([
    prisma.oneOnOneSeries.findMany({
      where,
      include: oneOnOneInclude,
      orderBy: [{ active: 'desc' }, { nextScheduledAt: 'asc' }, { updatedAt: 'desc' }],
      take: input.limit ?? 50,
      skip: input.offset ?? 0
    }),
    prisma.oneOnOneSeries.count({ where })
  ]);
  return { items: items.map(serializeOneOnOne), total, limit: input.limit ?? 50, offset: input.offset ?? 0 };
}

export async function createOneOnOneSeries(actor: RequestActor, input: CreateOneOnOneInput, syncMutation?: SyncMutationMeta) {
  const managerId = input.managerId || actor.user.id;
  if (managerId !== actor.user.id && !isWorkspaceAdminRole(actor.role)) {
    throw new HttpError(403, 'Only workspace admins can assign another manager');
  }
  if (managerId === input.participantId) throw new HttpError(400, '1:1 participant must be different from manager');
  await Promise.all([
    assertWorkspaceMember(actor.workspace.id, managerId),
    assertWorkspaceMember(actor.workspace.id, input.participantId)
  ]);

  const series = await prisma.oneOnOneSeries.create({
    data: {
      workspaceId: actor.workspace.id,
      managerId,
      participantId: input.participantId,
      title: input.title?.trim() || undefined,
      cadenceDays: input.cadenceDays,
      nextScheduledAt: input.nextScheduledAt ? new Date(input.nextScheduledAt) : undefined
    },
    include: oneOnOneInclude
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'one_on_one',
    entityId: series.id,
    action: 'created',
    after: serializeOneOnOne(series),
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'one_on_one', series.id, 'created', { after: serializeOneOnOne(series) }, syncMutation);

  return serializeOneOnOne(series);
}

export async function getOneOnOneAgenda(actor: RequestActor, seriesId: string, now = new Date()) {
  const series = await requireOneOnOneAccess(actor, seriesId);
  const [persisted, candidates] = await Promise.all([
    prisma.oneOnOneAgendaItem.findMany({
      where: { workspaceId: actor.workspace.id, seriesId, status: 'OPEN' },
      include: agendaItemInclude,
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }]
    }),
    generateOneOnOneAgendaCandidates(actor.workspace.id, series.participantId, now)
  ]);

  return {
    series: serializeOneOnOne(series),
    items: persisted.map(serializeAgendaItem),
    generated: candidates,
    generatedAt: now.toISOString()
  };
}

export async function addOneOnOneAgendaItem(
  actor: RequestActor,
  seriesId: string,
  input: CreateAgendaItemInput,
  syncMutation?: SyncMutationMeta
) {
  await requireOneOnOneAccess(actor, seriesId);
  const item = await prisma.oneOnOneAgendaItem.create({
    data: {
      workspaceId: actor.workspace.id,
      seriesId,
      meetingId: input.meetingId ?? undefined,
      createdById: actor.user.id,
      sourceType: input.sourceType?.trim() || undefined,
      sourceId: input.sourceId?.trim() || undefined,
      title: input.title,
      notes: input.notes?.trim() || undefined,
      position: input.position
    },
    include: agendaItemInclude
  });
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'one_on_one_agenda_item',
    entityId: item.id,
    action: 'created',
    after: serializeAgendaItem(item),
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'one_on_one_agenda_item', item.id, 'created', { after: serializeAgendaItem(item) }, syncMutation);
  return serializeAgendaItem(item);
}

export async function listMeetingActionItems(actor: RequestActor, input: Partial<MeetingActionItemListInput> = {}) {
  const accessScope = await resolveMeetingAccessScope(actor);
  const where: Prisma.MeetingActionItemWhereInput = {
    workspaceId: actor.workspace.id,
    assigneeId: input.assigneeId,
    meetingId: input.meetingId,
    ...(input.status && input.status !== 'ALL' ? { status: input.status } : {}),
    ...(input.dueBefore ? { dueAt: { lte: new Date(input.dueBefore) } } : {}),
    meeting: buildMeetingAccessWhere(actor, accessScope)
  };

  const [items, total] = await Promise.all([
    prisma.meetingActionItem.findMany({
      where,
      include: actionItemInclude,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
      take: input.limit ?? 50,
      skip: input.offset ?? 0
    }),
    prisma.meetingActionItem.count({ where })
  ]);

  return { items: items.map(serializeMeetingActionItem), total, limit: input.limit ?? 50, offset: input.offset ?? 0 };
}

export async function createMeetingActionItem(
  actor: RequestActor,
  meetingId: string,
  input: CreateActionItemInput,
  syncMutation?: SyncMutationMeta
) {
  const accessScope = await resolveMeetingAccessScope(actor);
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId: actor.workspace.id },
    select: {
      id: true,
      teamId: true,
      projectId: true,
      ownerId: true,
      createdById: true,
      project: { select: { teamId: true } },
      participants: { select: { userId: true } }
    }
  });
  if (!meeting) throw new HttpError(404, 'Meeting not found');
  if (!canAccessMeeting(actor, meeting, accessScope)) throw new HttpError(403, 'Meeting access denied');
  if (input.assigneeId) await assertWorkspaceMember(actor.workspace.id, input.assigneeId);

  const row = await prisma.meetingActionItem.create({
    data: {
      workspaceId: actor.workspace.id,
      meetingId,
      assigneeId: input.assigneeId ?? undefined,
      createdById: actor.user.id,
      title: input.title,
      notes: input.notes?.trim() || undefined,
      dueAt: input.dueAt ? new Date(input.dueAt) : undefined
    },
    include: actionItemInclude
  });
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'meeting_action_item',
    entityId: row.id,
    action: 'created',
    after: serializeMeetingActionItem(row),
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'meeting_action_item', row.id, 'created', { after: serializeMeetingActionItem(row) }, syncMutation);
  return serializeMeetingActionItem(row);
}

export async function updateMeetingActionItem(
  actor: RequestActor,
  actionItemId: string,
  input: UpdateMeetingActionItemInput,
  action = 'updated',
  syncMutation?: SyncMutationMeta
) {
  const current = await requireMeetingActionItemAccess(actor, actionItemId);
  if (input.assigneeId) await assertWorkspaceMember(actor.workspace.id, input.assigneeId);

  const before = serializeMeetingActionItem(current);
  const updated = await prisma.meetingActionItem.update({
    where: { id: current.id },
    data: {
      title: input.title,
      notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
      assigneeId: input.assigneeId === undefined ? undefined : input.assigneeId,
      dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
      status: input.status
    },
    include: actionItemInclude
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'meeting_action_item',
    entityId: updated.id,
    action,
    before,
    after: serializeMeetingActionItem(updated),
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'meeting_action_item', updated.id, action, {
    before,
    after: serializeMeetingActionItem(updated)
  }, syncMutation);

  return serializeMeetingActionItem(updated);
}

export async function completeMeetingActionItem(actor: RequestActor, actionItemId: string, syncMutation?: SyncMutationMeta) {
  return updateMeetingActionItem(actor, actionItemId, { status: 'DONE' }, 'completed', syncMutation);
}

export async function cancelMeetingActionItem(actor: RequestActor, actionItemId: string, syncMutation?: SyncMutationMeta) {
  return updateMeetingActionItem(actor, actionItemId, { status: 'CANCELED' }, 'canceled', syncMutation);
}

export async function carryForwardMeetingActionItem(
  actor: RequestActor,
  actionItemId: string,
  input: CarryForwardMeetingActionItemInput,
  syncMutation?: SyncMutationMeta
) {
  const [actionItem, series] = await Promise.all([
    requireMeetingActionItemAccess(actor, actionItemId),
    requireOneOnOneAccess(actor, input.seriesId)
  ]);

  if (actionItem.assigneeId && actionItem.assigneeId !== series.participantId) {
    throw new HttpError(400, 'Action item assignee must match the 1:1 participant');
  }

  const existing = await prisma.oneOnOneAgendaItem.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      seriesId: series.id,
      sourceType: 'action_item',
      sourceId: actionItem.id,
      status: 'OPEN'
    },
    include: agendaItemInclude
  });

  const agendaItem = existing || await prisma.oneOnOneAgendaItem.create({
    data: {
      workspaceId: actor.workspace.id,
      seriesId: series.id,
      createdById: actor.user.id,
      sourceType: 'action_item',
      sourceId: actionItem.id,
      title: actionItem.title,
      notes: input.notes?.trim() || actionItem.notes || undefined,
      position: 0
    },
    include: agendaItemInclude
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'meeting_action_item',
    entityId: actionItem.id,
    action: existing ? 'carry_forward_skipped_duplicate' : 'carried_forward',
    before: serializeMeetingActionItem(actionItem),
    after: serializeAgendaItem(agendaItem),
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'meeting_action_item', actionItem.id, existing ? 'carry_forward_skipped_duplicate' : 'carried_forward', {
    before: serializeMeetingActionItem(actionItem),
    after: serializeAgendaItem(agendaItem)
  }, syncMutation);
  if (!existing) {
    await emitSyncEvent(actor, 'one_on_one_agenda_item', agendaItem.id, 'created', { after: serializeAgendaItem(agendaItem) }, syncMutation);
  }

  return { actionItem: serializeMeetingActionItem(actionItem), agendaItem: serializeAgendaItem(agendaItem) };
}

export async function createTaskFromMeetingActionItem(
  actor: RequestActor,
  actionItemId: string,
  input: CreateTaskFromActionItemInput,
  syncMutation?: SyncMutationMeta
) {
  const actionItem = await requireMeetingActionItemAccess(actor, actionItemId);
  if (actionItem.taskId) throw new HttpError(409, 'Meeting action item already has a linked task');

  const defaultProject = input.projectId || actionItem.meeting.projectId ? null : await ensureDefaultProject(actor.workspace.id);
  const target = taskTargetFromMeetingActionItem(input.projectId, actionItem.meeting.projectId, defaultProject?.id);
  const projectId = target.projectId;
  if (!projectId) throw new HttpError(400, 'Project is required to create a task from this action item');

  const task = await createTask(actor, {
    projectId,
    title: actionItem.title,
    description: actionItem.notes || undefined,
    assigneeId: input.assigneeId === undefined ? actionItem.assigneeId ?? undefined : input.assigneeId ?? undefined,
    status: target.status,
    priority: input.priority,
    dueAt: input.dueAt ?? actionItem.dueAt?.toISOString(),
    labels: [],
    source: 'WEB'
  }, syncMutation);
  const updated = await prisma.meetingActionItem.update({
    where: { id: actionItem.id },
    data: {
      taskId: task.id,
      status: 'DONE'
    },
    include: actionItemInclude
  });
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'meeting_action_item',
    entityId: updated.id,
    action: 'converted_to_task',
    before: serializeMeetingActionItem(actionItem),
    after: { actionItem: serializeMeetingActionItem(updated), task: serializeTaskForResponse(task) },
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'meeting_action_item', updated.id, 'converted_to_task', {
    before: serializeMeetingActionItem(actionItem),
    after: serializeMeetingActionItem(updated)
  }, syncMutation);
  return { actionItem: serializeMeetingActionItem(updated), task: serializeTaskForResponse(task) };
}

export function taskTargetFromMeetingActionItem(
  inputProjectId?: string | null,
  meetingProjectId?: string | null,
  defaultProjectId?: string | null
): { projectId: string | null; status: 'TODO' | 'BACKLOG' } {
  if (inputProjectId) return { projectId: inputProjectId, status: 'TODO' };
  if (meetingProjectId) return { projectId: meetingProjectId, status: 'TODO' };
  return { projectId: defaultProjectId ?? null, status: 'BACKLOG' };
}

export async function generateOneOnOneAgendaCandidates(
  workspaceId: string,
  participantId: string,
  now = new Date()
): Promise<AgendaCandidate[]> {
  const [attention, tasks, checkIns, actionItems] = await Promise.all([
    prisma.attentionItem.findMany({
      where: {
        workspaceId,
        status: 'OPEN',
        OR: [
          { assigneeId: participantId },
          { entityType: 'user', entityId: participantId }
        ]
      },
      orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }],
      take: 5
    }),
    prisma.task.findMany({
      where: {
        workspaceId,
        assigneeId: participantId,
        status: { in: ['BLOCKED', 'TODO', 'IN_PROGRESS', 'IN_REVIEW'] }
      },
      orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
      select: { id: true, key: true, title: true, status: true, dueAt: true }
    }),
    // measured-people:allow — 1:1 agenda material for one named participant. No rate, no denominator.
    prisma.checkInResponse.findMany({
      where: { workspaceId, userId: participantId },
      orderBy: { submittedFor: 'desc' },
      take: 3
    }),
    prisma.meetingActionItem.findMany({
      where: { workspaceId, assigneeId: participantId, status: 'OPEN' },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 5
    })
  ]);

  const candidates: AgendaCandidate[] = [];
  for (const item of attention) {
    candidates.push({
      sourceType: 'attention',
      sourceId: item.id,
      title: titleFromAttentionPayload(item.payload) || item.reason,
      notes: item.reason,
      severity: item.severity
    });
  }
  for (const task of tasks) {
    if (task.status === 'BLOCKED') {
      candidates.push({
        sourceType: 'blocked_task',
        sourceId: task.id,
        title: `${task.key}: ${task.title}`,
        notes: 'Blocked work to unblock in 1:1.',
        severity: 'HIGH'
      });
      continue;
    }
    if (task.dueAt && task.dueAt.getTime() < now.getTime()) {
      candidates.push({
        sourceType: 'overdue_task',
        sourceId: task.id,
        title: `${task.key}: ${task.title}`,
        notes: 'Overdue work needs a plan.',
        severity: 'HIGH'
      });
    }
  }
  for (const checkIn of checkIns) {
    const note = [checkIn.blockersText, checkIn.helpText].filter(Boolean).join('\n');
    if (!note.trim()) continue;
    candidates.push({
      sourceType: 'check_in',
      sourceId: checkIn.id,
      title: 'Follow up from latest check-in',
      notes: note,
      severity: checkIn.helpText ? 'MEDIUM' : 'LOW'
    });
  }
  for (const actionItem of actionItems) {
    candidates.push({
      sourceType: 'action_item',
      sourceId: actionItem.id,
      title: actionItem.title,
      notes: actionItem.notes,
      severity: actionItem.dueAt && actionItem.dueAt.getTime() < now.getTime() ? 'HIGH' : 'MEDIUM'
    });
  }

  return dedupeAgendaCandidates(candidates)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 12);
}

export function dedupeAgendaCandidates(candidates: AgendaCandidate[]): AgendaCandidate[] {
  const seen = new Set<string>();
  const deduped: AgendaCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.sourceType}:${candidate.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

async function requireOneOnOneAccess(actor: RequestActor, seriesId: string): Promise<OneOnOneWithRelations> {
  const series = await prisma.oneOnOneSeries.findFirst({
    where: { id: seriesId, workspaceId: actor.workspace.id },
    include: oneOnOneInclude
  });
  if (!series) throw new HttpError(404, '1:1 series not found');
  if (!isWorkspaceAdminRole(actor.role) && series.managerId !== actor.user.id && series.participantId !== actor.user.id) {
    throw new HttpError(403, '1:1 access denied');
  }
  return series;
}

async function requireMeetingActionItemAccess(actor: RequestActor, actionItemId: string): Promise<MeetingActionItemWithRelations> {
  const accessScope = await resolveMeetingAccessScope(actor);
  const item = await prisma.meetingActionItem.findFirst({
    where: {
      id: actionItemId,
      workspaceId: actor.workspace.id,
      meeting: buildMeetingAccessWhere(actor, accessScope)
    },
    include: actionItemInclude
  });
  if (!item) throw new HttpError(404, 'Meeting action item not found');
  return item;
}

async function assertWorkspaceMember(workspaceId: string, userId: string): Promise<UserKind> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true, user: { select: { kind: true } } }
  });
  if (!member) throw new HttpError(400, 'User must belong to this workspace');
  return member.user.kind;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function serializeCheckIn(row: CheckInWithRelations) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    authorId: row.authorId,
    completedText: row.completedText,
    unplannedText: row.unplannedText,
    blockersText: row.blockersText,
    planText: row.planText,
    helpText: row.helpText,
    dateKey: row.dateKey,
    submittedFor: row.submittedFor.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    user: row.user,
    author: row.author
  };
}

function serializeOneOnOne(row: OneOnOneWithRelations) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    managerId: row.managerId,
    participantId: row.participantId,
    title: row.title,
    cadenceDays: row.cadenceDays,
    nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null,
    lastMeetingId: row.lastMeetingId,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    manager: row.manager,
    participant: row.participant,
    lastMeeting: row.lastMeeting,
    _count: row._count
  };
}

function serializeAgendaItem(row: AgendaItemWithRelations) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    seriesId: row.seriesId,
    meetingId: row.meetingId,
    createdById: row.createdById,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    title: row.title,
    notes: row.notes,
    status: row.status,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    meeting: row.meeting
  };
}

function serializeMeetingActionItem(row: MeetingActionItemWithRelations) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    meetingId: row.meetingId,
    taskId: row.taskId,
    assigneeId: row.assigneeId,
    createdById: row.createdById,
    title: row.title,
    notes: row.notes,
    status: row.status,
    dueAt: row.dueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    assignee: row.assignee,
    createdBy: row.createdBy,
    task: row.task,
    meeting: row.meeting
  };
}

function severityRank(severity: AgendaCandidate['severity']): number {
  return { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 }[severity];
}

function titleFromAttentionPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const title = (payload as { title?: unknown }).title;
  return typeof title === 'string' ? title : null;
}

async function emitSyncEvent(
  actor: RequestActor,
  entityType: string,
  entityId: string,
  operation: string,
  payload: unknown,
  syncMutation?: SyncMutationMeta
): Promise<void> {
  const event = await prisma.$transaction((tx) => appendSyncEvent(tx, {
    workspaceId: actor.workspace.id,
    entityType,
    entityId,
    operation,
    actorId: actor.user.id,
    payload,
    mutation: syncMutation
  }));
  publishSyncEvent(event);
}
