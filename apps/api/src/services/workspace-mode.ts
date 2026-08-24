import { prisma, type Prisma, type WorkspaceRole } from '@taskara/db';
import type { WorkspaceModeValue } from '@taskara/shared';
import { HttpError } from './http';

export const commonWorkspaceCapabilities = [
  'common.members',
  'common.settings',
  'common.inbox',
  'common.knowledge'
] as const;

export const teamWorkspaceCapabilities = [
  'team.tasks',
  'team.projects',
  'team.teams',
  'team.milestones',
  'team.daily-reports',
  'team.manager-os',
  'team.communications'
] as const;

export const supportWorkspaceCapabilities = [
  'support.cases',
  'support.departments',
  'support.triage',
  'support.recovery',
  'support.reports'
] as const;

export type WorkspaceCapability =
  | (typeof commonWorkspaceCapabilities)[number]
  | (typeof teamWorkspaceCapabilities)[number]
  | (typeof supportWorkspaceCapabilities)[number];

const commonReadPermissions = [
  'common.members.read',
  'common.settings.read',
  'common.inbox.read',
  'common.knowledge.read'
] as const;

const commonAdminPermissions = [
  'common.members.manage',
  'common.settings.manage',
  'common.knowledge.manage'
] as const;

const teamReadPermissions = [
  'team.tasks.read',
  'team.projects.read',
  'team.teams.read',
  'team.milestones.read',
  'team.daily-reports.read',
  'team.manager-os.read',
  'team.communications.read'
] as const;

const teamMemberPermissions = [
  'team.tasks.create',
  'team.daily-reports.create',
  'team.communications.create'
] as const;

const teamAdminPermissions = [
  'team.projects.manage',
  'team.teams.manage',
  'team.milestones.manage',
  'team.manager-os.manage'
] as const;

const supportAdminPermissions = [
  'support.setup',
  'support.cases.create',
  'support.triage.read',
  'support.department-inbox.read',
  'support.cases.mine.read',
  'support.recovery.read',
  'support.departments.manage',
  'support.reports.read'
] as const;

export type WorkspacePermission =
  | (typeof commonReadPermissions)[number]
  | (typeof commonAdminPermissions)[number]
  | (typeof teamReadPermissions)[number]
  | (typeof teamMemberPermissions)[number]
  | (typeof teamAdminPermissions)[number]
  | (typeof supportAdminPermissions)[number];

type WorkspaceWithMode = { mode: WorkspaceModeValue };
type WorkspaceModeClient = Pick<Prisma.TransactionClient, 'workspace'>;

export function workspaceCapabilities(mode: WorkspaceModeValue): WorkspaceCapability[] {
  return [
    ...commonWorkspaceCapabilities,
    ...(mode === 'TEAM' ? teamWorkspaceCapabilities : supportWorkspaceCapabilities)
  ];
}
/**
 * Coarse shell permissions only. Entity-level access remains owned by the domain access services;
 * receiving `team.tasks.read`, for example, never bypasses project/team visibility.
 */
export function workspacePermissions(mode: WorkspaceModeValue, role: WorkspaceRole): WorkspacePermission[] {
  const admin = role === 'OWNER' || role === 'ADMIN';
  const permissions: WorkspacePermission[] = [...commonReadPermissions];
  if (admin) permissions.push(...commonAdminPermissions);

  if (mode === 'TEAM') {
    permissions.push(...teamReadPermissions);
    if (role !== 'GUEST') permissions.push(...teamMemberPermissions);
    if (admin) permissions.push(...teamAdminPermissions);
  } else if (admin) {
    permissions.push(...supportAdminPermissions);
  }

  return permissions;
}

export function assertWorkspaceMode(
  workspace: WorkspaceWithMode,
  requiredMode: WorkspaceModeValue
): void {
  if (workspace.mode === requiredMode) return;
  throw new HttpError(
    409,
    `This operation is only available in ${requiredMode} workspaces; ${workspace.mode} is active`
  );
}

export function assertTeamWorkspace(workspace: WorkspaceWithMode): void {
  assertWorkspaceMode(workspace, 'TEAM');
}

export function assertSupportWorkspace(workspace: WorkspaceWithMode): void {
  assertWorkspaceMode(workspace, 'SUPPORT');
}

/**
 * For non-HTTP entry points that receive only a workspace id. The lookup happens before any
 * domain identifier is resolved or side effect is performed.
 */
export async function assertTeamWorkspaceId(
  workspaceId: string,
  client: WorkspaceModeClient = prisma
): Promise<void> {
  const workspace = await client.workspace.findUnique({
    where: { id: workspaceId },
    select: { mode: true }
  });
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  assertTeamWorkspace(workspace);
}
