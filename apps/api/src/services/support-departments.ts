import { Prisma, prisma } from '@taskara/db';
import {
  type addDepartmentMemberSchema,
  type createDepartmentSchema,
  type setSupportCredentialGrantSchema,
  type setSupportPermissionGrantSchema,
  type updateDepartmentMemberSchema,
  type updateDepartmentSchema
} from '@taskara/shared';
import type { z } from 'zod';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { HttpError } from './http';
import {
  appendSupportCaseEvent,
  caseEventSnapshot,
  lockSupportOwnershipGraph,
  supportCaseInclude
} from './support-cases';
import {
  assertCanConfigureSupport,
  bumpSupportAccessEpochs,
  departmentWhereForAccess,
  resolveSupportAccess
} from './support-access';
import { assertSupportWorkspace } from './workspace-mode';
import { applySupportSlaCaseEvent } from './support-sla';
import {
  appendSupportCaseSyncEvent,
  appendSupportDepartmentSyncEvent
} from './support-sync';

type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
type AddDepartmentMemberInput = z.infer<typeof addDepartmentMemberSchema>;
type UpdateDepartmentMemberInput = z.infer<typeof updateDepartmentMemberSchema>;
type SetSupportPermissionGrantInput = z.infer<typeof setSupportPermissionGrantSchema>;
type SetSupportCredentialGrantInput = z.infer<typeof setSupportCredentialGrantSchema>;

const departmentMemberInclude = {
  workspaceMember: {
    select: {
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true }
      }
    }
  }
} satisfies Prisma.DepartmentMemberInclude;

type DepartmentMemberView = Prisma.DepartmentMemberGetPayload<{ include: typeof departmentMemberInclude }>;

export async function listDepartments(actor: RequestActor) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  const departments = await prisma.department.findMany({
    where: departmentWhereForAccess(access),
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: {
      members: {
        where: { userId: actor.user.id },
        select: { id: true, role: true, active: true }
      }
    }
  });
  return {
    items: departments.map((department) => ({
      ...serializeDepartment(department, { includeRoutingSettings: access.canConfigure }),
      currentMembership: department.members[0] ?? null
    })),
    total: departments.length,
    accessEpoch: access.epoch.toString()
  };
}

export async function createDepartment(actor: RequestActor, input: CreateDepartmentInput) {
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  try {
    return await prisma.$transaction(async (tx) => {
      const department = await tx.department.create({
        data: {
          workspaceId: actor.workspace.id,
          name: input.name,
          slug: input.slug,
          description: input.description,
          routingSettings: input.routingSettings as Prisma.InputJsonValue | undefined
        }
      });
      await appendSupportDepartmentSyncEvent(tx, {
        workspaceId: actor.workspace.id,
        departmentId: department.id,
        operation: 'upsert',
        actorId: actor.user.id
      });
      return department;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new HttpError(409, 'Department slug already exists in this workspace');
    }
    throw error;
  }
}

export async function updateDepartment(
  actor: RequestActor,
  departmentId: string,
  input: UpdateDepartmentInput
) {
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  return prisma.$transaction(async (tx) => {
    await lockSupportOwnershipGraph(tx, actor.workspace.id);
    const existing = await tx.department.findFirst({
      where: { id: departmentId, workspaceId: actor.workspace.id }
    });
    if (!existing) throw new HttpError(404, 'Department not found');

    if (input.active === false && existing.active) {
      const openCaseCount = await tx.supportCase.count({
        where: {
          workspaceId: actor.workspace.id,
          departmentId,
          status: { not: 'CLOSED' }
        }
      });
      if (openCaseCount > 0) {
        throw new HttpError(409, 'Department owns non-closed Support Cases and cannot be deactivated');
      }
      const affected = await tx.departmentMember.findMany({
        where: { workspaceId: actor.workspace.id, departmentId, active: true },
        select: { userId: true }
      });
      await bumpSupportAccessEpochs(tx, actor.workspace.id, affected.map((item) => item.userId));
    }

    const updated = await tx.department.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        description: input.description,
        active: input.active,
        routingSettings: input.routingSettings === undefined
          ? undefined
          : input.routingSettings === null
            ? Prisma.JsonNull
          : input.routingSettings as Prisma.InputJsonValue
      }
    });
    await appendSupportDepartmentSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      departmentId: updated.id,
      operation: updated.active ? 'upsert' : 'remove',
      actorId: actor.user.id
    });
    return updated;
  });
}

export async function listDepartmentMembers(actor: RequestActor, departmentId: string) {
  const access = await resolveSupportAccess(actor);
  await assertCanReadDepartmentMembers(actor.workspace.id, departmentId, access);
  const members = await prisma.departmentMember.findMany({
    where: { workspaceId: actor.workspace.id, departmentId },
    orderBy: [{ active: 'desc' }, { role: 'desc' }, { createdAt: 'asc' }],
    include: departmentMemberInclude
  });
  return {
    items: members.map(serializeDepartmentMember),
    total: members.length,
    departmentId,
    accessEpoch: access.epoch.toString()
  };
}

export async function addDepartmentMember(
  actor: RequestActor,
  departmentId: string,
  input: AddDepartmentMemberInput
) {
  // Department membership is Support IAM: it grants Case visibility, and MANAGER grants access
  // to peers' Cases. Operational CONFIGURE credentials must not be able to mint that access.
  assertCanManageSupportIdentity(actor);
  return prisma.$transaction(async (tx) => {
    await lockSupportOwnershipGraph(tx, actor.workspace.id);
    const [department, workspaceMember] = await Promise.all([
      tx.department.findFirst({
        where: { id: departmentId, workspaceId: actor.workspace.id, active: true },
        select: { id: true }
      }),
      tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: input.userId } },
        include: { user: { select: { kind: true } } }
      })
    ]);
    if (!department) throw new HttpError(404, 'Active Department not found');
    if (!workspaceMember) throw new HttpError(400, 'User must belong to this workspace');
    if (workspaceMember.role === 'GUEST') {
      throw new HttpError(400, 'Guest users cannot belong to Support Departments');
    }
    if (workspaceMember.user.kind === 'AGENT') {
      throw new HttpError(400, 'Agent users require explicit Support credential grants');
    }

    const member = await tx.departmentMember.upsert({
      where: {
        workspaceId_departmentId_userId: {
          workspaceId: actor.workspace.id,
          departmentId,
          userId: input.userId
        }
      },
      update: { role: input.role, active: true, deactivatedAt: null },
      create: {
        workspaceId: actor.workspace.id,
        departmentId,
        userId: input.userId,
        role: input.role
      },
      include: departmentMemberInclude
    });
    await bumpSupportAccessEpochs(tx, actor.workspace.id, [input.userId]);
    return member;
  });
}

export async function updateDepartmentMember(
  actor: RequestActor,
  departmentId: string,
  userId: string,
  input: UpdateDepartmentMemberInput
) {
  assertCanManageSupportIdentity(actor);
  return prisma.$transaction(async (tx) => {
    await lockSupportOwnershipGraph(tx, actor.workspace.id);
    const existing = await tx.departmentMember.findUnique({
      where: {
        workspaceId_departmentId_userId: {
          workspaceId: actor.workspace.id,
          departmentId,
          userId
        }
      },
      include: departmentMemberInclude
    });
    if (!existing) throw new HttpError(404, 'Department member not found');

    if (input.active === false && existing.active) {
      await returnAssignedCasesToDepartmentInbox(tx, actor, existing);
    }
    const updated = await tx.departmentMember.update({
      where: { id: existing.id },
      data: {
        role: input.role,
        active: input.active,
        deactivatedAt: input.active === false
          ? new Date()
          : input.active === true
            ? null
            : undefined
      },
      include: departmentMemberInclude
    });
    if (input.role !== undefined || input.active !== undefined) {
      await bumpSupportAccessEpochs(tx, actor.workspace.id, [userId]);
    }
    return updated;
  });
}

export async function deactivateDepartmentMember(
  actor: RequestActor,
  departmentId: string,
  userId: string
): Promise<void> {
  await updateDepartmentMember(actor, departmentId, userId, { active: false });
}

/** Hard workspace removal clears every current assignee pointer before membership cascades run. */
export async function cleanupSupportWorkspaceMember(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  userId: string
): Promise<{ departmentMemberships: number; assignedCases: number }> {
  if (actor.workspace.mode !== 'SUPPORT') return { departmentMemberships: 0, assignedCases: 0 };
  await lockSupportOwnershipGraph(tx, actor.workspace.id);
  const memberships = await tx.departmentMember.findMany({
    where: { workspaceId: actor.workspace.id, userId },
    select: { id: true }
  });
  if (!memberships.length) return { departmentMemberships: 0, assignedCases: 0 };

  const assigned = await tx.supportCase.findMany({
    where: {
      workspaceId: actor.workspace.id,
      assigneeMembershipId: { in: memberships.map((membership) => membership.id) }
    },
    orderBy: { id: 'asc' },
    include: supportCaseInclude
  });
  if (assigned.length) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "SupportCase"
      WHERE "id" IN (${Prisma.join(assigned.map((item) => Prisma.sql`${item.id}::uuid`))})
      ORDER BY "id"
      FOR UPDATE
    `);
    for (const current of assigned) {
      const updated = await tx.supportCase.update({
        where: { id: current.id },
        data: { assigneeMembershipId: null, version: { increment: 1 } },
        include: supportCaseInclude
      });
      await appendSupportCaseEvent(tx, actor, updated, {
        action: 'case.assignee_workspace_membership_removed',
        before: caseEventSnapshot(current),
        after: caseEventSnapshot(updated),
        reason: 'Workspace membership removed'
      });
      await appendSupportCaseSyncEvent(tx, {
        workspaceId: actor.workspace.id,
        caseId: updated.id,
        caseVersion: updated.version,
        operation: 'route',
        actorId: actor.user.id,
        removedUserIds: [userId]
      });
    }
  }
  return { departmentMemberships: memberships.length, assignedCases: assigned.length };
}

export async function listSupportPermissionGrants(actor: RequestActor) {
  const access = await resolveSupportAccess(actor);
  assertCanManageSupportIdentity(actor);
  const grants = await prisma.supportPermissionGrant.findMany({
    where: { workspaceId: actor.workspace.id },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include: {
      workspaceMember: {
        select: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true } }
        }
      }
    }
  });
  return {
    items: grants.map((grant) => ({
      id: grant.id,
      userId: grant.userId,
      role: grant.role,
      createdAt: grant.createdAt.toISOString(),
      user: grant.workspaceMember.user
    })),
    total: grants.length,
    accessEpoch: access.epoch.toString()
  };
}

export async function setSupportPermissionGrant(
  actor: RequestActor,
  input: SetSupportPermissionGrantInput
) {
  assertSupportWorkspace(actor.workspace);
  assertCanManageSupportIdentity(actor);
  return prisma.$transaction(async (tx) => {
    const member = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: input.userId } },
      include: { user: { select: { kind: true } } }
    });
    if (!member) throw new HttpError(400, 'User must belong to this workspace');
    if (member.role === 'GUEST') {
      throw new HttpError(400, 'Guest users cannot receive Support permission grants');
    }
    if (member.user.kind === 'AGENT') {
      throw new HttpError(400, 'Agent users require explicit Support credential grants');
    }
    const grant = await tx.supportPermissionGrant.upsert({
      where: {
        workspaceId_userId_role: {
          workspaceId: actor.workspace.id,
          userId: input.userId,
          role: input.role
        }
      },
      update: {},
      create: { workspaceId: actor.workspace.id, userId: input.userId, role: input.role }
    });
    await bumpSupportAccessEpochs(tx, actor.workspace.id, [input.userId]);
    return grant;
  });
}

export async function deleteSupportPermissionGrant(
  actor: RequestActor,
  input: SetSupportPermissionGrantInput
): Promise<boolean> {
  assertSupportWorkspace(actor.workspace);
  assertCanManageSupportIdentity(actor);
  return prisma.$transaction(async (tx) => {
    const result = await tx.supportPermissionGrant.deleteMany({
      where: { workspaceId: actor.workspace.id, userId: input.userId, role: input.role }
    });
    if (result.count) await bumpSupportAccessEpochs(tx, actor.workspace.id, [input.userId]);
    return result.count > 0;
  });
}

export async function listSupportCredentialGrants(actor: RequestActor) {
  const access = await resolveSupportAccess(actor);
  assertCanManageSupportIdentity(actor);
  const grants = await prisma.supportCredentialGrant.findMany({
    where: { workspaceId: actor.workspace.id },
    orderBy: [{ credentialId: 'asc' }, { scope: 'asc' }]
  });
  return {
    items: grants.map((grant) => ({ ...grant, createdAt: grant.createdAt.toISOString() })),
    total: grants.length,
    accessEpoch: access.epoch.toString()
  };
}

export async function setSupportCredentialGrant(
  actor: RequestActor,
  input: SetSupportCredentialGrantInput
) {
  assertSupportWorkspace(actor.workspace);
  assertCanManageSupportIdentity(actor);
  return prisma.$transaction(async (tx) => {
    const credential = await tx.agentCredential.findFirst({
      where: {
        id: input.credentialId,
        workspaceId: actor.workspace.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      select: { id: true, userId: true }
    });
    if (!credential) throw new HttpError(404, 'Active agent credential not found');
    const grant = await tx.supportCredentialGrant.upsert({
      where: {
        workspaceId_credentialId_scope: {
          workspaceId: actor.workspace.id,
          credentialId: input.credentialId,
          scope: input.scope
        }
      },
      update: {},
      create: {
        workspaceId: actor.workspace.id,
        credentialId: input.credentialId,
        scope: input.scope
      }
    });
    // Credential actors also carry a user-partitioned memory store; reset it atomically when
    // their scopes move.
    await bumpSupportAccessEpochs(tx, actor.workspace.id, [credential.userId]);
    return grant;
  });
}

export async function deleteSupportCredentialGrant(
  actor: RequestActor,
  input: SetSupportCredentialGrantInput
): Promise<boolean> {
  assertSupportWorkspace(actor.workspace);
  assertCanManageSupportIdentity(actor);
  return prisma.$transaction(async (tx) => {
    const credential = await tx.agentCredential.findFirst({
      where: { id: input.credentialId, workspaceId: actor.workspace.id },
      select: { userId: true }
    });
    const result = await tx.supportCredentialGrant.deleteMany({
      where: {
        workspaceId: actor.workspace.id,
        credentialId: input.credentialId,
        scope: input.scope
      }
    });
    if (result.count && credential) {
      await bumpSupportAccessEpochs(tx, actor.workspace.id, [credential.userId]);
    }
    return result.count > 0;
  });
}

/**
 * Support policy configuration is not Support IAM administration. A CONFIGURE credential may
 * manage operational policy, but it must never grant Case/triage scopes or Department membership
 * (including MANAGER peer visibility). Identity grants require a human workspace owner/admin.
 */
function assertCanManageSupportIdentity(actor: RequestActor): void {
  if (
    !actor.credential
    && actor.user.kind === 'HUMAN'
    && isWorkspaceAdminRole(actor.role)
  ) return;
  throw new HttpError(403, 'Human workspace administrator access required');
}

export function serializeDepartment(department: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  active: boolean;
  routingSettings: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}, options: { includeRoutingSettings?: boolean } = {}) {
  const serialized = {
    id: department.id,
    workspaceId: department.workspaceId,
    name: department.name,
    slug: department.slug,
    description: department.description,
    active: department.active,
    createdAt: department.createdAt.toISOString(),
    updatedAt: department.updatedAt.toISOString()
  };
  return options.includeRoutingSettings
    ? { ...serialized, routingSettings: department.routingSettings }
    : serialized;
}

export function serializeDepartmentMember(member: DepartmentMemberView) {
  return {
    id: member.id,
    workspaceId: member.workspaceId,
    departmentId: member.departmentId,
    userId: member.userId,
    role: member.role,
    active: member.active,
    deactivatedAt: member.deactivatedAt?.toISOString() ?? null,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
    user: member.workspaceMember.user
  };
}

async function assertCanReadDepartmentMembers(
  workspaceId: string,
  departmentId: string,
  access: Awaited<ReturnType<typeof resolveSupportAccess>>
): Promise<void> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId },
    select: { id: true }
  });
  if (!department) throw new HttpError(404, 'Department not found');
  if (
    !access.credentialActor
    && (access.canConfigure || access.managedDepartmentIds.includes(departmentId))
  ) return;
  throw new HttpError(404, 'Department not found');
}

async function returnAssignedCasesToDepartmentInbox(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  membership: DepartmentMemberView
): Promise<void> {
  const assigned = await tx.supportCase.findMany({
    where: {
      workspaceId: actor.workspace.id,
      assigneeMembershipId: membership.id,
      status: { not: 'CLOSED' }
    },
    orderBy: { id: 'asc' },
    include: supportCaseInclude
  });
  if (!assigned.length) return;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "SupportCase"
    WHERE "id" IN (${Prisma.join(assigned.map((item) => Prisma.sql`${item.id}::uuid`))})
    ORDER BY "id"
    FOR UPDATE
  `);

  for (const current of assigned) {
    const changedAt = new Date();
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: { assigneeMembershipId: null, version: { increment: 1 } },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.returned_to_department_inbox',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: 'Department membership deactivated'
    });
    if (updated.status !== 'RESOLVED' && updated.status !== 'CLOSED') {
      const sla = await applySupportSlaCaseEvent(tx, {
        workspaceId: updated.workspaceId,
        caseId: updated.id,
        event: 'UNASSIGNED',
        at: changedAt
      });
      updated.nextSlaDueAt = sla.nextSlaDueAt;
    }
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'route',
      actorId: actor.user.id,
      removedUserIds: [membership.userId]
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
