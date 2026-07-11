import {
  prisma,
  type Prisma,
  type ProjectRole,
  type WorkspaceRole
} from '@taskara/db';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { HttpError } from './http';

export interface WorkspaceAccess {
  workspaceId: string;
  userId: string;
  workspaceWide: boolean;
  teamIds: string[];
  projectIds: string[];
  teamRoles?: Record<string, WorkspaceRole>;
  projectRoles?: Record<string, ProjectRole>;
}

export async function resolveWorkspaceAccess(actor: RequestActor): Promise<WorkspaceAccess> {
  if (isWorkspaceAdminRole(actor.role)) {
    return {
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      workspaceWide: true,
      teamIds: [],
      projectIds: [],
      teamRoles: {},
      projectRoles: {}
    };
  }

  const [teamMemberships, projectMemberships, ledProjects] = await Promise.all([
    prisma.teamMember.findMany({
      where: {
        userId: actor.user.id,
        team: { workspaceId: actor.workspace.id }
      },
      select: { teamId: true, role: true }
    }),
    prisma.projectMember.findMany({
      where: {
        userId: actor.user.id,
        project: { workspaceId: actor.workspace.id }
      },
      select: { projectId: true, role: true }
    }),
    prisma.project.findMany({
      where: { workspaceId: actor.workspace.id, leadId: actor.user.id },
      select: { id: true }
    })
  ]);

  return {
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    workspaceWide: false,
    teamIds: [...new Set(teamMemberships.map((membership) => membership.teamId))],
    projectIds: [...new Set([
      ...projectMemberships.map((membership) => membership.projectId),
      ...ledProjects.map((project) => project.id)
    ])],
    teamRoles: Object.fromEntries(teamMemberships.map((membership) => [membership.teamId, membership.role])),
    projectRoles: Object.fromEntries(projectMemberships.map((membership) => [membership.projectId, membership.role]))
  };
}

export interface ProjectPlanningRecord {
  id: string;
  workspaceId: string;
  teamId: string | null;
  leadId: string | null;
}

type ProjectPlanningClient = Pick<Prisma.TransactionClient, 'project' | 'projectMember' | 'teamMember'>;

export function canManageProjectPlanningFromRoles(
  actor: Pick<RequestActor, 'role' | 'user'>,
  project: Pick<ProjectPlanningRecord, 'id' | 'teamId' | 'leadId'>,
  projectRole: ProjectRole | null | undefined,
  teamRole: WorkspaceRole | null | undefined
): boolean {
  if (isWorkspaceAdminRole(actor.role)) return true;
  if (project.leadId === actor.user.id) return true;
  if (projectRole) return projectRole === 'LEAD' || projectRole === 'MEMBER';
  if (!project.teamId) return false;
  return teamRole === 'OWNER' || teamRole === 'ADMIN' || teamRole === 'MEMBER';
}

export function canManageProjectPlanning(
  actor: Pick<RequestActor, 'role' | 'user'>,
  access: WorkspaceAccess,
  project: Pick<ProjectPlanningRecord, 'id' | 'teamId' | 'leadId'>
): boolean {
  return canManageProjectPlanningFromRoles(
    actor,
    project,
    access.projectRoles?.[project.id],
    project.teamId ? access.teamRoles?.[project.teamId] : undefined
  );
}

export async function assertCanManageProjectPlanning(
  actor: RequestActor,
  projectId: string,
  client: ProjectPlanningClient = prisma
): Promise<ProjectPlanningRecord> {
  const project = await client.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspace.id },
    select: { id: true, workspaceId: true, teamId: true, leadId: true }
  });
  if (!project) throw new HttpError(404, 'Project not found');

  if (isWorkspaceAdminRole(actor.role) || project.leadId === actor.user.id) return project;

  const projectMembership = await client.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: actor.user.id } },
    select: { role: true }
  });
  if (projectMembership) {
    if (projectMembership.role === 'LEAD' || projectMembership.role === 'MEMBER') return project;
    throw new HttpError(403, 'Milestone planning access denied');
  }

  if (!project.teamId) throw new HttpError(403, 'Milestone planning access denied');

  const teamMembership = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: project.teamId, userId: actor.user.id } },
    select: { role: true }
  });
  if (!teamMembership) throw new HttpError(404, 'Project not found');
  if (teamMembership.role === 'OWNER' || teamMembership.role === 'ADMIN' || teamMembership.role === 'MEMBER') {
    return project;
  }
  throw new HttpError(403, 'Milestone planning access denied');
}

export async function listAccessibleTeamIds(actor: RequestActor): Promise<string[] | null> {
  const access = await resolveWorkspaceAccess(actor);
  return access.workspaceWide ? null : access.teamIds;
}

export function canReadTeam(access: WorkspaceAccess, teamId: string | null | undefined): boolean {
  if (access.workspaceWide) return true;
  if (!teamId) return true;
  return access.teamIds.includes(teamId);
}

export function canReadProject(
  access: WorkspaceAccess,
  project: { id?: string | null; teamId?: string | null; leadId?: string | null } | null | undefined
): boolean {
  if (access.workspaceWide) return true;
  if (!project) return false;
  if (!project.teamId) return true;
  if (project.leadId === access.userId) return true;
  if (project.id && access.projectIds.includes(project.id)) return true;
  return access.teamIds.includes(project.teamId);
}

export function teamWhereForAccess(access: WorkspaceAccess): Prisma.TeamWhereInput {
  return {
    workspaceId: access.workspaceId,
    ...(access.workspaceWide ? {} : { id: { in: access.teamIds } })
  };
}

export function projectWhereForAccess(access: WorkspaceAccess): Prisma.ProjectWhereInput {
  const where: Prisma.ProjectWhereInput = { workspaceId: access.workspaceId };
  if (access.workspaceWide) return where;
  return {
    ...where,
    OR: projectAccessPredicates(access)
  };
}

export function taskWhereForAccess(access: WorkspaceAccess): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = { workspaceId: access.workspaceId };
  if (access.workspaceWide) return where;
  return {
    ...where,
    project: {
      OR: projectAccessPredicates(access)
    }
  };
}

export function viewWhereForAccess(access: WorkspaceAccess): Prisma.ViewWhereInput {
  if (access.workspaceWide) return { workspaceId: access.workspaceId };
  return {
    workspaceId: access.workspaceId,
    OR: [
      { ownerId: access.userId },
      { isShared: true }
    ]
  };
}

export async function assertActorCanAccessTeamId(actor: RequestActor, teamId: string): Promise<void> {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId: actor.workspace.id },
    select: { id: true }
  });

  if (!team) throw new HttpError(404, 'Team not found in this workspace');
  if (isWorkspaceAdminRole(actor.role)) return;

  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: actor.user.id } },
    select: { id: true }
  });

  if (!membership) throw new HttpError(403, 'Team access denied');
}

export async function assertActorCanAccessTeamSlug(actor: RequestActor, teamSlug: string): Promise<string> {
  const team = await prisma.team.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      slug: teamSlug
    },
    select: { id: true }
  });

  if (!team) throw new HttpError(404, 'Team not found in this workspace');
  await assertActorCanAccessTeamId(actor, team.id);
  return team.id;
}

function projectAccessPredicates(access: WorkspaceAccess): Prisma.ProjectWhereInput[] {
  const predicates: Prisma.ProjectWhereInput[] = [{ teamId: null }, { leadId: access.userId }];
  if (access.teamIds.length > 0) predicates.push({ teamId: { in: access.teamIds } });
  if (access.projectIds.length > 0) predicates.push({ id: { in: access.projectIds } });
  return predicates;
}
