import {
  prisma,
  type Prisma,
  type SupportCredentialScope
} from '@taskara/db';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { HttpError } from './http';
import { assertSupportWorkspace } from './workspace-mode';

type SupportAccessClient = Pick<
  Prisma.TransactionClient,
  'departmentMember' | 'supportPermissionGrant' | 'supportCredentialGrant' | 'supportAccessEpoch'
>;

export interface SupportAccess {
  workspaceId: string;
  userId: string;
  /** True only for a human administrator/supervisor or a credential with explicit CASE_READ. */
  workspaceWide: boolean;
  triager: boolean;
  supervisor: boolean;
  managedDepartmentIds: string[];
  memberMembershipIds: string[];
  credentialScopes: SupportCredentialScope[];
  credentialActor: boolean;
  canWriteCases: boolean;
  canConfigure: boolean;
  canIntake: boolean;
  epoch: bigint;
}

export interface SupportCaseAccessRecord {
  workspaceId: string;
  departmentId: string | null;
  assigneeMembershipId: string | null;
}

/**
 * The one human/credential authorization resolver for the Support domain.
 *
 * Credential actors are deliberately evaluated on a separate branch. In particular, the OWNER
 * role carried by an agent's WorkspaceMember never turns into implicit supervisor access.
 */
export async function resolveSupportAccess(
  actor: RequestActor,
  client: SupportAccessClient = prisma
): Promise<SupportAccess> {
  assertSupportWorkspace(actor.workspace);

  const epochPromise = client.supportAccessEpoch.findUnique({
    where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: actor.user.id } },
    select: { epoch: true }
  });

  if (actor.credential) {
    const [grants, epochRow] = await Promise.all([
      client.supportCredentialGrant.findMany({
        where: {
          workspaceId: actor.workspace.id,
          credentialId: actor.credential.id
        },
        select: { scope: true }
      }),
      epochPromise
    ]);
    const credentialScopes = [...new Set(grants.map((grant) => grant.scope))];
    return {
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      workspaceWide: credentialScopes.includes('CASE_READ'),
      triager: credentialScopes.includes('TRIAGE'),
      supervisor: false,
      managedDepartmentIds: [],
      memberMembershipIds: [],
      credentialScopes,
      credentialActor: true,
      canWriteCases: credentialScopes.includes('CASE_WRITE'),
      canConfigure: credentialScopes.includes('CONFIGURE'),
      canIntake: credentialScopes.includes('INTAKE'),
      epoch: epochRow?.epoch ?? 1n
    };
  }

  // Guests have no Support access, and an agent User never inherits human Department/grant facts
  // through a browser session. Agent automation must present a credential with explicit scopes.
  if (actor.role === 'GUEST' || actor.user.kind === 'AGENT') {
    const epochRow = await epochPromise;
    return {
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      workspaceWide: false,
      triager: false,
      supervisor: false,
      managedDepartmentIds: [],
      memberMembershipIds: [],
      credentialScopes: [],
      credentialActor: false,
      canWriteCases: false,
      canConfigure: false,
      canIntake: false,
      epoch: epochRow?.epoch ?? 1n
    };
  }

  const [memberships, grants, epochRow] = await Promise.all([
    client.departmentMember.findMany({
      where: {
        workspaceId: actor.workspace.id,
        userId: actor.user.id,
        active: true,
        department: { active: true }
      },
      select: { id: true, departmentId: true, role: true }
    }),
    client.supportPermissionGrant.findMany({
      where: { workspaceId: actor.workspace.id, userId: actor.user.id },
      select: { role: true }
    }),
    epochPromise
  ]);

  const supervisor = grants.some((grant) => grant.role === 'SUPERVISOR');
  const workspaceAdmin = isWorkspaceAdminRole(actor.role);
  const workspaceWide = workspaceAdmin || supervisor;
  return {
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    workspaceWide,
    triager: workspaceWide || grants.some((grant) => grant.role === 'TRIAGER'),
    supervisor,
    managedDepartmentIds: memberships
      .filter((membership) => membership.role === 'MANAGER')
      .map((membership) => membership.departmentId),
    memberMembershipIds: memberships.map((membership) => membership.id),
    credentialScopes: [],
    credentialActor: false,
    canWriteCases: true,
    // SUPERVISOR is an operational cross-Department role. It deliberately does not grant member,
    // billing, Department, connector, or workspace administration authority.
    canConfigure: workspaceAdmin,
    canIntake: workspaceWide
      || grants.some((grant) => grant.role === 'TRIAGER')
      || memberships.some((membership) => membership.role === 'MANAGER'),
    epoch: epochRow?.epoch ?? 1n
  };
}

export function supportCaseWhereForAccess(access: SupportAccess): Prisma.SupportCaseWhereInput {
  if (access.workspaceWide) return { workspaceId: access.workspaceId };

  const alternatives: Prisma.SupportCaseWhereInput[] = [];
  if (access.triager) alternatives.push({ departmentId: null });
  if (access.managedDepartmentIds.length) {
    alternatives.push({ departmentId: { in: access.managedDepartmentIds } });
  }
  if (access.memberMembershipIds.length) {
    alternatives.push({ assigneeMembershipId: { in: access.memberMembershipIds } });
  }

  if (!alternatives.length) {
    return { workspaceId: access.workspaceId, id: { in: [] } };
  }

  return {
    workspaceId: access.workspaceId,
    OR: alternatives
  };
}

export function canReadSupportCase(access: SupportAccess, supportCase: SupportCaseAccessRecord): boolean {
  if (supportCase.workspaceId !== access.workspaceId) return false;
  if (access.workspaceWide) return true;
  if (access.triager && supportCase.departmentId === null) return true;
  if (supportCase.departmentId && access.managedDepartmentIds.includes(supportCase.departmentId)) return true;
  return Boolean(
    supportCase.assigneeMembershipId
    && access.memberMembershipIds.includes(supportCase.assigneeMembershipId)
  );
}

export function assertCanTriage(access: SupportAccess): void {
  if (access.workspaceWide || access.triager) return;
  throw new HttpError(403, 'Support triage access required');
}

/** Authorizes an ownership command from the Case's current ownership, never its destination. */
export function assertCanDispatch(
  access: SupportAccess,
  supportCase: SupportCaseAccessRecord,
  target: { departmentId: string; assigneeMembershipId: string | null }
): void {
  if (!canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  if (access.workspaceWide && access.canWriteCases) return;
  if (access.credentialActor) throw new HttpError(403, 'Support Case write scope required');
  if (access.triager && supportCase.departmentId === null) return;
  if (supportCase.departmentId && access.managedDepartmentIds.includes(supportCase.departmentId)) return;

  // An assigned member may return only their own Case to the same Department Inbox.
  const returningOwnCase = Boolean(
    supportCase.departmentId
    && supportCase.departmentId === target.departmentId
    && supportCase.assigneeMembershipId
    && access.memberMembershipIds.includes(supportCase.assigneeMembershipId)
    && target.assigneeMembershipId === null
  );
  if (returningOwnCase) return;
  throw new HttpError(403, 'Support dispatch access denied');
}

export function assertCanWorkCase(access: SupportAccess, supportCase: SupportCaseAccessRecord): void {
  if (!canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  if (!access.canWriteCases) throw new HttpError(403, 'Support Case write scope required');
  if (access.workspaceWide) return;
  if (access.triager && supportCase.departmentId === null) return;
  if (supportCase.departmentId && access.managedDepartmentIds.includes(supportCase.departmentId)) return;
  if (
    supportCase.assigneeMembershipId
    && access.memberMembershipIds.includes(supportCase.assigneeMembershipId)
  ) return;
  throw new HttpError(403, 'Support Case work access denied');
}

export function assertCanConfigureSupport(access: SupportAccess): void {
  if (access.canConfigure) return;
  throw new HttpError(403, 'Support configuration access required');
}

export function assertCanCreateSupportCase(
  access: SupportAccess,
  departmentId?: string | null
): void {
  if (access.credentialActor) {
    if (access.canIntake) return;
    throw new HttpError(403, 'Support intake scope required');
  }
  if (access.workspaceWide || access.triager) return;
  if (departmentId && access.managedDepartmentIds.includes(departmentId)) return;
  throw new HttpError(403, 'Support Case intake access denied');
}

export async function bumpSupportAccessEpochs(
  client: Pick<Prisma.TransactionClient, 'supportAccessEpoch'>,
  workspaceId: string,
  userIds: Iterable<string>
): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  await Promise.all(uniqueUserIds.map((userId) => client.supportAccessEpoch.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, epoch: 2n },
    update: { epoch: { increment: 1n } }
  })));
}

export function departmentWhereForAccess(access: SupportAccess): Prisma.DepartmentWhereInput {
  if (access.workspaceWide || access.triager) return { workspaceId: access.workspaceId };
  const departmentIds = [...new Set(access.managedDepartmentIds)];
  if (!departmentIds.length && !access.memberMembershipIds.length) {
    return { workspaceId: access.workspaceId, id: { in: [] } };
  }
  return {
    workspaceId: access.workspaceId,
    OR: [
      ...(departmentIds.length ? [{ id: { in: departmentIds } }] : []),
      ...(access.memberMembershipIds.length
        ? [{ members: { some: { id: { in: access.memberMembershipIds }, active: true } } }]
        : [])
    ]
  };
}
