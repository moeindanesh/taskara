import { prisma, type Prisma } from '@taskara/db';
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
import { logActivity } from './audit';
import { HttpError } from './http';
import { buildMeetingAccessWhere, canAccessMeeting, resolveMeetingAccessScope } from './meetings';
import { appendSyncEvent, publishSyncEvent, type SyncMutationMeta } from './sync';
import { createTask, ensureDefaultProject, serializeTaskForResponse } from './tasks';

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

export async function createCheckInResponse(actor: RequestActor, input: CreateCheckInInput, syncMutation?: SyncMutationMeta) {
  const targetUserId = input.userId || actor.user.id;
  if (targetUserId !== actor.user.id && !isWorkspaceAdminRole(actor.role)) {
    throw new HttpError(403, 'Only workspace admins can submit check-ins for another user');
  }
  await assertWorkspaceMember(actor.workspace.id, targetUserId);

  const row = await prisma.checkInResponse.create({
    data: {
      workspaceId: actor.workspace.id,
      userId: targetUserId,
      authorId: actor.user.id,
      completedText: input.completedText?.trim() || undefined,
      blockersText: input.blockersText?.trim() || undefined,
      planText: input.planText?.trim() || undefined,
      helpText: input.helpText?.trim() || undefined,
      submittedFor: input.submittedFor ? new Date(input.submittedFor) : undefined
    },
    include: checkInInclude
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'check_in',
    entityId: row.id,
    action: 'created',
    after: serializeCheckIn(row),
    source: actor.source
  }).catch(() => undefined);
  await emitSyncEvent(actor, 'check_in', row.id, 'created', { after: serializeCheckIn(row) }, syncMutation);

  return serializeCheckIn(row);
}

export async function listCheckIns(
  actor: RequestActor,
  input: { userId?: string; since?: string; limit?: number; offset?: number } = {}
) {
  const where: Prisma.CheckInResponseWhereInput = {
    workspaceId: actor.workspace.id,
    userId: isWorkspaceAdminRole(actor.role) ? input.userId : actor.user.id,
    submittedFor: input.since ? { gte: new Date(input.since) } : undefined
  };

  const [items, total] = await Promise.all([
    prisma.checkInResponse.findMany({
      where,
      include: checkInInclude,
      orderBy: [{ submittedFor: 'desc' }, { createdAt: 'desc' }],
      take: input.limit ?? 50,
      skip: input.offset ?? 0
    }),
    prisma.checkInResponse.count({ where })
  ]);

  return {
    items: items.map(serializeCheckIn),
    total,
    limit: input.limit ?? 50,
    offset: input.offset ?? 0
  };
}

export async function listMissingCheckIns(actor: RequestActor, hours = 24, now = new Date()) {
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace admin access required');
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const [members, recent] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id, role: { notIn: ['AGENT', 'GUEST'] } },
      include: { user: { select: userSelect } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }]
    }),
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

async function assertWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true }
  });
  if (!member) throw new HttpError(400, 'User must belong to this workspace');
}

function serializeCheckIn(row: CheckInWithRelations) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    authorId: row.authorId,
    completedText: row.completedText,
    blockersText: row.blockersText,
    planText: row.planText,
    helpText: row.helpText,
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
