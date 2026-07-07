import { prisma, type AttentionItem, type AttentionItemStatus, type Prisma } from '@taskara/db';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { buildMeetingAccessWhere, resolveMeetingAccessScope } from './meetings';
import { appendSyncEvent, publishSyncEvent, type SyncMutationMeta } from './sync';
import { getWorkHealthSummary, type WorkHealthAttentionItem } from './work-health';
import { resolveWorkspaceAccess, type WorkspaceAccess } from './team-access';

export const trackedAttentionReasons = [
  'overdue_task',
  'blocked_task',
  'review_waiting',
  'stale_task',
  'unassigned_due_soon',
  'overloaded_person',
  'person_without_active_work',
  'project_at_risk',
  'project_update_due',
  'missing_check_in',
  'one_on_one_due',
  'stale_meeting_action_item'
] as const;

type AttentionLifecycleAction = 'snoozed' | 'resolved' | 'dismissed';
type AttentionSeverity = WorkHealthAttentionItem['severity'];

const missingCheckInThresholdHours = 24;
const oneOnOneDueSoonHours = 7 * 24;
const staleActionItemHours = 7 * 24;

export interface AttentionListQuery {
  status?: AttentionItemStatus | 'ACTIVE' | 'ALL';
  includeSnoozed?: boolean;
  limit?: number;
  offset?: number;
  generate?: boolean;
}

export interface AttentionListResult {
  items: SerializedAttentionItem[];
  total: number;
  limit: number;
  offset: number;
  generatedAt: string | null;
}

export interface SerializedAttentionItem {
  id: string;
  workspaceId: string;
  assigneeId: string | null;
  managerId: string | null;
  entityType: string;
  entityId: string;
  reason: string;
  severity: string;
  status: AttentionItemStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  dismissalReason: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

interface AttentionCandidate {
  workspaceId: string;
  entityType: string;
  entityId: string;
  reason: string;
  severity: AttentionSeverity;
  assigneeId: string | null;
  payload: AttentionPayload;
}

interface AttentionPayload {
  version: 1;
  title: string;
  description: string;
  actionLabel: string;
  reason: string;
  severity: AttentionSeverity;
  entity: {
    type: string;
    id: string;
  };
  signal: {
    conditionKey: string;
    generatedAt: string;
    ageHours?: number;
    dueAt?: string | null;
  };
  task?: {
    id: string;
    key: string;
    title: string;
    status: string;
    priority: string;
    dueAt: string | null;
    assigneeId: string | null;
    projectId: string | null;
    projectName: string | null;
  };
  user?: {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string | null;
  };
  project?: {
    id: string;
    name: string;
    keyPrefix: string;
    teamId: string | null;
    teamName: string | null;
    leadId: string | null;
    healthUpdate: {
      id: string;
      health: string;
      summary: string;
      nextUpdateDueAt: string | null;
      createdAt: string;
    } | null;
  };
  oneOnOne?: {
    id: string;
    title: string | null;
    participantId: string;
    participantName: string;
    managerId: string;
    managerName: string;
    nextScheduledAt: string | null;
  };
  actionItem?: {
    id: string;
    title: string;
    dueAt: string | null;
    createdAt: string;
    assigneeId: string | null;
    assigneeName: string | null;
    meetingId: string;
    meetingTitle: string;
  };
  lifecycle?: {
    lastClearedAt?: string;
    manuallyResolvedAt?: string;
    dismissedAt?: string;
  };
}

export async function listAttentionItems(actor: RequestActor, query: AttentionListQuery = {}): Promise<AttentionListResult> {
  const now = new Date();
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  let generatedAt: string | null = null;

  if (query.generate !== false) {
    const generated = await synchronizeAttention(actor, now);
    generatedAt = generated.generatedAt;
  }

  const access = await resolveWorkspaceAccess(actor);
  const where = attentionWhereForList(actor, access, query, now);
  const [items, total] = await Promise.all([
    prisma.attentionItem.findMany({
      where,
      orderBy: [
        { severity: 'desc' },
        { lastSeenAt: 'desc' },
        { createdAt: 'desc' }
      ],
      take: limit,
      skip: offset
    }),
    prisma.attentionItem.count({ where })
  ]);

  return {
    items: items.map(serializeAttentionItem),
    total,
    limit,
    offset,
    generatedAt
  };
}

export async function synchronizeAttention(actor: RequestActor, now = new Date()): Promise<{ generatedAt: string; candidates: AttentionCandidate[] }> {
  const summary = await getWorkHealthSummary(actor, now);
  const access = await resolveWorkspaceAccess(actor);
  const candidates = [
    ...summary.attention.map((item) => attentionCandidateFromWorkHealth(actor.workspace.id, item, now)),
    ...await buildCadenceAttentionCandidates(actor, now)
  ];
  const candidateByKey = new Map(candidates.map((candidate) => [attentionKey(candidate), candidate]));
  const events = [];

  const existing = await prisma.attentionItem.findMany({
    where: {
      workspaceId: actor.workspace.id,
      reason: { in: [...trackedAttentionReasons] },
      ...(access.workspaceWide
        ? {}
        : {
            OR: [
              { assigneeId: actor.user.id },
              { managerId: actor.user.id },
              ...candidates.map((candidate) => uniqueAttentionWhere(candidate))
            ]
          })
    }
  });
  const existingByKey = new Map(existing.map((item) => [attentionKey(item), item]));

  for (const candidate of candidates) {
    const current = existingByKey.get(attentionKey(candidate));
    const event = current
      ? await updateExistingFromCandidate(actor, current, candidate, now)
      : await createAttentionFromCandidate(actor, candidate, now);
    if (event) events.push(event);
  }

  if (access.workspaceWide) {
    for (const current of existing) {
      if (candidateByKey.has(attentionKey(current))) continue;
      const event = await markAttentionConditionCleared(actor, current, now);
      if (event) events.push(event);
    }
  }

  for (const event of events) publishSyncEvent(event);
  return { generatedAt: summary.generatedAt, candidates };
}

export async function snoozeAttentionItem(
  actor: RequestActor,
  id: string,
  snoozedUntil: Date,
  syncMutation?: SyncMutationMeta
): Promise<SerializedAttentionItem> {
  if (snoozedUntil.getTime() <= Date.now()) {
    throw new HttpError(400, 'Snooze time must be in the future');
  }
  return updateAttentionLifecycle(actor, id, 'snoozed', {
    status: 'SNOOZED',
    snoozedUntil,
    resolvedAt: null,
    dismissedAt: null,
    dismissalReason: null
  }, syncMutation);
}

export async function resolveAttentionItem(
  actor: RequestActor,
  id: string,
  syncMutation?: SyncMutationMeta
): Promise<SerializedAttentionItem> {
  const now = new Date();
  return updateAttentionLifecycle(actor, id, 'resolved', {
    status: 'RESOLVED',
    resolvedAt: now,
    snoozedUntil: null,
    payload: mergePayloadLifecycle(undefined, { manuallyResolvedAt: now.toISOString() })
  }, syncMutation);
}

export async function dismissAttentionItem(
  actor: RequestActor,
  id: string,
  dismissalReason: string,
  syncMutation?: SyncMutationMeta
): Promise<SerializedAttentionItem> {
  const now = new Date();
  return updateAttentionLifecycle(actor, id, 'dismissed', {
    status: 'DISMISSED',
    dismissedAt: now,
    dismissalReason,
    snoozedUntil: null,
    payload: mergePayloadLifecycle(undefined, { dismissedAt: now.toISOString() })
  }, syncMutation);
}

export function serializeAttentionItem(item: AttentionItem): SerializedAttentionItem {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    assigneeId: item.assigneeId,
    managerId: item.managerId,
    entityType: item.entityType,
    entityId: item.entityId,
    reason: item.reason,
    severity: item.severity,
    status: item.status,
    firstSeenAt: item.firstSeenAt.toISOString(),
    lastSeenAt: item.lastSeenAt.toISOString(),
    snoozedUntil: item.snoozedUntil?.toISOString() ?? null,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
    dismissedAt: item.dismissedAt?.toISOString() ?? null,
    dismissalReason: item.dismissalReason,
    payload: item.payload,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString()
  };
}

async function buildCadenceAttentionCandidates(actor: RequestActor, now: Date): Promise<AttentionCandidate[]> {
  const [missingCheckIns, dueOneOnOnes, staleActionItems] = await Promise.all([
    isWorkspaceAdminRole(actor.role) ? buildMissingCheckInAttentionCandidates(actor, now) : Promise.resolve([]),
    buildDueOneOnOneAttentionCandidates(actor, now),
    buildStaleActionItemAttentionCandidates(actor, now)
  ]);
  return [...missingCheckIns, ...dueOneOnOnes, ...staleActionItems];
}

async function buildMissingCheckInAttentionCandidates(actor: RequestActor, now: Date): Promise<AttentionCandidate[]> {
  const [members, recent, scheduled] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id, role: { notIn: ['AGENT', 'GUEST'] } },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } }
    }),
    prisma.checkInResponse.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: { submittedFor: 'desc' },
      select: { userId: true, submittedFor: true }
    }),
    prisma.oneOnOneSeries.findMany({
      where: {
        workspaceId: actor.workspace.id,
        active: true,
        nextScheduledAt: { gt: now }
      },
      select: { participantId: true }
    })
  ]);
  const latestByUserId = new Map<string, Date>();
  for (const row of recent) {
    const current = latestByUserId.get(row.userId);
    if (!current || row.submittedFor > current) latestByUserId.set(row.userId, row.submittedFor);
  }
  const scheduledUserIds = new Set(scheduled.map((series) => series.participantId));

  return members.flatMap((member) => {
    if (scheduledUserIds.has(member.userId)) return [];
    const lastSubmittedFor = latestByUserId.get(member.userId) || null;
    if (!isCheckInMissing(lastSubmittedFor, now)) return [];
    const hours = lastSubmittedFor ? hoursBetween(lastSubmittedFor, now) : null;
    const severity: AttentionSeverity = hours === null || hours < 48 ? 'LOW' : hours >= 72 ? 'HIGH' : 'MEDIUM';
    return [candidateFromPayload({
      workspaceId: actor.workspace.id,
      entityType: 'user',
      entityId: member.userId,
      reason: 'missing_check_in',
      severity,
      assigneeId: member.userId,
      title: member.user.name,
      description: hours === null ? 'برای این فرد هنوز چک‌این ثبت نشده است.' : `${hours.toLocaleString('fa-IR')} ساعت از آخرین چک‌این این فرد گذشته است.`,
      actionLabel: 'برنامه‌ریزی چک‌این',
      conditionKey: ['missing_check_in', member.userId, lastSubmittedFor?.toISOString() || 'never', missingCheckInThresholdHours].join(':'),
      generatedAt: now,
      ageHours: hours ?? undefined,
      user: member.user
    })];
  });
}

async function buildDueOneOnOneAttentionCandidates(actor: RequestActor, now: Date): Promise<AttentionCandidate[]> {
  const rows = await prisma.oneOnOneSeries.findMany({
    where: {
      workspaceId: actor.workspace.id,
      active: true,
      OR: [
        { nextScheduledAt: null },
        { nextScheduledAt: { lte: new Date(now.getTime() + oneOnOneDueSoonHours * 60 * 60 * 1000) } }
      ],
      ...(isWorkspaceAdminRole(actor.role)
        ? {}
        : {
            AND: [
              {
                OR: [
                  { managerId: actor.user.id },
                  { participantId: actor.user.id }
                ]
              }
            ]
          })
    },
    include: {
      manager: { select: { id: true, name: true, email: true, avatarUrl: true } },
      participant: { select: { id: true, name: true, email: true, avatarUrl: true } }
    },
    take: 50
  });

  return rows
    .filter((series) => isOneOnOneDue(series.nextScheduledAt, now))
    .map((series) => {
      const overdue = series.nextScheduledAt ? series.nextScheduledAt.getTime() < now.getTime() : false;
      const severity: AttentionSeverity = overdue ? 'HIGH' : 'MEDIUM';
      return candidateFromPayload({
        workspaceId: actor.workspace.id,
        entityType: 'one_on_one',
        entityId: series.id,
        reason: 'one_on_one_due',
        severity,
        assigneeId: series.managerId,
        title: series.title || `۱:۱ با ${series.participant.name}`,
        description: series.nextScheduledAt ? 'زمان ۱:۱ نزدیک یا گذشته است.' : 'برای این ۱:۱ زمان بعدی ثبت نشده است.',
        actionLabel: 'باز کردن دستور جلسه',
        conditionKey: ['one_on_one_due', series.id, series.nextScheduledAt?.toISOString() || 'unscheduled', series.updatedAt.toISOString()].join(':'),
        generatedAt: now,
        dueAt: series.nextScheduledAt?.toISOString() ?? null,
        user: series.participant,
        oneOnOne: {
          id: series.id,
          title: series.title,
          participantId: series.participantId,
          participantName: series.participant.name,
          managerId: series.managerId,
          managerName: series.manager.name,
          nextScheduledAt: series.nextScheduledAt?.toISOString() ?? null
        }
      });
    });
}

async function buildStaleActionItemAttentionCandidates(actor: RequestActor, now: Date): Promise<AttentionCandidate[]> {
  const accessScope = await resolveMeetingAccessScope(actor);
  const meetingAccessWhere = buildMeetingAccessWhere(actor, accessScope);
  const staleCreatedBefore = new Date(now.getTime() - staleActionItemHours * 60 * 60 * 1000);
  const rows = await prisma.meetingActionItem.findMany({
    where: {
      workspaceId: actor.workspace.id,
      status: 'OPEN',
      taskId: null,
      OR: [
        { dueAt: { lt: now } },
        { dueAt: null, createdAt: { lte: staleCreatedBefore } }
      ],
      ...(isWorkspaceAdminRole(actor.role)
        ? {}
        : {
            AND: [
              {
                OR: [
                  { assigneeId: actor.user.id },
                  { createdById: actor.user.id },
                  { meeting: meetingAccessWhere }
                ]
              }
            ]
          })
    },
    include: {
      assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
      meeting: { select: { id: true, title: true } }
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    take: 50
  });

  return rows
    .filter((item) => isMeetingActionItemStale(item, now))
    .map((item) => {
      const dueOverdue = Boolean(item.dueAt && item.dueAt.getTime() < now.getTime());
      const ageHours = dueOverdue ? hoursBetween(item.dueAt!, now) : hoursBetween(item.createdAt, now);
      return candidateFromPayload({
        workspaceId: actor.workspace.id,
        entityType: 'meeting_action_item',
        entityId: item.id,
        reason: 'stale_meeting_action_item',
        severity: dueOverdue ? 'HIGH' : 'MEDIUM',
        assigneeId: item.assigneeId,
        title: item.title,
        description: dueOverdue ? 'موعد کار خروجی جلسه گذشته است.' : 'این کار خروجی جلسه چند روز باز مانده است.',
        actionLabel: 'باز کردن جلسه',
        conditionKey: ['stale_meeting_action_item', item.id, item.dueAt?.toISOString() || '', item.createdAt.toISOString()].join(':'),
        generatedAt: now,
        dueAt: item.dueAt?.toISOString() ?? null,
        ageHours,
        user: item.assignee || undefined,
        actionItem: {
          id: item.id,
          title: item.title,
          dueAt: item.dueAt?.toISOString() ?? null,
          createdAt: item.createdAt.toISOString(),
          assigneeId: item.assigneeId,
          assigneeName: item.assignee?.name || null,
          meetingId: item.meetingId,
          meetingTitle: item.meeting.title
        }
      });
    });
}

export function isCheckInMissing(lastSubmittedFor: Date | null | undefined, now: Date, thresholdHours = missingCheckInThresholdHours): boolean {
  if (!lastSubmittedFor) return true;
  return hoursBetween(lastSubmittedFor, now) >= thresholdHours;
}

export function isOneOnOneDue(nextScheduledAt: Date | null | undefined, now: Date, dueSoonHours = oneOnOneDueSoonHours): boolean {
  if (!nextScheduledAt) return true;
  return nextScheduledAt.getTime() <= now.getTime() + dueSoonHours * 60 * 60 * 1000;
}

export function isMeetingActionItemStale(
  item: { status: string; dueAt?: Date | null; createdAt: Date; taskId?: string | null },
  now: Date,
  staleHours = staleActionItemHours
): boolean {
  if (item.status !== 'OPEN') return false;
  if (item.taskId) return false;
  if (item.dueAt) return item.dueAt.getTime() < now.getTime();
  return hoursBetween(item.createdAt, now) >= staleHours;
}

export function attentionCandidateFromWorkHealth(workspaceId: string, item: WorkHealthAttentionItem, now: Date): AttentionCandidate {
  const entityId = item.task?.id || item.user?.id || item.project?.id;
  if (!entityId) {
    throw new Error(`Attention candidate ${item.reason} has no entity id`);
  }

  const task = item.task;
  const user = item.user;
  const project = item.project;
  return {
    workspaceId,
    entityType: item.entityType,
    entityId,
    reason: item.reason,
    severity: item.severity,
    assigneeId: task?.assignee?.id || user?.id || project?.lead?.id || null,
    payload: {
      version: 1,
      title: item.title,
      description: item.description,
      actionLabel: item.actionLabel,
      reason: item.reason,
      severity: item.severity,
      entity: { type: item.entityType, id: entityId },
      signal: {
        conditionKey: attentionConditionKey(item),
        generatedAt: now.toISOString(),
        ageHours: item.ageHours,
        dueAt: item.dueAt ?? null
      },
      ...(task
        ? {
            task: {
              id: task.id,
              key: task.key,
              title: task.title,
              status: task.status,
              priority: task.priority,
              dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null,
              assigneeId: task.assignee?.id || null,
              projectId: task.project?.id || null,
              projectName: task.project?.name || null
            }
          }
        : {}),
      ...(user
        ? {
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              avatarUrl: user.avatarUrl
            }
          }
        : {}),
      ...(project
        ? {
            project: {
              id: project.id,
              name: project.name,
              keyPrefix: project.keyPrefix,
              teamId: project.teamId,
              teamName: project.team?.name || null,
              leadId: project.lead?.id || null,
              healthUpdate: project.healthUpdates?.[0]
                ? {
                    id: project.healthUpdates[0].id,
                    health: project.healthUpdates[0].health,
                    summary: project.healthUpdates[0].summary,
                    nextUpdateDueAt: project.healthUpdates[0].nextUpdateDueAt?.toISOString() ?? null,
                    createdAt: project.healthUpdates[0].createdAt.toISOString()
                  }
                : null
            }
          }
        : {})
    }
  };
}

function candidateFromPayload(input: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  reason: string;
  severity: AttentionSeverity;
  assigneeId: string | null;
  title: string;
  description: string;
  actionLabel: string;
  conditionKey: string;
  generatedAt: Date;
  ageHours?: number;
  dueAt?: string | null;
  user?: AttentionPayload['user'];
  oneOnOne?: AttentionPayload['oneOnOne'];
  actionItem?: AttentionPayload['actionItem'];
}): AttentionCandidate {
  return {
    workspaceId: input.workspaceId,
    entityType: input.entityType,
    entityId: input.entityId,
    reason: input.reason,
    severity: input.severity,
    assigneeId: input.assigneeId,
    payload: {
      version: 1,
      title: input.title,
      description: input.description,
      actionLabel: input.actionLabel,
      reason: input.reason,
      severity: input.severity,
      entity: { type: input.entityType, id: input.entityId },
      signal: {
        conditionKey: input.conditionKey,
        generatedAt: input.generatedAt.toISOString(),
        ageHours: input.ageHours,
        dueAt: input.dueAt ?? null
      },
      ...(input.user ? { user: input.user } : {}),
      ...(input.oneOnOne ? { oneOnOne: input.oneOnOne } : {}),
      ...(input.actionItem ? { actionItem: input.actionItem } : {})
    }
  };
}

export function shouldReopenAttention(item: Pick<AttentionItem, 'status' | 'resolvedAt' | 'dismissedAt' | 'payload'>, candidate: AttentionCandidate): boolean {
  const payload = attentionPayload(item.payload);
  if (item.status === 'RESOLVED') {
    const lastClearedAt = dateFromString(payload?.lifecycle?.lastClearedAt);
    return Boolean(item.resolvedAt && lastClearedAt && lastClearedAt > item.resolvedAt);
  }
  if (item.status === 'DISMISSED') {
    return payload?.signal?.conditionKey !== candidate.payload.signal.conditionKey;
  }
  return false;
}

function attentionConditionKey(item: WorkHealthAttentionItem): string {
  if (item.task) {
    return [
      item.reason,
      item.task.id,
      item.task.status,
      item.task.priority,
      item.task.dueAt ? new Date(item.task.dueAt).toISOString() : '',
      item.task.updatedAt ? new Date(item.task.updatedAt).toISOString() : '',
      item.task.progressStartedAt || '',
      item.task.assignee?.id || ''
    ].join(':');
  }

  if (item.project) {
    const update = item.project.healthUpdates?.[0];
    return [
      item.reason,
      item.project.id,
      update?.id || '',
      update?.health || '',
      update?.nextUpdateDueAt?.toISOString() || '',
      item.title,
      item.description
    ].join(':');
  }

  return [
    item.reason,
    item.user?.id || '',
    item.title,
    item.description
  ].join(':');
}

async function createAttentionFromCandidate(actor: RequestActor, candidate: AttentionCandidate, now: Date) {
  const created = await prisma.$transaction(async (tx) => {
    const item = await tx.attentionItem.create({
      data: {
        workspaceId: candidate.workspaceId,
        assigneeId: candidate.assigneeId,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        reason: candidate.reason,
        severity: candidate.severity,
        status: 'OPEN',
        firstSeenAt: now,
        lastSeenAt: now,
        payload: toJson(candidate.payload)
      }
    });
    const event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'attention',
      entityId: item.id,
      operation: 'created',
      actorId: actor.user.id,
      payload: { after: serializeAttentionItem(item) }
    });
    return { item, event };
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'attention',
    entityId: created.item.id,
    action: 'created',
    after: serializeAttentionItem(created.item),
    source: actor.source
  }).catch(() => undefined);

  return created.event;
}

async function updateExistingFromCandidate(actor: RequestActor, current: AttentionItem, candidate: AttentionCandidate, now: Date) {
  if (current.status === 'DISMISSED' && !shouldReopenAttention(current, candidate)) return null;
  if (current.status === 'RESOLVED' && !shouldReopenAttention(current, candidate)) return null;

  const nextStatus: AttentionItemStatus =
    current.status === 'SNOOZED' && current.snoozedUntil && current.snoozedUntil <= now
      ? 'OPEN'
      : shouldReopenAttention(current, candidate)
        ? 'OPEN'
        : current.status;
  const currentPayload = attentionPayload(current.payload);
  const materialChanged =
    current.severity !== candidate.severity ||
    currentPayload?.signal?.conditionKey !== candidate.payload.signal.conditionKey ||
    currentPayload?.title !== candidate.payload.title ||
    nextStatus !== current.status;

  if (!materialChanged) {
    await prisma.attentionItem.update({
      where: { id: current.id },
      data: {
        lastSeenAt: now,
        assigneeId: candidate.assigneeId,
        payload: toJson({
          ...candidate.payload,
          lifecycle: currentPayload?.lifecycle
        })
      }
    });
    return null;
  }

  const before = serializeAttentionItem(current);
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.attentionItem.update({
      where: { id: current.id },
      data: {
        assigneeId: candidate.assigneeId,
        managerId: nextStatus === 'OPEN' && current.status !== 'OPEN' ? actor.user.id : current.managerId,
        severity: candidate.severity,
        status: nextStatus,
        firstSeenAt: nextStatus === 'OPEN' && current.status !== 'OPEN' ? now : current.firstSeenAt,
        lastSeenAt: now,
        snoozedUntil: nextStatus === 'OPEN' ? null : current.snoozedUntil,
        resolvedAt: nextStatus === 'OPEN' ? null : current.resolvedAt,
        dismissedAt: nextStatus === 'OPEN' ? null : current.dismissedAt,
        dismissalReason: nextStatus === 'OPEN' ? null : current.dismissalReason,
        payload: toJson({
          ...candidate.payload,
          lifecycle: nextStatus === 'OPEN' ? undefined : currentPayload?.lifecycle
        })
      }
    });
    const event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'attention',
      entityId: updated.id,
      operation: updated.status === 'OPEN' && current.status !== 'OPEN' ? 'reopened' : 'updated',
      actorId: actor.user.id,
      payload: { before, after: serializeAttentionItem(updated) }
    });
    return { updated, event };
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'attention',
    entityId: result.updated.id,
    action: result.updated.status === 'OPEN' && current.status !== 'OPEN' ? 'reopened' : 'updated',
    before,
    after: serializeAttentionItem(result.updated),
    source: actor.source
  }).catch(() => undefined);

  return result.event;
}

async function markAttentionConditionCleared(actor: RequestActor, current: AttentionItem, now: Date) {
  const payload = mergePayloadLifecycle(current.payload, { lastClearedAt: now.toISOString() });
  if (current.status !== 'OPEN' && current.status !== 'SNOOZED') {
    const currentPayload = attentionPayload(current.payload);
    const lastClearedAt = dateFromString(currentPayload?.lifecycle?.lastClearedAt);
    const decisionAt = current.resolvedAt || current.dismissedAt;
    if (lastClearedAt && decisionAt && lastClearedAt > decisionAt) return null;

    await prisma.attentionItem.update({
      where: { id: current.id },
      data: { payload }
    });
    return null;
  }

  const before = serializeAttentionItem(current);
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.attentionItem.update({
      where: { id: current.id },
      data: {
        status: 'RESOLVED',
        resolvedAt: now,
        snoozedUntil: null,
        payload
      }
    });
    const event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'attention',
      entityId: updated.id,
      operation: 'auto_resolved',
      actorId: actor.user.id,
      payload: { before, after: serializeAttentionItem(updated) }
    });
    return { updated, event };
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'attention',
    entityId: result.updated.id,
    action: 'auto_resolved',
    before,
    after: serializeAttentionItem(result.updated),
    source: actor.source
  }).catch(() => undefined);

  return result.event;
}

async function updateAttentionLifecycle(
  actor: RequestActor,
  id: string,
  action: AttentionLifecycleAction,
  data: Prisma.AttentionItemUpdateInput,
  syncMutation?: SyncMutationMeta
): Promise<SerializedAttentionItem> {
  const access = await resolveWorkspaceAccess(actor);
  const current = await prisma.attentionItem.findFirst({
    where: { id, ...attentionAccessWhere(actor, access) }
  });
  if (!current) throw new HttpError(404, 'Attention item not found');

  const before = serializeAttentionItem(current);
  const payload = data.payload === undefined
    ? toJson(current.payload ?? {})
    : mergePayloadLifecycle(current.payload, attentionPayload(data.payload)?.lifecycle || {});

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.attentionItem.update({
      where: { id: current.id },
      data: {
        ...data,
        payload,
        manager: { connect: { id: actor.user.id } }
      }
    });
    const event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'attention',
      entityId: updated.id,
      operation: action,
      actorId: actor.user.id,
      payload: { before, after: serializeAttentionItem(updated) },
      mutation: syncMutation
    });
    return { updated, event };
  });
  publishSyncEvent(result.event);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'attention',
    entityId: result.updated.id,
    action,
    before,
    after: serializeAttentionItem(result.updated),
    source: actor.source
  }).catch(() => undefined);

  return serializeAttentionItem(result.updated);
}

function attentionWhereForList(actor: RequestActor, access: WorkspaceAccess, query: AttentionListQuery, now: Date): Prisma.AttentionItemWhereInput {
  const accessWhere = attentionAccessWhere(actor, access);
  let statusWhere: Prisma.AttentionItemWhereInput;
  if (query.status && query.status !== 'ALL') {
    if (query.status === 'ACTIVE') {
      statusWhere = { OR: [{ status: 'OPEN' }, ...(query.includeSnoozed ? [{ status: 'SNOOZED' as const }] : [])] };
    } else {
      statusWhere = { status: query.status };
    }
    return { AND: [accessWhere, statusWhere] };
  }

  statusWhere = {
    OR: [
      { status: 'OPEN' },
      ...(query.includeSnoozed ? [{ status: 'SNOOZED' as const }] : [{ status: 'SNOOZED' as const, snoozedUntil: { lte: now } }])
    ]
  };
  return { AND: [accessWhere, statusWhere] };
}

function attentionAccessWhere(actor: RequestActor, access: WorkspaceAccess): Prisma.AttentionItemWhereInput {
  if (access.workspaceWide) return { workspaceId: actor.workspace.id };
  return {
    workspaceId: actor.workspace.id,
    OR: [
      { assigneeId: actor.user.id },
      { managerId: actor.user.id },
      { entityType: 'user', entityId: actor.user.id }
    ]
  };
}

function uniqueAttentionWhere(candidate: AttentionCandidate): Prisma.AttentionItemWhereInput {
  return {
    workspaceId: candidate.workspaceId,
    entityType: candidate.entityType,
    entityId: candidate.entityId,
    reason: candidate.reason
  };
}

function attentionKey(item: Pick<AttentionItem, 'workspaceId' | 'entityType' | 'entityId' | 'reason'> | AttentionCandidate): string {
  return `${item.workspaceId}:${item.entityType}:${item.entityId}:${item.reason}`;
}

function attentionPayload(value: unknown): AttentionPayload | null {
  if (!value || typeof value !== 'object') return null;
  return value as AttentionPayload;
}

function mergePayloadLifecycle(value: unknown, lifecycle: AttentionPayload['lifecycle'] = {}): Prisma.InputJsonValue {
  const payload = attentionPayload(value) || ({} as AttentionPayload);
  return toJson({
    ...payload,
    lifecycle: {
      ...(payload.lifecycle || {}),
      ...lifecycle
    }
  });
}

function dateFromString(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (60 * 60 * 1000)));
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
