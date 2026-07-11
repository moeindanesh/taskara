import {
  prisma,
  Prisma,
  type Milestone,
  type SyncEvent
} from '@taskara/db';
import type { z } from 'zod';
import type {
  createMilestoneSchema,
  milestoneCompletionSchema,
  milestoneListQuerySchema,
  milestoneOwnerCandidateQuerySchema,
  milestoneTransitionSchema,
  reorderMilestoneSchema,
  updateMilestoneSchema
} from '@taskara/shared';
import { type RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { serializeTaskAttachment } from './task-attachments';
import {
  appendSyncEvent,
  lockWorkspaceSyncState,
  publishSyncEvent,
  type SyncMutationMeta
} from './sync';
import {
  assertCanManageProjectPlanning,
  canManageProjectPlanning,
  projectWhereForAccess,
  resolveWorkspaceAccess,
  type WorkspaceAccess
} from './team-access';

type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
type MilestoneListInput = z.infer<typeof milestoneListQuerySchema>;
type MilestoneOwnerCandidateInput = z.infer<typeof milestoneOwnerCandidateQuerySchema>;
type ReorderMilestoneInput = z.infer<typeof reorderMilestoneSchema>;
type MilestoneTransitionInput = z.infer<typeof milestoneTransitionSchema>;
type MilestoneCompletionInput = z.infer<typeof milestoneCompletionSchema>;

const positionStep = 1024;
const terminalStatuses = new Set(['COMPLETED', 'CANCELED']);
const selectableStatuses = new Set(['PLANNED', 'ACTIVE']);
const completedTaskStatuses = new Set(['DONE']);
const canceledTaskStatuses = new Set(['CANCELED']);

const milestoneUserSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

export const milestoneInclude = {
  owner: { select: milestoneUserSelect },
  project: {
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      teamId: true,
      leadId: true,
      team: { select: { id: true, name: true, slug: true } },
      lead: { select: milestoneUserSelect }
    }
  }
} satisfies Prisma.MilestoneInclude;

const milestoneTaskSyncInclude = {
  project: {
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      parentId: true,
      team: { select: { id: true, name: true, slug: true } }
    }
  },
  milestone: {
    select: {
      id: true,
      name: true,
      kind: true,
      status: true,
      archivedAt: true,
      projectId: true
    }
  },
  assignee: { select: { id: true, name: true, email: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  reporter: { select: { id: true, name: true, email: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  attachments: { where: { commentId: null }, orderBy: { createdAt: 'asc' } },
  labels: { include: { label: true } },
  triageState: {
    select: {
      id: true,
      status: true,
      requestedInfo: true,
      snoozedUntil: true,
      reason: true,
      decidedById: true,
      createdAt: true,
      updatedAt: true
    }
  },
  _count: { select: { comments: true, subtasks: true, blockingDependencies: true, attachments: true } }
} satisfies Prisma.TaskInclude;

type MilestoneTaskSyncShape = Prisma.TaskGetPayload<{ include: typeof milestoneTaskSyncInclude }>;

export type MilestoneWithRelations = Prisma.MilestoneGetPayload<{ include: typeof milestoneInclude }>;

export interface MilestoneProgressSummary {
  totalTasks: number;
  eligibleTasks: number;
  completedTasks: number;
  canceledTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  totalWeight: number;
  completedWeight: number;
  percentage: number | null;
}

export interface LockedMilestoneState {
  id: string;
  workspaceId: string;
  projectId: string;
  status: string;
  archivedAt: Date | null;
  version: number;
}

/**
 * Serializes every task-to-milestone relation change with milestone lifecycle
 * transitions. Callers must pass every source and target milestone and acquire
 * no milestone locks beforehand; the stable id order prevents cross-move
 * deadlocks.
 */
export async function lockMilestonesForUpdate(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  milestoneIds: Array<string | null | undefined>
): Promise<Map<string, LockedMilestoneState>> {
  const ids = [...new Set(milestoneIds.filter((id): id is string => Boolean(id)))].sort();
  if (!ids.length) return new Map();

  const rows = await tx.$queryRaw<LockedMilestoneState[]>(Prisma.sql`
    SELECT
      "id",
      "workspaceId",
      "projectId",
      "status"::text AS "status",
      "archivedAt",
      "version"
    FROM "Milestone"
    WHERE "workspaceId" = ${workspaceId}::uuid
      AND "id" = ANY(ARRAY[${Prisma.join(ids)}]::uuid[])
    ORDER BY "id"
    FOR UPDATE
  `);
  return new Map(rows.map((row) => [row.id, row]));
}

type TaskAggregateClient = Pick<Prisma.TransactionClient, 'task'>;

export async function milestoneProgressById(
  client: TaskAggregateClient,
  milestoneIds: string[]
): Promise<Map<string, MilestoneProgressSummary>> {
  const uniqueIds = [...new Set(milestoneIds.filter(Boolean))];
  const result = new Map<string, MilestoneProgressSummary>();
  for (const id of uniqueIds) result.set(id, emptyProgress());
  if (!uniqueIds.length) return result;

  const [statusGroups, overdueGroups] = await Promise.all([
    client.task.groupBy({
      by: ['milestoneId', 'status'],
      where: { milestoneId: { in: uniqueIds } },
      _count: { _all: true },
      _sum: { weight: true }
    }),
    client.task.groupBy({
      by: ['milestoneId'],
      where: {
        milestoneId: { in: uniqueIds },
        dueAt: { lt: new Date() },
        status: { notIn: ['DONE', 'CANCELED'] }
      },
      _count: { _all: true }
    })
  ]);

  for (const group of statusGroups) {
    if (!group.milestoneId) continue;
    const progress = result.get(group.milestoneId) || emptyProgress();
    const count = group._count._all;
    const weight = group._sum.weight || 0;
    progress.totalTasks += count;
    if (canceledTaskStatuses.has(group.status)) {
      progress.canceledTasks += count;
    } else {
      progress.eligibleTasks += count;
      progress.totalWeight += weight;
    }
    if (completedTaskStatuses.has(group.status)) {
      progress.completedTasks += count;
      progress.completedWeight += weight;
    }
    if (group.status === 'BLOCKED') progress.blockedTasks += count;
    result.set(group.milestoneId, progress);
  }

  for (const group of overdueGroups) {
    if (!group.milestoneId) continue;
    const progress = result.get(group.milestoneId) || emptyProgress();
    progress.overdueTasks = group._count._all;
    result.set(group.milestoneId, progress);
  }

  for (const progress of result.values()) {
    progress.percentage = progress.eligibleTasks
      ? Math.round((progress.completedTasks / progress.eligibleTasks) * 100)
      : null;
  }
  return result;
}

export async function listMilestones(actor: RequestActor, input: MilestoneListInput) {
  const access = await resolveWorkspaceAccess(actor);
  const where: Prisma.MilestoneWhereInput = {
    workspaceId: actor.workspace.id,
    project: {
      ...projectWhereForAccess(access),
      ...(input.teamId ? { teamId: input.teamId } : {})
    },
    projectId: input.projectId,
    ownerId: input.ownerId === 'none' ? null : input.ownerId,
    kind: input.kind,
    status: input.status ? { in: input.status } : undefined,
    health: input.health === 'none' ? null : input.health,
    archivedAt: input.archivedOnly ? { not: null } : input.includeArchived ? undefined : null,
    targetOn: input.overdue ? { lt: todayDate() } : undefined,
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { description: { contains: input.q, mode: 'insensitive' } },
            { project: { name: { contains: input.q, mode: 'insensitive' } } }
          ]
        }
      : {})
  };
  if (input.overdue) {
    where.status = input.status ? { in: input.status.filter((status) => selectableStatuses.has(status)) } : { in: ['PLANNED', 'ACTIVE'] };
  }

  const total = await prisma.milestone.count({ where });
  const rows = input.overdue
    ? await listMilestoneRows(where, input.offset, input.limit)
    : await listMilestonePageWithOverdueFirst(where, input.offset, input.limit);
  const progress = await milestoneProgressById(prisma, rows.map((row) => row.id));
  const items = rows
    .map((row) => serializeMilestone(row, progress.get(row.id) || emptyProgress(), canManageProjectPlanning(actor, access, row.project)));

  return { items, total, limit: input.limit, offset: input.offset };
}

const milestoneListOrder = [
  { health: { sort: 'desc', nulls: 'last' } },
  { targetOn: { sort: 'asc', nulls: 'last' } },
  { project: { name: 'asc' } },
  { projectId: 'asc' },
  { position: 'asc' },
  { updatedAt: 'desc' },
  { id: 'asc' }
] satisfies Prisma.MilestoneOrderByWithRelationInput[];

async function listMilestoneRows(where: Prisma.MilestoneWhereInput, skip: number, take: number) {
  if (take <= 0) return [];
  return prisma.milestone.findMany({
    where,
    include: milestoneInclude,
    orderBy: milestoneListOrder,
    skip,
    take
  });
}

async function listMilestonePageWithOverdueFirst(
  where: Prisma.MilestoneWhereInput,
  offset: number,
  limit: number
): Promise<MilestoneWithRelations[]> {
  const overduePredicate: Prisma.MilestoneWhereInput = {
    status: { in: ['PLANNED', 'ACTIVE'] },
    targetOn: { lt: todayDate() }
  };
  const overdueWhere: Prisma.MilestoneWhereInput = { AND: [where, overduePredicate] };
  const regularWhere: Prisma.MilestoneWhereInput = {
    AND: [
      where,
      {
        OR: [
          { status: { notIn: ['PLANNED', 'ACTIVE'] } },
          { targetOn: null },
          { targetOn: { gte: todayDate() } }
        ]
      }
    ]
  };
  const overdueCount = await prisma.milestone.count({ where: overdueWhere });
  const overdueTake = offset < overdueCount ? Math.min(limit, overdueCount - offset) : 0;
  const regularTake = limit - overdueTake;
  const regularSkip = Math.max(0, offset - overdueCount);
  const [overdueRows, regularRows] = await Promise.all([
    listMilestoneRows(overdueWhere, offset, overdueTake),
    listMilestoneRows(regularWhere, regularSkip, regularTake)
  ]);
  return [...overdueRows, ...regularRows];
}

export async function getMilestone(actor: RequestActor, milestoneId: string) {
  const access = await resolveWorkspaceAccess(actor);
  const row = await prisma.milestone.findFirst({
    where: {
      id: milestoneId,
      workspaceId: actor.workspace.id,
      project: projectWhereForAccess(access)
    },
    include: milestoneInclude
  });
  if (!row) throw new HttpError(404, 'Milestone not found');
  const progress = await milestoneProgressById(prisma, [row.id]);
  return serializeMilestone(row, progress.get(row.id) || emptyProgress(), canManageProjectPlanning(actor, access, row.project));
}

export async function listMilestonesForSync(
  actor: RequestActor,
  access: WorkspaceAccess,
  completedWindowDays: number
) {
  const terminalCutoff = new Date(Date.now() - completedWindowDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.milestone.findMany({
    where: {
      workspaceId: actor.workspace.id,
      archivedAt: null,
      project: projectWhereForAccess(access),
      OR: [
        { status: { in: ['PLANNED', 'ACTIVE'] } },
        { status: { in: ['COMPLETED', 'CANCELED'] }, updatedAt: { gte: terminalCutoff } }
      ]
    },
    include: milestoneInclude,
    orderBy: [{ updatedAt: 'desc' }]
  });
  const progress = await milestoneProgressById(prisma, rows.map((row) => row.id));
  return rows
    .map((row) => serializeMilestone(row, progress.get(row.id) || emptyProgress(), canManageProjectPlanning(actor, access, row.project)))
    .sort(compareMilestoneSummaries);
}

export async function listMilestoneOwnerCandidates(actor: RequestActor, input: MilestoneOwnerCandidateInput) {
  const access = await resolveWorkspaceAccess(actor);
  const project = await prisma.project.findFirst({
    where: { ...projectWhereForAccess(access), id: input.projectId },
    select: { id: true, teamId: true, leadId: true }
  });
  if (!project) throw new HttpError(404, 'Project not found');

  const where: Prisma.WorkspaceMemberWhereInput = {
    workspaceId: actor.workspace.id,
    ...(input.q
      ? { user: { OR: [{ name: { contains: input.q, mode: 'insensitive' } }, { email: { contains: input.q, mode: 'insensitive' } }] } }
      : {}),
    ...(project.teamId
      ? {
          OR: [
            { role: { in: ['OWNER', 'ADMIN'] } },
            ...(project.leadId ? [{ userId: project.leadId }] : []),
            { user: { projectMemberships: { some: { projectId: project.id } } } },
            { user: { teamMemberships: { some: { teamId: project.teamId } } } }
          ]
        }
      : {})
  };

  const [members, total] = await Promise.all([
    prisma.workspaceMember.findMany({
      where,
    include: {
      user: {
        select: milestoneUserSelect
      }
    },
      orderBy: [{ user: { name: 'asc' } }, { user: { email: 'asc' } }],
      take: input.limit
    }),
    prisma.workspaceMember.count({ where })
  ]);

  const items = members
    .map((member) => ({
      id: member.user.id,
      name: member.user.name,
      email: member.user.email,
      avatarUrl: member.user.avatarUrl
    }));
  return { items, total, limit: input.limit };
}

export async function createMilestone(
  actor: RequestActor,
  input: CreateMilestoneInput,
  syncMutation?: SyncMutationMeta
) {
  await assertCanManageProjectPlanning(actor, input.projectId);
  let event: SyncEvent | null = null;
  const row = await prisma.$transaction(async (tx) => {
    if (input.id && await tx.milestone.findUnique({ where: { id: input.id }, select: { id: true } })) {
      throw new HttpError(409, 'Milestone id already exists');
    }
    await assertMilestoneOwner(tx, actor.workspace.id, input.projectId, input.ownerId);
    await lockMilestoneOrdering(tx, input.projectId);
    const last = await tx.milestone.findFirst({
      where: { projectId: input.projectId, archivedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true }
    });
    const created = await tx.milestone.create({
      data: {
        id: input.id,
        workspaceId: actor.workspace.id,
        projectId: input.projectId,
        ownerId: input.ownerId,
        name: input.name,
        description: input.description,
        kind: input.kind,
        status: input.status,
        health: input.health,
        startsOn: parseDate(input.startsOn),
        targetOn: parseDate(input.targetOn),
        position: (last?.position || 0) + positionStep
      },
      include: milestoneInclude
    }).catch(milestoneCreateConflict);
    const summary = serializeMilestone(created, emptyProgress(), true);
    event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'milestone',
      entityId: created.id,
      operation: 'created',
      entityVersion: created.version,
      actorId: actor.user.id,
      payload: { after: summary, changedFields: Object.keys(input) },
      mutation: syncMutation
    });
    return created;
  });
  if (event) publishSyncEvent(event);
  const summary = serializeMilestone(row, emptyProgress(), true);
  await logMilestoneActivity(actor, row.id, 'created', undefined, summary);
  return summary;
}

export async function updateMilestone(
  actor: RequestActor,
  milestoneId: string,
  input: UpdateMilestoneInput,
  syncMutation?: SyncMutationMeta
) {
  const existing = await requireManageableMilestone(actor, milestoneId);
  assertMutable(existing);
  assertVersion(existing, input.version);
  const startsOn = input.startsOn === undefined ? formatDate(existing.startsOn) : input.startsOn;
  const targetOn = input.targetOn === undefined ? formatDate(existing.targetOn) : input.targetOn;
  assertDateRange(startsOn, targetOn);

  let event: SyncEvent | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    if (input.ownerId !== undefined) await assertMilestoneOwner(tx, actor.workspace.id, existing.projectId, input.ownerId);
    const row = await tx.milestone.update({
      where: { id: existing.id, version: existing.version },
      data: {
        name: input.name,
        description: input.description,
        kind: input.kind,
        ownerId: input.ownerId,
        health: input.health,
        startsOn: input.startsOn === undefined ? undefined : parseDate(input.startsOn),
        targetOn: input.targetOn === undefined ? undefined : parseDate(input.targetOn),
        version: { increment: 1 }
      },
      include: milestoneInclude
    }).catch(versionConflict);
    await lockWorkspaceSyncState(tx, actor.workspace.id);
    const progress = await milestoneProgressById(tx, [row.id]);
    const summary = serializeMilestone(row, progress.get(row.id) || emptyProgress(), true);
    event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'milestone',
      entityId: row.id,
      operation: 'updated',
      entityVersion: row.version,
      actorId: actor.user.id,
      payload: {
        before: serializeMilestone(existing, progress.get(row.id) || emptyProgress(), true),
        after: summary,
        changedFields: Object.keys(input).filter((key) => key !== 'version')
      },
      mutation: syncMutation
    });
    return { row, summary };
  });
  if (event) publishSyncEvent(event);
  await logMilestoneActivity(actor, milestoneId, 'updated', existing, updated.summary);
  return updated.summary;
}

export async function reorderMilestone(
  actor: RequestActor,
  milestoneId: string,
  input: ReorderMilestoneInput,
  syncMutation?: SyncMutationMeta
) {
  const existing = await requireManageableMilestone(actor, milestoneId);
  assertMutable(existing);
  assertVersion(existing, input.version);
  let events: SyncEvent[] = [];
  const result = await prisma.$transaction(async (tx) => {
    const changedRows = await positionMilestone(tx, existing, input);
    await lockWorkspaceSyncState(tx, actor.workspace.id);
    const progress = await milestoneProgressById(tx, changedRows.map((row) => row.id));
    const summaries = changedRows.map((row) => serializeMilestone(row, progress.get(row.id) || emptyProgress(), true));
    events = [];
    for (const summary of summaries) {
      events.push(await appendSyncEvent(tx, {
        workspaceId: actor.workspace.id,
        entityType: 'milestone',
        entityId: summary.id,
        operation: 'reordered',
        entityVersion: summary.version,
        actorId: actor.user.id,
        payload: { after: summary, changedFields: ['position'] },
        mutation: summary.id === milestoneId ? syncMutation : undefined
      }));
    }
    return summaries.find((summary) => summary.id === milestoneId)!;
  });
  for (const event of events) publishSyncEvent(event);
  await logMilestoneActivity(actor, milestoneId, 'reordered', existing, result);
  return result;
}

export async function activateMilestone(actor: RequestActor, milestoneId: string, input: MilestoneTransitionInput, syncMutation?: SyncMutationMeta) {
  return transitionMilestone(actor, milestoneId, input, ['PLANNED', 'CANCELED'], 'ACTIVE', 'activated', syncMutation);
}

export async function reopenMilestone(actor: RequestActor, milestoneId: string, input: MilestoneTransitionInput, syncMutation?: SyncMutationMeta) {
  return transitionMilestone(actor, milestoneId, input, ['COMPLETED'], 'ACTIVE', 'reopened', syncMutation);
}

export async function completeMilestone(actor: RequestActor, milestoneId: string, input: MilestoneCompletionInput, syncMutation?: SyncMutationMeta) {
  return finishMilestone(actor, milestoneId, input, 'COMPLETED', 'completed', syncMutation);
}

export async function cancelMilestone(actor: RequestActor, milestoneId: string, input: MilestoneCompletionInput, syncMutation?: SyncMutationMeta) {
  return finishMilestone(actor, milestoneId, input, 'CANCELED', 'canceled', syncMutation);
}

export async function archiveMilestone(actor: RequestActor, milestoneId: string, input: MilestoneTransitionInput, syncMutation?: SyncMutationMeta) {
  const existing = await requireManageableMilestone(actor, milestoneId);
  if (existing.archivedAt) throw new HttpError(409, 'Milestone is already archived');
  if (!terminalStatuses.has(existing.status)) throw new HttpError(409, 'Only completed or canceled milestones can be archived');
  assertVersion(existing, input.version);
  let event: SyncEvent | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.milestone.update({
      where: { id: existing.id, version: existing.version },
      data: { archivedAt: new Date(), version: { increment: 1 } },
      include: milestoneInclude
    }).catch(versionConflict);
    event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'milestone',
      entityId: row.id,
      operation: 'archived',
      entityVersion: row.version,
      actorId: actor.user.id,
      payload: { before: serializeMilestone(existing, emptyProgress(), true), changedFields: ['archivedAt'] },
      mutation: syncMutation
    });
    const progress = await milestoneProgressById(tx, [row.id]);
    return serializeMilestone(row, progress.get(row.id) || emptyProgress(), true);
  });
  if (event) publishSyncEvent(event);
  await logMilestoneActivity(actor, milestoneId, 'archived', existing, updated);
  return updated;
}

export async function restoreMilestone(actor: RequestActor, milestoneId: string, input: MilestoneTransitionInput, syncMutation?: SyncMutationMeta) {
  const existing = await requireManageableMilestone(actor, milestoneId);
  if (!existing.archivedAt) throw new HttpError(409, 'Milestone is not archived');
  assertVersion(existing, input.version);
  let event: SyncEvent | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.milestone.update({
      where: { id: existing.id, version: existing.version },
      data: { archivedAt: null, version: { increment: 1 } },
      include: milestoneInclude
    }).catch(versionConflict);
    await lockWorkspaceSyncState(tx, actor.workspace.id);
    const progress = await milestoneProgressById(tx, [row.id]);
    const summary = serializeMilestone(row, progress.get(row.id) || emptyProgress(), true);
    event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'milestone',
      entityId: row.id,
      operation: 'restored',
      entityVersion: row.version,
      actorId: actor.user.id,
      payload: { after: summary, changedFields: ['archivedAt'] },
      mutation: syncMutation
    });
    return summary;
  });
  if (event) publishSyncEvent(event);
  await logMilestoneActivity(actor, milestoneId, 'restored', existing, updated);
  return updated;
}

export async function appendMilestoneProgressSyncEvents(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; actorId?: string | null; milestoneIds: Array<string | null | undefined> }
): Promise<SyncEvent[]> {
  const ids = [...new Set(input.milestoneIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  await lockWorkspaceSyncState(tx, input.workspaceId);
  const rows = await tx.milestone.findMany({
    where: { id: { in: ids }, workspaceId: input.workspaceId },
    include: milestoneInclude
  });
  const progress = await milestoneProgressById(tx, rows.map((row) => row.id));
  const events: SyncEvent[] = [];
  for (const row of rows) {
    const summary = serializeMilestone(row, progress.get(row.id) || emptyProgress());
    events.push(await appendSyncEvent(tx, {
      workspaceId: input.workspaceId,
      entityType: 'milestone',
      entityId: row.id,
      operation: 'progress_updated',
      entityVersion: row.version,
      actorId: input.actorId,
      payload: row.archivedAt
        ? { before: summary, changedFields: ['progress'], reason: 'archived_resource_tombstone' }
        : { after: summary, changedFields: ['progress'] }
    }));
  }
  return events;
}

export function serializeMilestone(
  row: MilestoneWithRelations,
  progress: MilestoneProgressSummary,
  canManage?: boolean
) {
  const attentionReasons: Array<{ reason: string; count?: number }> = [];
  if (!terminalStatuses.has(row.status) && row.targetOn && row.targetOn < todayDate()) attentionReasons.push({ reason: 'target_overdue' });
  if (progress.blockedTasks) attentionReasons.push({ reason: 'blocked_tasks', count: progress.blockedTasks });
  if (progress.overdueTasks) attentionReasons.push({ reason: 'overdue_tasks', count: progress.overdueTasks });
  if (!row.ownerId) attentionReasons.push({ reason: 'owner_missing' });
  if (!row.targetOn) attentionReasons.push({ reason: 'target_missing' });
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    kind: row.kind,
    status: row.status,
    health: row.health,
    startsOn: formatDate(row.startsOn),
    targetOn: formatDate(row.targetOn),
    position: row.position,
    version: row.version,
    completedAt: row.completedAt?.toISOString() ?? null,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    project: row.project,
    owner: row.owner,
    progress,
    attentionReasons,
    readyToComplete: progress.eligibleTasks > 0 && progress.completedTasks === progress.eligibleTasks,
    ...(canManage === undefined ? {} : { canManage })
  };
}

async function transitionMilestone(
  actor: RequestActor,
  milestoneId: string,
  input: MilestoneTransitionInput,
  from: string[],
  to: 'ACTIVE',
  action: string,
  syncMutation?: SyncMutationMeta
) {
  const existing = await requireManageableMilestone(actor, milestoneId);
  assertMutable(existing);
  if (!from.includes(existing.status)) throw new HttpError(409, `Milestone cannot be ${action} from ${existing.status}`);
  assertVersion(existing, input.version);
  let event: SyncEvent | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.milestone.update({
      where: { id: existing.id, version: existing.version },
      data: { status: to, completedAt: null, canceledAt: null, version: { increment: 1 } },
      include: milestoneInclude
    }).catch(versionConflict);
    await lockWorkspaceSyncState(tx, actor.workspace.id);
    const progress = await milestoneProgressById(tx, [row.id]);
    const summary = serializeMilestone(row, progress.get(row.id) || emptyProgress(), true);
    event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'milestone',
      entityId: row.id,
      operation: action,
      entityVersion: row.version,
      actorId: actor.user.id,
      payload: { before: serializeMilestone(existing, progress.get(row.id) || emptyProgress(), true), after: summary, changedFields: ['status', 'completedAt', 'canceledAt'] },
      mutation: syncMutation
    });
    return summary;
  });
  if (event) publishSyncEvent(event);
  await logMilestoneActivity(actor, milestoneId, action, existing, updated);
  return updated;
}

async function finishMilestone(
  actor: RequestActor,
  milestoneId: string,
  input: MilestoneCompletionInput,
  status: 'COMPLETED' | 'CANCELED',
  action: string,
  syncMutation?: SyncMutationMeta
) {
  const existing = await requireManageableMilestone(actor, milestoneId);
  assertMutable(existing);
  if (!selectableStatuses.has(existing.status)) throw new HttpError(409, `Milestone cannot be ${action} from ${existing.status}`);
  assertVersion(existing, input.version);
  let events: SyncEvent[] = [];
  let taskAudits: Array<{ id: string; before: MilestoneTaskSyncShape; after: MilestoneTaskSyncShape }> = [];
  const result = await prisma.$transaction(async (tx) => {
    const lockedMilestones = await lockMilestonesForUpdate(tx, actor.workspace.id, [
      existing.id,
      input.unfinishedTaskPolicy === 'MOVE' ? input.targetMilestoneId : null
    ]);
    const lockedSource = lockedMilestones.get(existing.id);
    if (!lockedSource) throw new HttpError(404, 'Milestone not found');
    if (lockedSource.version !== existing.version) throw new HttpError(409, 'Milestone changed on another client');
    if (lockedSource.archivedAt || !selectableStatuses.has(lockedSource.status)) {
      throw new HttpError(409, `Milestone cannot be ${action} from ${lockedSource.status}`);
    }

    // Lock the current unfinished scope after the milestone row. New
    // assignments and task relation changes also lock the milestone first, so
    // no task can enter or leave the disposition snapshot behind our back.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Task"
      WHERE "milestoneId" = ${existing.id}::uuid
        AND "status"::text NOT IN ('DONE', 'CANCELED')
      ORDER BY "id"
      FOR UPDATE
    `;
    const unfinished = await tx.task.findMany({
      where: { milestoneId: existing.id, status: { notIn: ['DONE', 'CANCELED'] } },
      include: milestoneTaskSyncInclude
    });
    if (unfinished.length && !input.unfinishedTaskPolicy) {
      throw new HttpError(409, 'Unfinished tasks require KEEP, MOVE, or UNASSIGN policy');
    }
    let target: MilestoneWithRelations | null = null;
    if (input.unfinishedTaskPolicy === 'MOVE') {
      const lockedTarget = input.targetMilestoneId
        ? lockedMilestones.get(input.targetMilestoneId)
        : undefined;
      if (
        !lockedTarget
        || lockedTarget.id === existing.id
        || lockedTarget.projectId !== existing.projectId
        || lockedTarget.archivedAt
        || !selectableStatuses.has(lockedTarget.status)
      ) {
        throw new HttpError(400, 'Target milestone must be open and in the same project');
      }
      target = await tx.milestone.findFirst({
        where: {
          id: lockedTarget.id,
          workspaceId: actor.workspace.id,
          projectId: existing.projectId,
          archivedAt: null,
          status: { in: ['PLANNED', 'ACTIVE'] },
          NOT: { id: existing.id }
        },
        include: milestoneInclude
      });
      if (!target) throw new HttpError(400, 'Target milestone must be open and in the same project');
    }

    events = [];
    taskAudits = [];
    const nextMilestoneId = input.unfinishedTaskPolicy === 'MOVE' ? target!.id : null;
    if (input.unfinishedTaskPolicy === 'MOVE' || input.unfinishedTaskPolicy === 'UNASSIGN') {
      for (const before of unfinished) {
        const after = await tx.task.update({
          where: { id: before.id },
          data: { milestoneId: nextMilestoneId, version: { increment: 1 } },
          include: milestoneTaskSyncInclude
        });
        taskAudits.push({ id: after.id, before, after });
        events.push(await appendSyncEvent(tx, {
          workspaceId: actor.workspace.id,
          entityType: 'task',
          entityId: after.id,
          operation: 'updated',
          entityVersion: after.version,
          actorId: actor.user.id,
          payload: {
            before: serializeMilestoneTaskForSync(before),
            after: serializeMilestoneTaskForSync(after),
            changedFields: ['milestoneId'],
            reason: `milestone_${action}`
          }
        }));
      }
    }

    const now = new Date();
    const row = await tx.milestone.update({
      where: { id: existing.id, version: existing.version },
      data: {
        status,
        completedAt: status === 'COMPLETED' ? now : null,
        canceledAt: status === 'CANCELED' ? now : null,
        version: { increment: 1 }
      },
      include: milestoneInclude
    }).catch(versionConflict);
    await lockWorkspaceSyncState(tx, actor.workspace.id);
    const progress = await milestoneProgressById(tx, [row.id, target?.id || ''].filter(Boolean));
    const summary = serializeMilestone(row, progress.get(row.id) || emptyProgress(), true);
    events.push(await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'milestone',
      entityId: row.id,
      operation: action,
      entityVersion: row.version,
      actorId: actor.user.id,
      payload: {
        before: serializeMilestone(existing, progress.get(row.id) || emptyProgress(), true),
        after: summary,
        changedFields: ['status', 'completedAt', 'canceledAt'],
        unfinishedTaskPolicy: input.unfinishedTaskPolicy,
        unfinishedTaskCount: unfinished.length,
        movedTaskCount: input.unfinishedTaskPolicy === 'MOVE' ? unfinished.length : 0,
        unassignedTaskCount: input.unfinishedTaskPolicy === 'UNASSIGN' ? unfinished.length : 0,
        note: input.note || null
      },
      mutation: syncMutation
    }));
    if (target) {
      const refreshedTarget = await tx.milestone.findUniqueOrThrow({ where: { id: target.id }, include: milestoneInclude });
      const targetSummary = serializeMilestone(refreshedTarget, progress.get(target.id) || emptyProgress());
      events.push(await appendSyncEvent(tx, {
        workspaceId: actor.workspace.id,
        entityType: 'milestone',
        entityId: target.id,
        operation: 'progress_updated',
        entityVersion: target.version,
        actorId: actor.user.id,
        payload: { after: targetSummary, changedFields: ['progress'] }
      }));
    }
    return {
      milestone: summary,
      disposition: {
        policy: input.unfinishedTaskPolicy || null,
        affectedTasks: unfinished.length,
        targetMilestoneId: target?.id || null
      }
    };
  });
  for (const event of events) publishSyncEvent(event);
  await Promise.all(taskAudits.map(({ id, before, after }) => logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: id,
    action: input.unfinishedTaskPolicy === 'MOVE' ? 'milestone_moved' : 'milestone_unassigned',
    before: serializeMilestoneTaskForSync(before),
    after: serializeMilestoneTaskForSync(after),
    source: actor.source
  }).catch(() => undefined)));
  await logMilestoneActivity(actor, milestoneId, action, existing, result);
  return result;
}

async function requireManageableMilestone(actor: RequestActor, milestoneId: string): Promise<MilestoneWithRelations> {
  const access = await resolveWorkspaceAccess(actor);
  const row = await prisma.milestone.findFirst({
    where: { id: milestoneId, workspaceId: actor.workspace.id, project: projectWhereForAccess(access) },
    include: milestoneInclude
  });
  if (!row) throw new HttpError(404, 'Milestone not found');
  await assertCanManageProjectPlanning(actor, row.projectId);
  return row;
}

async function assertMilestoneOwner(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  projectId: string,
  ownerId: string | null | undefined
) {
  if (!ownerId) return;
  const [member, project] = await Promise.all([
    tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: ownerId } },
      select: { role: true }
    }),
    tx.project.findUnique({
      where: { id: projectId, workspaceId },
      select: { id: true, teamId: true, leadId: true }
    })
  ]);
  if (!member || !project) throw new HttpError(400, 'Milestone owner must be a workspace member');
  if (!project.teamId || member.role === 'OWNER' || member.role === 'ADMIN' || project.leadId === ownerId) return;
  const [projectMember, teamMember] = await Promise.all([
    tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: ownerId } }, select: { id: true } }),
    tx.teamMember.findUnique({ where: { teamId_userId: { teamId: project.teamId, userId: ownerId } }, select: { id: true } })
  ]);
  if (!projectMember && !teamMember) throw new HttpError(400, 'Milestone owner cannot read this project');
}

async function positionMilestone(
  tx: Prisma.TransactionClient,
  existing: MilestoneWithRelations,
  input: ReorderMilestoneInput
): Promise<MilestoneWithRelations[]> {
  await lockMilestoneOrdering(tx, existing.projectId);
  let rows = await tx.milestone.findMany({
    where: { projectId: existing.projectId, archivedAt: null },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, position: true, version: true }
  });
  await lockMilestonesForUpdate(tx, existing.workspaceId, rows.map((row) => row.id));
  rows = await tx.milestone.findMany({
    where: { projectId: existing.projectId, archivedAt: null },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, position: true, version: true }
  });
  const current = rows.find((row) => row.id === existing.id);
  if (!current) throw new HttpError(409, 'Milestone ordering changed');
  if (current.version !== existing.version) throw new HttpError(409, 'Milestone changed on another client');
  if (input.beforeId === existing.id || input.afterId === existing.id) {
    throw new HttpError(400, 'Milestone cannot be its own reorder neighbor');
  }

  const remaining = rows.filter((row) => row.id !== existing.id);
  const beforeIndex = input.beforeId ? remaining.findIndex((row) => row.id === input.beforeId) : -1;
  const afterIndex = input.afterId ? remaining.findIndex((row) => row.id === input.afterId) : -1;
  if (input.beforeId && beforeIndex === -1) throw new HttpError(400, 'Before milestone is not in this project');
  if (input.afterId && afterIndex === -1) throw new HttpError(400, 'After milestone is not in this project');
  if (input.beforeId && input.afterId && afterIndex !== beforeIndex + 1) {
    throw new HttpError(409, 'Reorder neighbors are no longer adjacent');
  }
  if (!input.beforeId && !input.afterId && remaining.length > 0) {
    throw new HttpError(400, 'At least one reorder neighbor is required');
  }

  const insertionIndex = input.afterId
    ? afterIndex
    : input.beforeId
      ? beforeIndex + 1
      : 0;
  const desired = [...remaining];
  desired.splice(insertionIndex, 0, current);
  const previous = desired[insertionIndex - 1] || null;
  const next = desired[insertionIndex + 1] || null;
  const proposedPosition = previous && next
    ? Math.floor((previous.position + next.position) / 2)
    : previous
      ? previous.position + positionStep
      : next
        ? next.position - positionStep
        : positionStep;
  const needsRebalance = proposedPosition <= 0 || proposedPosition > 2_000_000_000 || (
    previous !== null && next !== null && next.position - previous.position <= 1
  );

  const changedIds = new Set<string>();
  if (needsRebalance) {
    for (let index = 0; index < desired.length; index += 1) {
      const row = desired[index];
      const position = (index + 1) * positionStep;
      if (row.position === position && row.id !== existing.id) continue;
      await tx.milestone.update({
        where: row.id === existing.id ? { id: row.id, version: existing.version } : { id: row.id },
        data: { position, version: { increment: 1 } }
      }).catch(versionConflict);
      changedIds.add(row.id);
    }
  } else {
    await tx.milestone.update({
      where: { id: existing.id, version: existing.version },
      data: { position: proposedPosition, version: { increment: 1 } }
    }).catch(versionConflict);
    changedIds.add(existing.id);
  }

  return tx.milestone.findMany({
    where: { id: { in: [...changedIds] } },
    include: milestoneInclude
  });
}

async function lockMilestoneOrdering(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$queryRaw<Array<{ locked: number }>>`
    SELECT 1::int AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 6174))) AS "acquired"
  `;
}

function serializeMilestoneTaskForSync(task: MilestoneTaskSyncShape) {
  return {
    ...task,
    attachments: task.attachments.map(serializeTaskAttachment)
  };
}

function assertMutable(milestone: Pick<Milestone, 'archivedAt'>) {
  if (milestone.archivedAt) throw new HttpError(409, 'Archived milestones are read-only');
}

function assertVersion(milestone: Pick<Milestone, 'version'>, version?: number) {
  if (version !== undefined && version !== milestone.version) throw new HttpError(409, 'Milestone changed on another client');
}

function versionConflict(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
    throw new HttpError(409, 'Milestone changed on another client');
  }
  throw error;
}

function milestoneCreateConflict(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
    throw new HttpError(409, 'Milestone id already exists');
  }
  throw error;
}

function assertDateRange(startsOn?: string | null, targetOn?: string | null) {
  if (startsOn && targetOn && startsOn > targetOn) throw new HttpError(400, 'Target date cannot precede start date');
}

function parseDate(value?: string | null): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(value?: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function todayDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function emptyProgress(): MilestoneProgressSummary {
  return {
    totalTasks: 0,
    eligibleTasks: 0,
    completedTasks: 0,
    canceledTasks: 0,
    blockedTasks: 0,
    overdueTasks: 0,
    totalWeight: 0,
    completedWeight: 0,
    percentage: null
  };
}

function compareMilestoneSummaries(
  left: ReturnType<typeof serializeMilestone>,
  right: ReturnType<typeof serializeMilestone>
) {
  const now = todayDate().getTime();
  const leftOverdue = !terminalStatuses.has(left.status) && left.targetOn ? Date.parse(left.targetOn) < now : false;
  const rightOverdue = !terminalStatuses.has(right.status) && right.targetOn ? Date.parse(right.targetOn) < now : false;
  if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
  const healthOrder = { OFF_TRACK: 0, AT_RISK: 1, ON_TRACK: 2 } as const;
  const leftHealth = left.health ? healthOrder[left.health] : 3;
  const rightHealth = right.health ? healthOrder[right.health] : 3;
  if (leftHealth !== rightHealth) return leftHealth - rightHealth;
  if (left.targetOn && right.targetOn && left.targetOn !== right.targetOn) return left.targetOn.localeCompare(right.targetOn);
  if (left.targetOn !== right.targetOn) return left.targetOn ? -1 : 1;
  const projectDifference = left.project.name.localeCompare(right.project.name, 'fa');
  if (projectDifference) return projectDifference;
  if (left.projectId !== right.projectId) return left.projectId.localeCompare(right.projectId);
  if (left.position !== right.position) return left.position - right.position;
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

async function logMilestoneActivity(
  actor: RequestActor,
  milestoneId: string,
  action: string,
  before?: unknown,
  after?: unknown
) {
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'milestone',
    entityId: milestoneId,
    action,
    before,
    after,
    source: actor.source
  }).catch(() => undefined);
}
