import {
  prisma,
  type Prisma,
  type ProjectRole,
  type WorkspaceRole
} from '@taskara/db';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { workTaskWhere } from './measured-work';
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

/** Everything `filterUsersWithTaskAccess` touches, so a transaction client satisfies it too. */
type TaskAccessClient = Pick<
  Prisma.TransactionClient,
  'task' | 'workspaceMember' | 'teamMember' | 'projectMember'
>;

/**
 * Of these people, the ones who could open this task — asked about a list rather than about the
 * caller.
 *
 * Every other function here answers "what may *the actor* read", because a request has one reader.
 * A notification has a recipient who is not the actor, and #57 is what happens when nobody asks:
 * a mention resolved against workspace membership writes a row naming a task behind a team wall.
 *
 * **It does not restate the access rule.** The decision is `canReadProject`, called once per
 * candidate with that candidate's own facts; the queries below only gather those facts in bulk. A
 * mirror-image predicate over `WorkspaceMember` would have been one query instead of three and a
 * second spelling of a rule that already exists — which is the drift #37 was filed about, in the
 * one place where the two copies disagreeing means a disclosure rather than a wrong number.
 *
 * A teamless project short-circuits before any of it: `canReadProject` returns true for one without
 * consulting the reader at all, so there is nothing to look up.
 */
export async function filterUsersWithTaskAccess(
  client: TaskAccessClient,
  input: { workspaceId: string; taskId: string; userIds: string[] }
): Promise<string[]> {
  if (!input.userIds.length) return [];

  const task = await client.task.findFirst({
    where: { id: input.taskId, workspaceId: input.workspaceId },
    select: { project: { select: { id: true, teamId: true, leadId: true } } }
  });
  const project = task?.project;
  if (!project) return [];
  if (!project.teamId) return [...input.userIds];
  const teamId = project.teamId;

  const [members, teamMemberships, projectMemberships] = await Promise.all([
    // The role is read to spot an admin, who reads the whole workspace. Without it a workspace
    // owner on no team would stop being notified about their own team's work.
    //
    // measured-people:allow — Resolves each candidate's role to answer an access question; not a people metric.
    client.workspaceMember.findMany({
      where: { workspaceId: input.workspaceId, userId: { in: input.userIds } },
      select: { userId: true, role: true }
    }),
    client.teamMember.findMany({
      where: { teamId, userId: { in: input.userIds } },
      select: { userId: true }
    }),
    client.projectMember.findMany({
      where: { projectId: project.id, userId: { in: input.userIds } },
      select: { userId: true }
    })
  ]);

  const roleByUserId = new Map(members.map((member) => [member.userId, member.role]));
  const onTeam = new Set(teamMemberships.map((membership) => membership.userId));
  const onProject = new Set(projectMemberships.map((membership) => membership.userId));

  return input.userIds.filter((userId) => {
    const role = roleByUserId.get(userId);
    // Not a member of this workspace at all. Nothing should be addressing them, and a membership
    // that vanished mid-transaction is not a reason to widen the answer.
    if (!role) return false;
    return canReadProject(
      {
        workspaceId: input.workspaceId,
        userId,
        workspaceWide: isWorkspaceAdminRole(role),
        teamIds: onTeam.has(userId) ? [teamId] : [],
        projectIds: onProject.has(userId) ? [project.id] : []
      },
      project
    );
  });
}

/**
 * Who may read a **meeting**: its participants, its owner, its creator, and workspace admins.
 *
 * Team and project membership deliberately do not enter, which is why this is not a second spelling
 * of `projectWhereForAccess` — it is a different rule about a different entity, and the meeting's
 * *contents* are gated separately in `services/meeting-visibility.ts`.
 *
 * It lives here because #60 needed it in two places: the meeting routes, and the inbox, whose
 * `meetingId` branch had the same drift #57 fixed on `taskId` — a meeting you were removed from
 * went on delivering its title. The old copy in `services/meetings.ts` took a `RequestActor` and a
 * `MeetingAccessScope` it ignored; the scope is deleted and the actor is unnecessary, since
 * `access` already carries the reader's id and whether they read everything.
 */
export function meetingWhereForAccess(
  access: WorkspaceAccess,
  options?: { mineOnly?: boolean }
): Prisma.MeetingWhereInput {
  const onIt: Prisma.MeetingWhereInput[] = [
    { participants: { some: { userId: access.userId } } },
    { ownerId: access.userId },
    { createdById: access.userId }
  ];
  // `mine` is a filter the reader asked for, so it narrows an admin too.
  if (options?.mineOnly) return { OR: onIt };
  if (access.workspaceWide) return {};
  return { OR: onIt };
}

/**
 * Who may read an **announcement**: its recipients, its creator, and workspace admins — the rule
 * `GET /announcements/:id` has always enforced, written once.
 *
 * Deliberately says nothing about `status`. Whether a draft belongs in a particular list is a
 * question about that list, and `GET /announcements` still answers it for itself.
 *
 * The drift it closes in the inbox is not a project wall: `updateAnnouncement` can **replace** the
 * recipient list, and the notification rows written to the old recipients outlive it.
 */
export function announcementWhereForAccess(access: WorkspaceAccess): Prisma.AnnouncementWhereInput {
  if (access.workspaceWide) return { workspaceId: access.workspaceId };
  return {
    workspaceId: access.workspaceId,
    // The creator branch matters even though only an admin may post one today: it is the rule
    // `GET /announcements/:id` already enforces through `canManageAnnouncement`, and dropping it
    // here would make the list disagree with the detail the day that changes.
    OR: [
      { creatorId: access.userId },
      { recipients: { some: { userId: access.userId } } }
    ]
  };
}

/**
 * Who may read a **knowledge space**: everyone for a workspace space, the team for a team space,
 * and `canReadProject`'s population for a project space.
 *
 * Composes `projectWhereForAccess` rather than re-spelling it, which is why the project branch stays
 * correct when the project rule changes. Extracted from `services/knowledge.ts`, where it was an
 * async function over a `RequestActor` and therefore unusable from anything holding only an
 * `access` — the inbox and the activity classifier both needed it.
 */
export function knowledgeSpaceWhereForAccess(access: WorkspaceAccess): Prisma.KnowledgeSpaceWhereInput {
  if (access.workspaceWide) return { workspaceId: access.workspaceId };
  return {
    workspaceId: access.workspaceId,
    OR: [
      { type: 'WORKSPACE' },
      { teamId: { in: access.teamIds } },
      { type: 'PROJECT', project: projectWhereForAccess(access) }
    ]
  };
}

/**
 * The per-member rollup the member directory shows, narrowed on **both** axes.
 *
 * The measurement axis was swept long ago: `workTaskWhere` appears inside seven `_count` selects,
 * each with a comment explaining that an outer `where` does not narrow a relation count. The
 * **access** axis never got the same pass, and that is #59's shape D. `GET /users` and
 * `/sync/bootstrap` published, for every member of the workspace, how many tasks they hold and how
 * many comments they have written — counted over every project including the ones the reader cannot
 * open. Counts only, but a headcount of work behind a wall is still a fact about that work, and
 * `GET /leaderboard` already puts `taskWhereForAccess` on the identical per-person rollup. Two
 * places disagreed and one of them was wrong on purpose; this is the other one catching up.
 *
 * Consequence, accepted and worth stating: two readers now see **different numbers** beside the same
 * person. That is the honest answer — "work you can see, held by this person" is a number a reader
 * can act on, where the old one silently mixed in work they cannot open.
 *
 * `assignedTasks` deliberately carries no `workTaskWhere`: an EFFORT cannot hold an `assigneeId` at
 * all (CHECK `Task_effort_has_no_work_fields`), so a filter there would change no row and would read
 * as distrust of the constraint. `reportedTasks` does carry it, because `createTask` force-sets
 * `reporterId` and this count is lifetime — whoever files an effort would otherwise be permanently
 * +1 in the directory's "reported tasks" column.
 */
export function memberWorkCountSelect(access: WorkspaceAccess) {
  const readable = taskWhereForAccess(access);
  return {
    assignedTasks: { where: readable },
    reportedTasks: { where: { ...readable, ...workTaskWhere } },
    // A comment has no project of its own; it inherits the one its task lives in.
    comments: { where: { task: { is: readable } } }
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
