import { createHash } from 'node:crypto';
import {
  Prisma,
  prisma,
  type SyncEvent,
  type TaskStatus,
  type Workspace,
  type WorkspaceRole
} from '@taskara/db';
import type {
  createDepartmentWorkTargetSchema,
  createLinkedTaskFromSupportCaseSchema,
  createWorkspaceConnectionSchema,
  linkSupportCaseToTaskSchema,
  revokeWorkspaceConnectionSchema,
  unlinkSupportCaseTaskSchema
} from '@taskara/shared';
import { TASK_COMMENT_MAX_CHARS, WORK_DESCRIPTION_MAX_CHARS } from '@taskara/shared';
import type { z } from 'zod';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { assertCanConfigureSupport, assertCanWorkCase, canReadSupportCase, resolveSupportAccess } from './support-access';
import { appendSupportCaseEvent } from './support-cases';
import { appendSupportCaseSyncEvent } from './support-sync';
import {
  sanitizeCrossWorkspaceTitle,
  serializeSupportLinkProjection,
  serializeTeamLinkProjection,
  supportCaseTaskLinkProjectionSelect as linkSelect,
  type SupportCaseTaskLinkProjectionRecord as LinkRecord
} from './support-link-projections';
import { HttpError } from './http';
import { appendSyncEvent, lockWorkspaceSyncState, publishSyncEvent } from './sync';
import { createTaskInTransaction } from './tasks';
import { assertSupportWorkspace, assertTeamWorkspace } from './workspace-mode';

type CreateWorkspaceConnectionInput = z.infer<typeof createWorkspaceConnectionSchema>;
type CreateDepartmentWorkTargetInput = z.infer<typeof createDepartmentWorkTargetSchema>;
type LinkSupportCaseToTaskInput = z.infer<typeof linkSupportCaseToTaskSchema>;
type CreateLinkedTaskInput = z.infer<typeof createLinkedTaskFromSupportCaseSchema>;
type UnlinkSupportCaseTaskInput = z.infer<typeof unlinkSupportCaseTaskSchema>;
type RevokeWorkspaceConnectionInput = z.infer<typeof revokeWorkspaceConnectionSchema>;

export interface UpdateDepartmentWorkTargetInput {
  active?: boolean;
  allowCreateTasks?: boolean;
  allowLinkTasks?: boolean;
}

const workTargetInclude = {
  connection: {
    include: {
      supportWorkspace: true,
      teamWorkspace: true
    }
  },
  department: { select: { id: true, name: true, slug: true, active: true } },
  project: {
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      status: true,
      teamId: true,
      leadId: true
    }
  }
} satisfies Prisma.DepartmentWorkTargetInclude;

type WorkTargetRecord = Prisma.DepartmentWorkTargetGetPayload<{ include: typeof workTargetInclude }>;

const connectionInclude = {
  supportWorkspace: { select: { id: true, name: true, mode: true } },
  teamWorkspace: { select: { id: true, name: true, mode: true } },
  workTargets: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    include: {
      department: { select: { id: true, name: true, slug: true } },
      project: { select: { id: true, name: true, keyPrefix: true, status: true } }
    }
  }
} satisfies Prisma.WorkspaceConnectionInclude;

type ConnectionRecord = Prisma.WorkspaceConnectionGetPayload<{ include: typeof connectionInclude }>;

interface LockedSupportCase {
  id: string;
  workspaceId: string;
  key: string;
  title: string;
  typeKey: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  status: 'NEW' | 'OPEN' | 'WAITING_ON_CUSTOMER' | 'WAITING_ON_INTERNAL' | 'RESOLVED' | 'CLOSED';
  departmentId: string | null;
  assigneeMembershipId: string | null;
  nextActionAt: Date | null;
  version: number;
}

export async function createWorkspaceConnection(actor: RequestActor, input: CreateWorkspaceConnectionInput) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace administration access required');

  const teamWorkspace = await prisma.workspace.findFirst({
    where: { id: input.teamWorkspaceId, mode: 'TEAM' },
    select: { id: true }
  });
  if (!teamWorkspace) throw new HttpError(404, 'Team workspace not found');

  const existing = await prisma.workspaceConnection.findUnique({
    where: {
      supportWorkspaceId_teamWorkspaceId: {
        supportWorkspaceId: actor.workspace.id,
        teamWorkspaceId: input.teamWorkspaceId
      }
    },
    include: connectionInclude
  });
  if (existing) return { connection: serializeWorkspaceConnection(existing, actor.workspace.id), replayed: true };

  try {
    const connection = await prisma.workspaceConnection.create({
      data: {
        supportWorkspaceId: actor.workspace.id,
        teamWorkspaceId: input.teamWorkspaceId
      },
      include: connectionInclude
    });
    return { connection: serializeWorkspaceConnection(connection, actor.workspace.id), replayed: false };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await prisma.workspaceConnection.findUniqueOrThrow({
      where: {
        supportWorkspaceId_teamWorkspaceId: {
          supportWorkspaceId: actor.workspace.id,
          teamWorkspaceId: input.teamWorkspaceId
        }
      },
      include: connectionInclude
    });
    return { connection: serializeWorkspaceConnection(raced, actor.workspace.id), replayed: true };
  }
}

export async function listSupportWorkspaceConnections(actor: RequestActor) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const connections = await prisma.workspaceConnection.findMany({
    where: { supportWorkspaceId: actor.workspace.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: connectionInclude
  });
  return connections.map((connection) => serializeWorkspaceConnection(connection, actor.workspace.id));
}

/** Used by the common approval screen; only endpoint administrators may enumerate invitations. */
export async function listEndpointWorkspaceConnections(actor: RequestActor) {
  assertHumanActor(actor);
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace administration access required');
  const connections = await prisma.workspaceConnection.findMany({
    where: {
      OR: [
        { supportWorkspaceId: actor.workspace.id },
        { teamWorkspaceId: actor.workspace.id }
      ]
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: connectionInclude
  });
  return connections.map((connection) => serializeWorkspaceConnection(connection, actor.workspace.id));
}

export async function approveWorkspaceConnection(actor: RequestActor, connectionId: string) {
  assertHumanActor(actor);
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace administration access required');
  const { connection, events } = await prisma.$transaction(async (tx) => {
    const connection = await lockEndpointConnection(tx, actor, connectionId);
    if (connection.status === 'REVOKED') throw new HttpError(409, 'A revoked workspace connection cannot be approved');

    const side = endpointSide(connection, actor.workspace.id);
    if (side === 'SUPPORT' && connection.supportApprovedAt) {
      return { connection, events: [] as SyncEvent[] };
    }
    if (side === 'TEAM' && connection.teamApprovedAt) {
      return { connection, events: [] as SyncEvent[] };
    }

    const otherApproved = side === 'SUPPORT' ? connection.teamApprovedAt : connection.supportApprovedAt;
    if (!connection.workTargets.some((target) => target.active)) {
      throw new HttpError(409, 'At least one active Department work target is required before activation');
    }

    const now = new Date();
    const updated = await tx.workspaceConnection.update({
      where: { id: connection.id },
      data: {
        ...(side === 'SUPPORT'
          ? { supportApprovedById: actor.user.id, supportApprovedAt: now }
          : { teamApprovedById: actor.user.id, teamApprovedAt: now }),
        status: otherApproved ? 'ACTIVE' : 'PENDING'
      },
      include: connectionInclude
    });
    const events = await appendConnectionEvents(tx, actor, updated, 'approved');
    return { connection: updated, events };
  });
  events.forEach(publishSyncEvent);
  return serializeWorkspaceConnection(connection, actor.workspace.id);
}

export async function revokeWorkspaceConnection(
  actor: RequestActor,
  connectionId: string,
  input: RevokeWorkspaceConnectionInput
) {
  assertHumanActor(actor);
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace administration access required');
  const { connection, events } = await prisma.$transaction(async (tx) => {
    const current = await lockEndpointConnection(tx, actor, connectionId);
    if (current.status === 'REVOKED') return { connection: current, events: [] as SyncEvent[] };
    const now = new Date();
    const links = await tx.supportCaseTaskLink.findMany({
      where: { connectionId: current.id, connectionRevokedAt: null },
      orderBy: [{ caseId: 'asc' }, { id: 'asc' }],
      select: linkSelect
    });
    const caseIds = [...new Set(links.map((link) => link.caseId))].sort();
    // Cross-workspace mutations use Connection -> sorted Cases -> sorted sync states. Besides
    // avoiding an inversion with handoff/unlink, the Case locks make append-only event sequences
    // safe against ordinary Case writes and make the freeze boundary linearizable for Task signals.
    await lockSupportCases(tx, caseIds);
    const workspaceIds = [current.supportWorkspaceId, current.teamWorkspaceId];
    await lockWorkspaceSyncStates(tx, workspaceIds);

    const updated = await tx.workspaceConnection.update({
      where: { id: current.id },
      data: {
        status: 'REVOKED',
        revokedById: actor.user.id,
        revokedAt: now,
        revokeReason: input.reason
      },
      include: connectionInclude
    });

    const events: SyncEvent[] = [];
    const bumpedCases = new Map<string, { id: string; workspaceId: string; version: number }>();
    for (const caseId of caseIds) {
      const supportCase = await tx.supportCase.update({
        where: { id: caseId },
        data: { version: { increment: 1 } },
        select: { id: true, workspaceId: true, version: true }
      });
      bumpedCases.set(caseId, supportCase);
    }
    for (const link of links) {
      const tombstoned = await tx.supportCaseTaskLink.update({
        where: { id: link.id },
        data: { connectionRevokedAt: now, version: { increment: 1 } },
        select: linkSelect
      });
      const supportCase = bumpedCases.get(tombstoned.caseId)!;
      await appendSupportCaseEvent(tx, actor, supportCase, {
        action: 'case.task_link_connection_revoked',
        before: serializeSupportLinkProjection(link),
        after: serializeSupportLinkProjection(tombstoned),
        reason: input.reason
      });
      events.push(...await appendLinkProjectionEvents(tx, actor.user.id, tombstoned, 'revoked'));
    }
    // Support sync intentionally does not expose link events directly. One versioned Case upsert
    // per affected Case wakes authorized detail clients without duplicating bumps for many links.
    for (const supportCase of bumpedCases.values()) {
      events.push(await appendSupportCaseSyncEvent(tx, {
        workspaceId: supportCase.workspaceId,
        caseId: supportCase.id,
        caseVersion: supportCase.version,
        operation: 'upsert',
        actorId: actor.user.id
      }));
    }
    events.push(...await appendConnectionEvents(tx, actor, updated, 'revoked', true));
    return { connection: updated, events };
  });
  events.forEach(publishSyncEvent);
  return serializeWorkspaceConnection(connection, actor.workspace.id);
}

export async function createDepartmentWorkTarget(actor: RequestActor, input: CreateDepartmentWorkTargetInput) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);

  const result = await prisma.$transaction(async (tx) => {
    const connection = await lockEndpointConnection(tx, actor, input.connectionId);
    assertConnectionTargetsMutable(connection);
    const department = await tx.department.findFirst({
      where: { id: input.departmentId, workspaceId: actor.workspace.id, active: true },
      select: { id: true }
    });
    if (!department) throw new HttpError(400, 'Department is not active in this workspace');

    const teamActor = await resolveCounterpartActor(tx, actor, connection.teamWorkspaceId);
    const project = await tx.project.findFirst({
      where: { id: input.projectId, workspaceId: connection.teamWorkspaceId },
      select: { id: true, workspaceId: true, teamId: true, leadId: true }
    });
    if (!project) throw new HttpError(404, 'Target project not found');
    await assertTeamProjectRelationWrite(tx, teamActor, project);

    const existing = await tx.departmentWorkTarget.findUnique({
      where: {
        connectionId_departmentId_projectId: {
          connectionId: connection.id,
          departmentId: input.departmentId,
          projectId: input.projectId
        }
      },
      include: workTargetInclude
    });
    if (
      existing
      && existing.active
      && existing.allowCreateTasks === input.allowCreateTasks
      && existing.allowLinkTasks === input.allowLinkTasks
    ) return { target: existing, replayed: true, events: [] as SyncEvent[] };

    const target = existing
      ? await tx.departmentWorkTarget.update({
          where: { id: existing.id },
          data: {
            active: true,
            allowCreateTasks: input.allowCreateTasks,
            allowLinkTasks: input.allowLinkTasks,
            createdById: actor.user.id
          },
          include: workTargetInclude
        })
      : await tx.departmentWorkTarget.create({
          data: {
            connectionId: connection.id,
            supportWorkspaceId: connection.supportWorkspaceId,
            teamWorkspaceId: connection.teamWorkspaceId,
            departmentId: input.departmentId,
            projectId: input.projectId,
            allowCreateTasks: input.allowCreateTasks,
            allowLinkTasks: input.allowLinkTasks,
            createdById: actor.user.id
          },
          include: workTargetInclude
        });
    const refreshed = await tx.workspaceConnection.findUniqueOrThrow({
      where: { id: connection.id },
      include: connectionInclude
    });
    const events = await appendConnectionEvents(tx, actor, refreshed, 'target_changed');
    return { target, replayed: false, events };
  });
  result.events.forEach(publishSyncEvent);
  return { target: serializeWorkTarget(result.target), replayed: result.replayed };
}

export async function updateDepartmentWorkTarget(
  actor: RequestActor,
  targetId: string,
  input: UpdateDepartmentWorkTargetInput
) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  if (input.active === undefined && input.allowCreateTasks === undefined && input.allowLinkTasks === undefined) {
    throw new HttpError(400, 'At least one work target field is required');
  }

  const { target, events } = await prisma.$transaction(async (tx) => {
    // Approval takes the same connection-row lock. Whichever transaction wins establishes whether
    // the allowlist changed before approval or was correctly refused after it.
    const lockedConnection = await lockConnectionForWorkTarget(tx, actor.workspace.id, targetId);
    const current = await tx.departmentWorkTarget.findFirst({
      where: { id: targetId, supportWorkspaceId: actor.workspace.id },
      include: workTargetInclude
    });
    if (!current) throw new HttpError(404, 'Department work target not found');
    if (!lockedConnection || lockedConnection.id !== current.connectionId) {
      throw new HttpError(404, 'Department work target not found');
    }
    assertConnectionTargetsMutable(lockedConnection);
    const allowCreateTasks = input.allowCreateTasks ?? current.allowCreateTasks;
    const allowLinkTasks = input.allowLinkTasks ?? current.allowLinkTasks;
    if (!allowCreateTasks && !allowLinkTasks) {
      throw new HttpError(400, 'At least one target capability is required');
    }
    const teamActor = await resolveCounterpartActor(tx, actor, current.teamWorkspaceId);
    await assertTeamProjectRelationWrite(tx, teamActor, current.project);
    const target = await tx.departmentWorkTarget.update({
      where: { id: current.id },
      data: { active: input.active, allowCreateTasks, allowLinkTasks },
      include: workTargetInclude
    });
    const refreshed = await tx.workspaceConnection.findUniqueOrThrow({
      where: { id: current.connectionId },
      include: connectionInclude
    });
    const events = await appendConnectionEvents(tx, actor, refreshed, 'target_changed');
    return { target, events };
  });
  events.forEach(publishSyncEvent);
  return serializeWorkTarget(target);
}

export async function listDepartmentWorkTargets(actor: RequestActor) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  const membershipDepartmentIds = access.workspaceWide || access.canConfigure
    ? []
    : (await prisma.departmentMember.findMany({
        where: { id: { in: access.memberMembershipIds }, active: true },
        select: { departmentId: true }
      })).map((row) => row.departmentId);
  const departmentIds = [...new Set([...access.managedDepartmentIds, ...membershipDepartmentIds])];
  if (!access.workspaceWide && !access.canConfigure && !departmentIds.length) return [];

  const targets = await prisma.departmentWorkTarget.findMany({
    where: {
      supportWorkspaceId: actor.workspace.id,
      ...(access.workspaceWide || access.canConfigure
        ? {}
        : { departmentId: { in: departmentIds }, active: true, connection: { status: 'ACTIVE' } })
    },
    orderBy: [{ department: { name: 'asc' } }, { project: { name: 'asc' } }, { id: 'asc' }],
    include: workTargetInclude
  });
  return targets.map(serializeWorkTarget);
}

/** Writable Team projects visible only to a Support admin who independently holds Team authority. */
export async function listWorkspaceConnectionProjectOptions(actor: RequestActor, connectionId: string) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  if (!isWorkspaceAdminRole(actor.role)) throw new HttpError(403, 'Workspace administration access required');
  const connection = await prisma.workspaceConnection.findFirst({
    where: {
      id: connectionId,
      supportWorkspaceId: actor.workspace.id,
      status: 'PENDING',
      supportApprovedAt: null,
      teamApprovedAt: null
    },
    include: { teamWorkspace: true }
  });
  if (!connection) throw new HttpError(404, 'Configurable workspace connection not found');
  const teamActor = await resolveCounterpartActor(prisma, actor, connection.teamWorkspaceId);
  const projects = await prisma.project.findMany({
    where: { workspaceId: connection.teamWorkspaceId },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, keyPrefix: true, status: true, teamId: true, leadId: true }
  });
  const writable = [];
  for (const project of projects) {
    if (await canWriteTeamProject(prisma, teamActor, project)) {
      writable.push({ id: project.id, name: project.name, keyPrefix: project.keyPrefix, status: project.status });
    }
  }
  return writable;
}

/** Per-Case action options; cross-side UUIDs stay behind opaque target action ids. */
export async function listSupportCaseHandoffOptions(actor: RequestActor, idOrKey: string) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  const supportCase = await prisma.supportCase.findFirst({
    where: { workspaceId: actor.workspace.id, ...caseIdentifierWhere(idOrKey) },
    select: {
      id: true,
      workspaceId: true,
      key: true,
      status: true,
      departmentId: true,
      assigneeMembershipId: true,
      version: true
    }
  });
  if (!supportCase || !canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  assertCanWorkCase(access, supportCase);
  const targets = supportCase.departmentId
    ? await prisma.departmentWorkTarget.findMany({
        where: {
          supportWorkspaceId: actor.workspace.id,
          departmentId: supportCase.departmentId,
          active: true,
          connection: { status: 'ACTIVE' }
        },
        orderBy: [{ project: { name: 'asc' } }, { id: 'asc' }],
        include: workTargetInclude
      })
    : [];
  return {
    caseVersion: supportCase.version,
    accessEpoch: access.epoch.toString(),
    items: targets.map((target) => ({
      workTargetId: target.id,
      teamWorkspaceName: target.connection.teamWorkspace.name,
      project: {
        name: target.project.name,
        keyPrefix: target.project.keyPrefix,
        status: target.project.status
      },
      allowCreateTasks: target.allowCreateTasks,
      allowLinkTasks: target.allowLinkTasks
    }))
  };
}

/** Minimal picker rows from exactly one allowlisted project, after independent Team read auth. */
export async function searchDepartmentWorkTargetTasks(
  actor: RequestActor,
  targetId: string,
  query: { q?: string; limit: number }
) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  const access = await resolveSupportAccess(actor);
  const target = await prisma.departmentWorkTarget.findFirst({
    where: {
      id: targetId,
      supportWorkspaceId: actor.workspace.id,
      active: true,
      connection: { status: 'ACTIVE' }
    },
    include: workTargetInclude
  });
  if (!target) throw new HttpError(404, 'Active Department work target not found');
  if (!await supportAccessIncludesDepartment(access, target.departmentId)) {
    throw new HttpError(404, 'Active Department work target not found');
  }
  const teamActor = await resolveCounterpartActor(prisma, actor, target.teamWorkspaceId);
  if (!await canReadTeamProject(prisma, teamActor, target.project)) {
    throw new HttpError(404, 'Target project not found');
  }
  const q = query.q?.trim();
  const tasks = await prisma.task.findMany({
    where: {
      workspaceId: target.teamWorkspaceId,
      projectId: target.projectId,
      ...(q
        ? {
            OR: [
              { key: { contains: q, mode: 'insensitive' } },
              { title: { contains: q, mode: 'insensitive' } }
            ]
          }
        : {})
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: query.limit,
    select: { id: true, key: true, title: true, status: true, parentId: true }
  });
  return tasks;
}

export async function listSupportCaseTaskLinks(actor: RequestActor, idOrKey: string) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  const supportCase = await prisma.supportCase.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      ...caseIdentifierWhere(idOrKey)
    },
    select: {
      id: true,
      workspaceId: true,
      departmentId: true,
      assigneeMembershipId: true,
      version: true
    }
  });
  if (!supportCase || !canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  const links = await prisma.supportCaseTaskLink.findMany({
    where: { supportWorkspaceId: actor.workspace.id, caseId: supportCase.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: linkSelect
  });
  return {
    items: links.map(serializeSupportLinkProjection),
    caseVersion: supportCase.version,
    accessEpoch: access.epoch.toString()
  };
}

export async function listTaskSupportCaseLinks(actor: RequestActor, idOrKey: string) {
  assertTeamWorkspace(actor.workspace);
  assertHumanActor(actor);
  const task = await findReadableTeamTask(prisma, actor, idOrKey);
  const links = await prisma.supportCaseTaskLink.findMany({
    where: { teamWorkspaceId: actor.workspace.id, taskId: task.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: linkSelect
  });
  return links.map(serializeTeamLinkProjection);
}

export async function linkSupportCaseToTask(
  actor: RequestActor,
  idOrKey: string,
  input: LinkSupportCaseToTaskInput
) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  const requestHash = linkRequestHash('LINK_EXISTING', input);
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Revoke owns this row before it owns any Case row; handoff must use the same order.
      const lockedConnection = await lockConnectionForWorkTarget(tx, actor.workspace.id, input.workTargetId);
      const { supportCase, access } = await lockWritableSupportCase(tx, actor, idOrKey);
      await lockIdempotencyKey(tx, actor.workspace.id, input.idempotencyKey);
      const replay = await replayLinkForIdempotency(tx, supportCase.id, actor.workspace.id, input.idempotencyKey, requestHash);
      if (replay) {
        return {
          link: replay,
          replayed: true,
          caseVersion: supportCase.version,
          accessEpoch: access.epoch.toString(),
          events: [] as SyncEvent[]
        };
      }
      if (!lockedConnection) {
        throw new HttpError(400, 'No active allowlisted target is available for the Case Department');
      }
      const target = await loadOperationalWorkTarget(
        tx,
        actor,
        supportCase,
        lockedConnection,
        input.workTargetId,
        'LINK'
      );
      assertCaseVersion(supportCase, input.baseVersion);
      const teamActor = await resolveCounterpartActor(tx, actor, target.teamWorkspaceId);
      const task = await tx.task.findFirst({
        where: {
          id: input.taskId,
          workspaceId: target.teamWorkspaceId,
          projectId: target.projectId
        },
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          key: true,
          title: true,
          status: true,
          project: { select: { id: true, teamId: true, leadId: true } }
        }
      });
      if (!task || !await canReadTeamProject(tx, teamActor, task.project)) {
        throw new HttpError(404, 'Task not found');
      }
      await assertTeamProjectRelationWrite(tx, teamActor, task.project);
      const handoffComment = linkedTaskComment(supportCase.key, input.handoffSummary);
      await lockWorkspaceSyncStates(tx, [target.supportWorkspaceId, target.teamWorkspaceId]);

      const now = new Date();
      const sanitizedTitle = sanitizeCrossWorkspaceTitle(input.handoffTitle);
      const link = await tx.supportCaseTaskLink.create({
        data: linkCreateData({
          actor,
          supportCase,
          target,
          task,
          input,
          requestHash,
          sanitizedTitle,
          now
        }),
        select: linkSelect
      });
      await tx.taskComment.create({
        data: {
          taskId: task.id,
          authorId: actor.user.id,
          body: handoffComment,
          source: actor.source
        }
      });
      const updatedCase = await bumpSupportCaseForLink(tx, supportCase.id);
      await appendLinkCreatedAudit(tx, actor, updatedCase, task.id, link, input.idempotencyKey);
      const events = await appendLinkProjectionEvents(tx, actor.user.id, link, 'created');
      events.push(await appendSupportCaseSyncEvent(tx, {
        workspaceId: supportCase.workspaceId,
        caseId: supportCase.id,
        caseVersion: updatedCase.version,
        operation: 'upsert',
        actorId: actor.user.id
      }));
      return {
        link,
        replayed: false,
        caseVersion: updatedCase.version,
        accessEpoch: access.epoch.toString(),
        events
      };
    });
    result.events.forEach(publishSyncEvent);
    return {
      link: serializeSupportLinkProjection(result.link),
      replayed: result.replayed,
      caseVersion: result.caseVersion,
      accessEpoch: result.accessEpoch
    };
  } catch (error) {
    throw mapLinkUniqueError(error);
  }
}

export async function createLinkedTaskFromSupportCase(
  actor: RequestActor,
  idOrKey: string,
  input: CreateLinkedTaskInput,
  testHooks?: { afterTaskCreated?: () => void | Promise<void> }
) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  const requestHash = linkRequestHash('CREATE_TASK', input);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const lockedConnection = await lockConnectionForWorkTarget(tx, actor.workspace.id, input.workTargetId);
      const { supportCase, access } = await lockWritableSupportCase(tx, actor, idOrKey);
      await lockIdempotencyKey(tx, actor.workspace.id, input.idempotencyKey);
      const replay = await replayLinkForIdempotency(tx, supportCase.id, actor.workspace.id, input.idempotencyKey, requestHash);
      if (replay) {
        return {
          link: replay,
          replayed: true,
          caseVersion: supportCase.version,
          accessEpoch: access.epoch.toString(),
          events: [] as SyncEvent[]
        };
      }
      if (!lockedConnection) {
        throw new HttpError(400, 'No active allowlisted target is available for the Case Department');
      }
      const target = await loadOperationalWorkTarget(
        tx,
        actor,
        supportCase,
        lockedConnection,
        input.workTargetId,
        'CREATE'
      );
      assertCaseVersion(supportCase, input.baseVersion);
      const teamActor = await resolveCounterpartActor(tx, actor, target.teamWorkspaceId);
      if (input.parentTaskId) {
        const parent = await tx.task.findFirst({
          where: {
            id: input.parentTaskId,
            workspaceId: target.teamWorkspaceId,
            projectId: target.projectId
          },
          select: {
            id: true,
            project: { select: { id: true, teamId: true, leadId: true } }
          }
        });
        if (!parent || !await canReadTeamProject(tx, teamActor, parent.project)) {
          throw new HttpError(404, 'Parent Task not found');
        }
      }
      // Ordinary Task creation reserves its key by updating Project before it appends Team sync.
      // Pre-locking Project preserves that Project -> sorted sync-state order while this caller
      // must reserve both workspace streams up front.
      await lockTeamProject(tx, target.teamWorkspaceId, target.projectId);
      await lockWorkspaceSyncStates(tx, [target.supportWorkspaceId, target.teamWorkspaceId]);
      const description = linkedTaskDescription(supportCase.key, input.taskDescription, input.handoffSummary);
      const created = await createTaskInTransaction(tx, teamActor, {
        projectId: target.projectId,
        parentId: input.parentTaskId,
        title: input.taskTitle,
        description,
        kind: 'WORK',
        status: 'TODO',
        priority: input.taskPriority,
        labels: [],
        source: actor.source
      });
      await testHooks?.afterTaskCreated?.();
      const now = new Date();
      const sanitizedTitle = sanitizeCrossWorkspaceTitle(input.handoffTitle);
      const link = await tx.supportCaseTaskLink.create({
        data: linkCreateData({
          actor,
          supportCase,
          target,
          task: created.task,
          input,
          requestHash,
          sanitizedTitle,
          now
        }),
        select: linkSelect
      });
      const updatedCase = await bumpSupportCaseForLink(tx, supportCase.id);
      await appendLinkCreatedAudit(tx, actor, updatedCase, created.task.id, link, input.idempotencyKey, true);
      const events = [...created.syncEvents, ...await appendLinkProjectionEvents(tx, actor.user.id, link, 'created')];
      events.push(await appendSupportCaseSyncEvent(tx, {
        workspaceId: supportCase.workspaceId,
        caseId: supportCase.id,
        caseVersion: updatedCase.version,
        operation: 'upsert',
        actorId: actor.user.id
      }));
      return {
        link,
        replayed: false,
        caseVersion: updatedCase.version,
        accessEpoch: access.epoch.toString(),
        events
      };
    });
    result.events.forEach(publishSyncEvent);
    return {
      link: serializeSupportLinkProjection(result.link),
      replayed: result.replayed,
      caseVersion: result.caseVersion,
      accessEpoch: result.accessEpoch
    };
  } catch (error) {
    throw mapLinkUniqueError(error);
  }
}

export async function unlinkSupportCaseTask(
  actor: RequestActor,
  idOrKey: string,
  linkId: string,
  input: UnlinkSupportCaseTaskInput
) {
  assertSupportWorkspace(actor.workspace);
  assertHumanActor(actor);
  const result = await prisma.$transaction(async (tx) => {
    const lockedConnection = await lockConnectionForLink(tx, actor.workspace.id, linkId);
    const { supportCase, access } = await lockWritableSupportCase(tx, actor, idOrKey);
    const link = await tx.supportCaseTaskLink.findFirst({
      where: { id: linkId, supportWorkspaceId: actor.workspace.id, caseId: supportCase.id },
      select: linkSelect
    });
    if (!link) throw new HttpError(404, 'Case–Task link not found');
    if (!lockedConnection || lockedConnection.id !== link.connectionId) {
      throw new HttpError(404, 'Case–Task link not found');
    }
    if (lockedConnection.status === 'REVOKED' || link.connectionRevokedAt) {
      throw new HttpError(409, 'A link on a revoked workspace connection cannot be changed');
    }
    if (link.unlinkedAt) {
      return {
        link,
        replayed: true,
        caseVersion: supportCase.version,
        accessEpoch: access.epoch.toString(),
        events: [] as SyncEvent[]
      };
    }
    assertCaseVersion(supportCase, input.baseVersion);
    const target = await tx.departmentWorkTarget.findUnique({
      where: { id: link.workTargetId },
      include: workTargetInclude
    });
    if (!target) throw new HttpError(409, 'The link target no longer exists');
    const teamActor = await resolveCounterpartActor(tx, actor, target.teamWorkspaceId);
    await assertTeamProjectRelationWrite(tx, teamActor, target.project);
    await lockWorkspaceSyncStates(tx, [link.supportWorkspaceId, link.teamWorkspaceId]);
    const unlinked = await tx.supportCaseTaskLink.update({
      where: { id: link.id },
      data: { unlinkedAt: new Date(), version: { increment: 1 } },
      select: linkSelect
    });
    const updatedCase = await bumpSupportCaseForLink(tx, supportCase.id);
    await appendSupportCaseEvent(tx, actor, updatedCase, {
      action: 'case.task_unlinked',
      before: serializeSupportLinkProjection(link),
      after: serializeSupportLinkProjection(unlinked),
      reason: input.reason
    });
    if (link.taskId) {
      await tx.activityLog.create({
        data: {
          workspaceId: link.teamWorkspaceId,
          actorId: actor.user.id,
          actorType: actor.actorType,
          actorRuntime: actor.actorRuntime,
          entityType: 'task',
          entityId: link.taskId,
          action: 'support_case_unlinked',
          before: serializeTeamLinkProjection(link),
          after: serializeTeamLinkProjection(unlinked),
          source: actor.source
        }
      });
    }
    const events = await appendLinkProjectionEvents(tx, actor.user.id, unlinked, 'unlinked');
    events.push(await appendSupportCaseSyncEvent(tx, {
      workspaceId: supportCase.workspaceId,
      caseId: supportCase.id,
      caseVersion: updatedCase.version,
      operation: 'upsert',
      actorId: actor.user.id
    }));
    return {
      link: unlinked,
      replayed: false,
      caseVersion: updatedCase.version,
      accessEpoch: access.epoch.toString(),
      events
    };
  });
  result.events.forEach(publishSyncEvent);
  return {
    link: serializeSupportLinkProjection(result.link),
    replayed: result.replayed,
    caseVersion: result.caseVersion,
    accessEpoch: result.accessEpoch
  };
}

function serializeWorkspaceConnection(connection: ConnectionRecord, currentWorkspaceId: string) {
  const side = endpointSide(connection, currentWorkspaceId);
  const otherWorkspace = side === 'SUPPORT' ? connection.teamWorkspace : connection.supportWorkspace;
  return {
    id: connection.id,
    status: connection.status,
    currentWorkspaceSide: side,
    currentApproved: side === 'SUPPORT' ? Boolean(connection.supportApprovedAt) : Boolean(connection.teamApprovedAt),
    otherApproved: side === 'SUPPORT' ? Boolean(connection.teamApprovedAt) : Boolean(connection.supportApprovedAt),
    otherWorkspace: { name: otherWorkspace.name },
    targets: connection.workTargets.map((target) => ({
      id: target.id,
      department: side === 'SUPPORT'
        ? { id: target.department.id, name: target.department.name, slug: target.department.slug }
        : { name: target.department.name },
      project: side === 'TEAM'
        ? { id: target.project.id, name: target.project.name, keyPrefix: target.project.keyPrefix, status: target.project.status }
        : { name: target.project.name, keyPrefix: target.project.keyPrefix, status: target.project.status },
      allowCreateTasks: target.allowCreateTasks,
      allowLinkTasks: target.allowLinkTasks,
      active: target.active
    })),
    revokedAt: connection.revokedAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString()
  };
}

function serializeWorkTarget(target: WorkTargetRecord) {
  return {
    id: target.id,
    connectionId: target.connectionId,
    department: {
      id: target.department.id,
      name: target.department.name,
      slug: target.department.slug
    },
    teamWorkspace: { name: target.connection.teamWorkspace.name },
    project: {
      name: target.project.name,
      keyPrefix: target.project.keyPrefix,
      status: target.project.status
    },
    allowCreateTasks: target.allowCreateTasks,
    allowLinkTasks: target.allowLinkTasks,
    active: target.active,
    connectionStatus: target.connection.status,
    createdAt: target.createdAt.toISOString(),
    updatedAt: target.updatedAt.toISOString()
  };
}

async function lockEndpointConnection(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  connectionId: string
): Promise<ConnectionRecord> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "WorkspaceConnection"
    WHERE "id" = ${connectionId}::uuid
      AND (${actor.workspace.id}::uuid = "supportWorkspaceId" OR ${actor.workspace.id}::uuid = "teamWorkspaceId")
    FOR UPDATE
  `);
  if (!rows[0]) throw new HttpError(404, 'Workspace connection not found');
  return tx.workspaceConnection.findUniqueOrThrow({ where: { id: rows[0].id }, include: connectionInclude });
}

async function lockConnectionForWorkTarget(
  tx: Prisma.TransactionClient,
  supportWorkspaceId: string,
  workTargetId: string
): Promise<ConnectionRecord | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT connection."id"
    FROM "WorkspaceConnection" connection
    INNER JOIN "DepartmentWorkTarget" target ON target."connectionId" = connection."id"
    WHERE target."id" = ${workTargetId}::uuid
      AND target."supportWorkspaceId" = ${supportWorkspaceId}::uuid
      AND connection."supportWorkspaceId" = ${supportWorkspaceId}::uuid
    FOR UPDATE OF connection
  `);
  if (!rows[0]) return null;
  return tx.workspaceConnection.findUniqueOrThrow({ where: { id: rows[0].id }, include: connectionInclude });
}

async function lockConnectionForLink(
  tx: Prisma.TransactionClient,
  supportWorkspaceId: string,
  linkId: string
): Promise<ConnectionRecord | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT connection."id"
    FROM "WorkspaceConnection" connection
    INNER JOIN "SupportCaseTaskLink" link ON link."connectionId" = connection."id"
    WHERE link."id" = ${linkId}::uuid
      AND link."supportWorkspaceId" = ${supportWorkspaceId}::uuid
      AND connection."supportWorkspaceId" = ${supportWorkspaceId}::uuid
    FOR UPDATE OF connection
  `);
  if (!rows[0]) return null;
  return tx.workspaceConnection.findUniqueOrThrow({ where: { id: rows[0].id }, include: connectionInclude });
}

function assertConnectionTargetsMutable(connection: ConnectionRecord): void {
  if (
    connection.status === 'PENDING'
    && !connection.supportApprovedAt
    && !connection.teamApprovedAt
  ) return;
  throw new HttpError(409, 'Department targets cannot change after either workspace approves');
}

function endpointSide(
  connection: Pick<ConnectionRecord, 'supportWorkspaceId' | 'teamWorkspaceId'>,
  workspaceId: string
): 'SUPPORT' | 'TEAM' {
  if (connection.supportWorkspaceId === workspaceId) return 'SUPPORT';
  if (connection.teamWorkspaceId === workspaceId) return 'TEAM';
  throw new HttpError(404, 'Workspace connection not found');
}

async function appendConnectionEvents(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  connection: ConnectionRecord,
  operation: string,
  alreadyLocked = false
): Promise<SyncEvent[]> {
  if (!alreadyLocked) {
    await lockWorkspaceSyncStates(tx, [connection.supportWorkspaceId, connection.teamWorkspaceId]);
  }
  const supportProjection = serializeWorkspaceConnection(connection, connection.supportWorkspaceId);
  const teamProjection = serializeWorkspaceConnection(connection, connection.teamWorkspaceId);
  return Promise.all([
    appendSyncEvent(tx, {
      workspaceId: connection.supportWorkspaceId,
      entityType: 'workspace_connection',
      entityId: connection.id,
      operation,
      actorId: actor.user.id,
      payload: { after: supportProjection }
    }),
    appendSyncEvent(tx, {
      workspaceId: connection.teamWorkspaceId,
      entityType: 'workspace_connection',
      entityId: connection.id,
      operation,
      actorId: actor.user.id,
      payload: { after: teamProjection }
    })
  ]);
}

async function lockWritableSupportCase(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  idOrKey: string
): Promise<{
  supportCase: LockedSupportCase;
  access: Awaited<ReturnType<typeof resolveSupportAccess>>;
}> {
  const access = await resolveSupportAccess(actor, tx);
  const normalized = idOrKey.trim();
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "SupportCase"
    WHERE "workspaceId" = ${actor.workspace.id}::uuid
      AND ("id"::text = ${normalized} OR "key" = ${normalized.toUpperCase()})
    FOR UPDATE
  `);
  if (!rows[0]) throw new HttpError(404, 'Support Case not found');
  const supportCase = await tx.supportCase.findUnique({
    where: { id: rows[0].id },
    select: {
      id: true,
      workspaceId: true,
      key: true,
      title: true,
      typeKey: true,
      priority: true,
      status: true,
      departmentId: true,
      assigneeMembershipId: true,
      nextActionAt: true,
      version: true
    }
  });
  if (!supportCase || !canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  assertCanWorkCase(access, supportCase);
  return { supportCase, access };
}

async function loadOperationalWorkTarget(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  supportCase: LockedSupportCase,
  lockedConnection: ConnectionRecord,
  workTargetId: string,
  capability: 'LINK' | 'CREATE'
): Promise<WorkTargetRecord> {
  if (lockedConnection.status !== 'ACTIVE') {
    throw new HttpError(400, 'No active allowlisted target is available for the Case Department');
  }
  const target = await tx.departmentWorkTarget.findFirst({
    where: {
      id: workTargetId,
      connectionId: lockedConnection.id,
      supportWorkspaceId: actor.workspace.id,
      departmentId: supportCase.departmentId ?? undefined,
      active: true,
      connection: { status: 'ACTIVE' },
      ...(capability === 'LINK' ? { allowLinkTasks: true } : { allowCreateTasks: true })
    },
    include: workTargetInclude
  });
  if (!supportCase.departmentId || !target) {
    throw new HttpError(400, 'No active allowlisted target is available for the Case Department');
  }
  return target;
}

async function lockTeamProject(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  projectId: string
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Project"
    WHERE "id" = ${projectId}::uuid AND "workspaceId" = ${workspaceId}::uuid
    FOR UPDATE
  `);
  if (!rows[0]) throw new HttpError(409, 'Target project is no longer available');
}

async function resolveCounterpartActor(
  tx: Pick<Prisma.TransactionClient, 'workspace' | 'workspaceMember'>,
  actor: RequestActor,
  workspaceId: string
): Promise<RequestActor> {
  assertHumanActor(actor);
  const [workspace, membership] = await Promise.all([
    tx.workspace.findUnique({ where: { id: workspaceId } }),
    tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.user.id } },
      select: { role: true }
    })
  ]);
  if (!workspace || !membership) throw new HttpError(403, 'Independent Team workspace membership is required');
  assertTeamWorkspace(workspace);
  return {
    workspace,
    user: actor.user,
    role: membership.role,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    source: actor.source
  };
}

async function canReadTeamProject(
  client: Pick<Prisma.TransactionClient, 'projectMember' | 'teamMember'>,
  actor: RequestActor,
  project: { id: string; teamId: string | null; leadId: string | null }
): Promise<boolean> {
  if (isWorkspaceAdminRole(actor.role) || project.leadId === actor.user.id || !project.teamId) return true;
  const [projectMembership, teamMembership] = await Promise.all([
    client.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: actor.user.id } },
      select: { id: true }
    }),
    client.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId: actor.user.id } },
      select: { id: true }
    })
  ]);
  return Boolean(projectMembership || teamMembership);
}

async function assertTeamProjectRelationWrite(
  client: Pick<Prisma.TransactionClient, 'projectMember' | 'teamMember'>,
  actor: RequestActor,
  project: { id: string; teamId: string | null; leadId: string | null }
): Promise<void> {
  if (await canWriteTeamProject(client, actor, project)) return;
  throw new HttpError(403, 'Team project relation-write access denied');
}

async function canWriteTeamProject(
  client: Pick<Prisma.TransactionClient, 'projectMember' | 'teamMember'>,
  actor: RequestActor,
  project: { id: string; teamId: string | null; leadId: string | null }
): Promise<boolean> {
  if (isWorkspaceAdminRole(actor.role) || project.leadId === actor.user.id) return true;
  const [projectMembership, teamMembership] = await Promise.all([
    client.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: actor.user.id } },
      select: { role: true }
    }),
    project.teamId
      ? client.teamMember.findUnique({
          where: { teamId_userId: { teamId: project.teamId, userId: actor.user.id } },
          select: { role: true }
        })
      : Promise.resolve(null)
  ]);
  if (projectMembership) {
    return projectMembership.role === 'LEAD' || projectMembership.role === 'MEMBER';
  }
  if (!project.teamId) {
    return actor.role === 'MEMBER' || actor.role === 'AGENT';
  }
  return Boolean(teamMembership && teamRoleCanWrite(teamMembership.role));
}

function teamRoleCanWrite(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER' || role === 'AGENT';
}

async function supportAccessIncludesDepartment(
  access: Awaited<ReturnType<typeof resolveSupportAccess>>,
  departmentId: string
): Promise<boolean> {
  if (access.workspaceWide || access.canConfigure || access.managedDepartmentIds.includes(departmentId)) return true;
  if (!access.memberMembershipIds.length) return false;
  return Boolean(await prisma.departmentMember.findFirst({
    where: { id: { in: access.memberMembershipIds }, departmentId, active: true },
    select: { id: true }
  }));
}

async function findReadableTeamTask(
  client: typeof prisma,
  actor: RequestActor,
  idOrKey: string
): Promise<{ id: string }> {
  const normalized = idOrKey.trim();
  const task = await client.task.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      OR: [
        ...(isUuid(normalized) ? [{ id: normalized }] : []),
        { key: normalized.toUpperCase() }
      ]
    },
    select: {
      id: true,
      project: { select: { id: true, teamId: true, leadId: true } }
    }
  });
  if (!task || !await canReadTeamProject(client, actor, task.project)) throw new HttpError(404, 'Task not found');
  return task;
}

async function replayLinkForIdempotency(
  tx: Prisma.TransactionClient,
  caseId: string,
  workspaceId: string,
  idempotencyKey: string,
  requestHash: string
): Promise<LinkRecord | null> {
  const existing = await tx.supportCaseTaskLink.findUnique({
    where: {
      supportWorkspaceId_idempotencyKey: {
        supportWorkspaceId: workspaceId,
        idempotencyKey
      }
    },
    select: linkSelect
  });
  if (!existing) return null;
  if (existing.caseId !== caseId || existing.idempotencyHash !== requestHash) {
    throw new HttpError(409, 'Idempotency key was already used for a different handoff');
  }
  return existing;
}

function linkCreateData(input: {
  actor: RequestActor;
  supportCase: LockedSupportCase;
  target: WorkTargetRecord;
  task: { id: string; workspaceId: string; key: string; status: TaskStatus };
  input: LinkSupportCaseToTaskInput | CreateLinkedTaskInput;
  requestHash: string;
  sanitizedTitle: string;
  now: Date;
}): Prisma.SupportCaseTaskLinkUncheckedCreateInput {
  return {
    idempotencyKey: input.input.idempotencyKey,
    idempotencyHash: input.requestHash,
    connectionId: input.target.connectionId,
    workTargetId: input.target.id,
    supportWorkspaceId: input.target.supportWorkspaceId,
    teamWorkspaceId: input.target.teamWorkspaceId,
    caseId: input.supportCase.id,
    taskId: input.task.id,
    taskWorkspaceId: input.task.workspaceId,
    relationType: input.input.relationType,
    handoffTitle: input.sanitizedTitle,
    handoffSummary: input.input.handoffSummary,
    teamWorkspaceNameSnapshot: input.target.connection.teamWorkspace.name,
    taskKeySnapshot: input.task.key,
    taskTitleSnapshot: input.sanitizedTitle,
    taskStatusSnapshot: input.task.status,
    supportWorkspaceNameSnapshot: input.target.connection.supportWorkspace.name,
    caseKeySnapshot: input.supportCase.key,
    // Never copy the original Case title; the explicit, previewed handoff title is the safe title.
    caseTitleSnapshot: input.sanitizedTitle,
    caseStatusSnapshot: coarseCaseStatus(input.supportCase.status),
    lastTaskSignalAt: input.now,
    lastCaseSignalAt: input.now,
    createdById: input.actor.user.id
  };
}

async function bumpSupportCaseForLink(tx: Prisma.TransactionClient, caseId: string) {
  return tx.supportCase.update({
    where: { id: caseId },
    data: { version: { increment: 1 } },
    select: { id: true, workspaceId: true, version: true }
  });
}

async function appendLinkCreatedAudit(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  supportCase: { id: string; workspaceId: string },
  taskId: string,
  link: LinkRecord,
  idempotencyKey: string,
  taskCreated = false
): Promise<void> {
  await appendSupportCaseEvent(tx, actor, supportCase, {
    action: taskCreated ? 'case.linked_task_created' : 'case.task_linked',
    after: serializeSupportLinkProjection(link),
    idempotencyKey
  });
  if (taskCreated) {
    await tx.activityLog.create({
      data: {
        workspaceId: link.teamWorkspaceId,
        actorId: actor.user.id,
        actorType: actor.actorType,
        actorRuntime: actor.actorRuntime,
        entityType: 'task',
        entityId: taskId,
        action: 'created_from_support_case',
        after: { key: link.taskKeySnapshot, title: link.taskTitleSnapshot, status: link.taskStatusSnapshot },
        source: actor.source
      }
    });
  }
  await tx.activityLog.create({
    data: {
      workspaceId: link.teamWorkspaceId,
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      entityType: 'task',
      entityId: taskId,
      action: 'support_case_linked',
      after: serializeTeamLinkProjection(link),
      source: actor.source
    }
  });
}

async function appendLinkProjectionEvents(
  tx: Prisma.TransactionClient,
  actorId: string,
  link: LinkRecord,
  operation: string
): Promise<SyncEvent[]> {
  return Promise.all([
    appendSyncEvent(tx, {
      workspaceId: link.supportWorkspaceId,
      entityType: 'support_case_task_link',
      entityId: link.id,
      operation,
      entityVersion: link.version,
      actorId,
      payload: { after: serializeSupportLinkProjection(link) }
    }),
    appendSyncEvent(tx, {
      workspaceId: link.teamWorkspaceId,
      entityType: 'support_case_task_link',
      entityId: link.id,
      operation,
      entityVersion: link.version,
      actorId,
      payload: { after: serializeTeamLinkProjection(link) }
    })
  ]);
}

async function lockSupportCases(tx: Prisma.TransactionClient, caseIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(caseIds)].sort();
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "SupportCase"
    WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY "id" FOR UPDATE
  `);
}

async function lockWorkspaceSyncStates(tx: Prisma.TransactionClient, workspaceIds: Iterable<string>): Promise<void> {
  for (const workspaceId of [...new Set(workspaceIds)].sort()) {
    await lockWorkspaceSyncState(tx, workspaceId);
  }
}

async function lockIdempotencyKey(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  idempotencyKey: string
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`support-task-link:${workspaceId}:${idempotencyKey}`}))
  `);
}

function assertCaseVersion(supportCase: LockedSupportCase, baseVersion: number): void {
  if (supportCase.version === baseVersion) return;
  throw new HttpError(409, 'Support Case changed on another client', {
    code: 'SUPPORT_VERSION_CONFLICT',
    current: {
      key: supportCase.key,
      status: supportCase.status,
      version: supportCase.version
    }
  });
}

function coarseCaseStatus(status: LockedSupportCase['status']): 'OPEN' | 'RESOLVED' | 'CLOSED' {
  if (status === 'RESOLVED') return 'RESOLVED';
  if (status === 'CLOSED') return 'CLOSED';
  return 'OPEN';
}

function linkRequestHash(operation: string, input: LinkSupportCaseToTaskInput | CreateLinkedTaskInput): string {
  return createHash('sha256').update(JSON.stringify({
    operation,
    workTargetId: input.workTargetId,
    relationType: input.relationType,
    handoffTitle: input.handoffTitle,
    handoffSummary: input.handoffSummary,
    ...('taskId' in input ? { taskId: input.taskId } : {
      parentTaskId: input.parentTaskId ?? null,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription ?? null,
      taskPriority: input.taskPriority
    })
  })).digest('hex');
}

function linkedTaskDescription(caseKey: string, description: string | undefined, handoffSummary: string): string {
  const value = [
    handoffSummary,
    description,
    `Support reference: ${caseKey}`
  ].filter((section): section is string => Boolean(section)).join('\n\n');
  if (value.length > WORK_DESCRIPTION_MAX_CHARS) {
    throw new HttpError(
      400,
      `Combined Team Task description is ${value.length} characters; the limit is ${WORK_DESCRIPTION_MAX_CHARS}`
    );
  }
  return value;
}

function linkedTaskComment(caseKey: string, handoffSummary: string): string {
  const value = `Support handoff ${caseKey}\n\n${handoffSummary}`;
  if (value.length > TASK_COMMENT_MAX_CHARS) {
    throw new HttpError(
      400,
      `Combined Team Task comment is ${value.length} characters; the limit is ${TASK_COMMENT_MAX_CHARS}`
    );
  }
  return value;
}

function caseIdentifierWhere(idOrKey: string): Prisma.SupportCaseWhereInput {
  const normalized = idOrKey.trim();
  return {
    OR: [
      ...(isUuid(normalized) ? [{ id: normalized }] : []),
      { key: normalized.toUpperCase() }
    ]
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertHumanActor(actor: RequestActor): void {
  if (!actor.credential && actor.user.kind === 'HUMAN' && actor.actorType === 'USER') return;
  throw new HttpError(403, 'Cross-workspace handoff requires one authorized human on both sides');
}

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function mapLinkUniqueError(error: unknown): unknown {
  if (!isUniqueConstraintError(error)) return error;
  return new HttpError(409, 'This Case–Task relation already exists or the idempotency key was reused');
}
