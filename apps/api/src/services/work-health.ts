import { prisma, type Prisma } from '@taskara/db';
import type { RequestActor } from './actor';
import {
  projectWhereForAccess,
  resolveWorkspaceAccess,
  taskWhereForAccess,
  type WorkspaceAccess
} from './team-access';
import {
  addTaskProgressStartedAt,
  serializeTaskForResponse,
  taskInclude
} from './tasks';

const activeStatuses = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] as const;
const executionStatuses = new Set<string>(activeStatuses);
const queueLimit = 24;
const activeTaskLimit = 2000;

export const workHealthThresholds = {
  dailyWeightLimit: 8,
  staleAfterHours: 72,
  blockedSlaHours: 24,
  reviewSlaHours: 24,
  dueSoonHours: 48
};

export type HealthTask = Prisma.TaskGetPayload<{ include: typeof taskInclude }> & {
  progressStartedAt?: string | null;
  activeReviewRequest?: {
    id: string;
    reviewerId: string;
    requestedAt: string;
    dueAt: string | null;
  } | null;
};

export type HealthProject = Prisma.ProjectGetPayload<{
  include: {
    team: { select: { id: true; name: true; slug: true } };
    lead: { select: { id: true; name: true; email: true; avatarUrl: true } };
    healthUpdates: {
      select: {
        id: true;
        health: true;
        summary: true;
        risks: true;
        decisionsNeeded: true;
        nextUpdateDueAt: true;
        createdAt: true;
      };
    };
  };
}>;

export type HealthUser = Prisma.WorkspaceMemberGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        name: true;
        email: true;
        phone: true;
        mattermostUsername: true;
        avatarUrl: true;
      };
    };
  };
}>;

export interface ComputeWorkHealthSummaryInput {
  access: WorkspaceAccess;
  activeTasks: HealthTask[];
  activeTotal: number;
  statusCounts?: Partial<Record<string, number>>;
  backlogTasks: HealthTask[];
  backlogTotal: number;
  members: HealthUser[];
  projects: HealthProject[];
  now: Date;
  visibleUserIds?: string[];
  capacities?: Array<{ userId: string; dailyWeightLimit: number; active: boolean }>;
}

export interface WorkHealthSummary {
  generatedAt: string;
  scope: {
    workspaceWide: boolean;
    teamIds: string[];
    projectIds: string[];
  };
  thresholds: typeof workHealthThresholds;
  overview: {
    activeTasks: number;
    loadedActiveTasks: number;
    truncated: boolean;
    overdueTasks: number;
    blockedTasks: number;
    reviewTasks: number;
      staleTasks: number;
      unassignedActiveTasks: number;
      backlogTasks: number;
      statusCounts: Record<'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'BLOCKED' | 'DONE' | 'CANCELED', number>;
      overloadedPeople: number;
      peopleWithoutActiveWork: number;
   };
  attention: WorkHealthAttentionItem[];
  people: WorkHealthPerson[];
  queues: {
    overdue: HealthTask[];
    blocked: HealthTask[];
    review: HealthTask[];
    stale: HealthTask[];
    unassigned: HealthTask[];
    backlog: HealthTask[];
  };
  projects: WorkHealthProject[];
}

export interface WorkHealthAttentionItem {
  id: string;
  reason:
    | 'overdue_task'
    | 'blocked_task'
    | 'review_waiting'
    | 'backlog_triage'
    | 'stale_task'
    | 'unassigned_due_soon'
    | 'overloaded_person'
    | 'person_without_active_work'
    | 'project_at_risk'
    | 'project_update_due';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  title: string;
  description: string;
  actionLabel: string;
  entityType: 'task' | 'user' | 'project';
  task?: HealthTask;
  user?: WorkHealthUser;
  project?: HealthProject;
  ageHours?: number;
  dueAt?: string | null;
}

export interface WorkHealthPerson {
  user: WorkHealthUser;
  activeCount: number;
  activeWeight: number;
  todayWeight: number;
  reviewCount: number;
  blockedCount: number;
  overdueCount: number;
  staleCount: number;
  capacity: number;
  capacityActive: boolean;
  loadRatio: number;
  status: 'idle' | 'balanced' | 'busy' | 'overloaded';
  tasks: HealthTask[];
}

export interface WorkHealthProject {
  project: HealthProject;
  activeCount: number;
  activeWeight: number;
  blockedCount: number;
  overdueCount: number;
  reviewCount: number;
  staleCount: number;
  unassignedCount: number;
  health: 'healthy' | 'needs_attention' | 'at_risk';
}

export interface WorkHealthUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  mattermostUsername?: string | null;
  avatarUrl?: string | null;
}

export async function getWorkHealthSummary(actor: RequestActor, now = new Date()): Promise<WorkHealthSummary> {
  const access = await resolveWorkspaceAccess(actor);
  const activeWhere = {
    AND: [
      taskWhereForAccess(access),
      { status: { in: [...activeStatuses] } }
    ]
  } satisfies Prisma.TaskWhereInput;
  const backlogWhere = {
    AND: [
      taskWhereForAccess(access),
      { status: 'BACKLOG' },
      {
        OR: [
          { triageState: { is: null } },
          { triageState: { is: { status: 'OPEN' } } },
          { triageState: { is: { status: 'SNOOZED', snoozedUntil: { lte: now } } } }
        ]
      }
    ]
  } satisfies Prisma.TaskWhereInput;

  const [activeTotal, activeRows, activeStatusCounts, backlogTotal, backlogRows, members, projects, capacities, teamMemberUsers, projectMemberUsers] = await Promise.all([
    prisma.task.count({ where: activeWhere }),
    prisma.task.findMany({
      where: activeWhere,
      include: taskInclude,
      orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }],
      take: activeTaskLimit
    }),
    prisma.task.groupBy({
      by: ['status'],
      where: activeWhere,
      _count: { _all: true }
    }),
    prisma.task.count({ where: backlogWhere }),
    prisma.task.findMany({
      where: backlogWhere,
      include: taskInclude,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: queueLimit
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            mattermostUsername: true,
            avatarUrl: true
          }
        }
      }
    }),
    prisma.project.findMany({
      where: projectWhereForAccess(access),
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
      include: {
        team: { select: { id: true, name: true, slug: true } },
        lead: { select: { id: true, name: true, email: true, avatarUrl: true } },
        healthUpdates: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            health: true,
            summary: true,
            risks: true,
            decisionsNeeded: true,
            nextUpdateDueAt: true,
            createdAt: true
          }
        }
      }
    }),
    prisma.userCapacity.findMany({
      where: { workspaceId: actor.workspace.id },
      select: { userId: true, dailyWeightLimit: true, active: true }
    }),
    access.workspaceWide || access.teamIds.length === 0
      ? Promise.resolve([])
      : prisma.teamMember.findMany({
        where: { teamId: { in: access.teamIds } },
        select: { userId: true }
      }),
    access.workspaceWide || access.projectIds.length === 0
      ? Promise.resolve([])
      : prisma.projectMember.findMany({
        where: { projectId: { in: access.projectIds } },
        select: { userId: true }
      })
  ]);

  const activeTasks = await addTaskProgressStartedAt(
    actor.workspace.id,
    activeRows.map((task) => serializeTaskForResponse(task) as HealthTask)
  );
  const activeReviewRequests = activeTasks.length
    ? await prisma.taskReviewRequest.findMany({
      where: {
        workspaceId: actor.workspace.id,
        taskId: { in: activeTasks.map((task) => task.id) },
        status: 'REQUESTED'
      },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, taskId: true, reviewerId: true, requestedAt: true, dueAt: true }
    })
    : [];
  const reviewByTaskId = new Map(activeReviewRequests.map((review) => [review.taskId, review]));
  for (const task of activeTasks) {
    const review = reviewByTaskId.get(task.id);
    if (!review) continue;
    task.activeReviewRequest = {
      id: review.id,
      reviewerId: review.reviewerId,
      requestedAt: review.requestedAt.toISOString(),
      dueAt: review.dueAt?.toISOString() ?? null
    };
  }
  const backlogTasks = backlogRows.map((task) => serializeTaskForResponse(task) as HealthTask);

  return computeWorkHealthSummary({
    access,
    activeTasks,
    activeTotal,
    statusCounts: Object.fromEntries(activeStatusCounts.map((row) => [row.status, row._count._all])),
    backlogTasks,
    backlogTotal,
    members,
    projects,
    capacities,
    now,
    visibleUserIds: [
      ...teamMemberUsers.map((membership) => membership.userId),
      ...projectMemberUsers.map((membership) => membership.userId)
    ]
  });
}

export function computeWorkHealthSummary(input: ComputeWorkHealthSummaryInput): WorkHealthSummary {
  const { access, activeTasks, activeTotal, backlogTasks, backlogTotal, projects, now } = input;
  const members = filterMembersForAccess(input);
  const capacityByUserId = new Map((input.capacities || []).map((capacity) => [capacity.userId, capacity]));
  const todayEnd = endOfDay(now);
  const actionableBacklogTasks = backlogTasks.filter((task) => isBacklogTriageActionable(task, now));

  const overdue = activeTasks.filter((task) => isOverdue(task, now)).sort(byDueDateAsc);
  const blocked = activeTasks.filter((task) => task.status === 'BLOCKED').sort((a, b) => ageMs(b, now) - ageMs(a, now));
  const review = activeTasks.filter((task) => task.status === 'IN_REVIEW').sort((a, b) => ageMs(b, now) - ageMs(a, now));
  const stale = activeTasks.filter((task) => isStale(task, now)).sort((a, b) => updatedAtMs(a) - updatedAtMs(b));
  const unassigned = activeTasks.filter((task) => !task.assignee).sort(byDueDateAsc);
  const people = buildPeopleHealth(members, activeTasks, now, todayEnd, capacityByUserId);
  const projectsHealth = buildProjectHealth(projects, activeTasks, now);
  const attention = buildAttention({
    blocked,
    overdue,
    people,
    review,
    stale,
    unassigned,
    projects: projectsHealth,
    now
  });

  return {
    generatedAt: now.toISOString(),
    scope: {
      workspaceWide: access.workspaceWide,
      teamIds: access.teamIds,
      projectIds: access.projectIds
    },
    thresholds: workHealthThresholds,
    overview: {
      activeTasks: activeTotal,
      loadedActiveTasks: activeTasks.length,
      truncated: activeTotal > activeTasks.length,
      overdueTasks: overdue.length,
      blockedTasks: blocked.length,
      reviewTasks: review.length,
      staleTasks: stale.length,
      unassignedActiveTasks: unassigned.length,
      backlogTasks: backlogTotal,
      statusCounts: normalizeStatusCounts(input.statusCounts, activeTasks, backlogTotal),
      overloadedPeople: people.filter((person) => person.status === 'overloaded').length,
      peopleWithoutActiveWork: people.filter((person) => person.status === 'idle' && person.capacityActive !== false).length
    },
    attention,
    people,
    queues: {
      overdue: overdue.slice(0, queueLimit),
      blocked: blocked.slice(0, queueLimit),
      review: review.slice(0, queueLimit),
      stale: stale.slice(0, queueLimit),
      unassigned: unassigned.slice(0, queueLimit),
      backlog: actionableBacklogTasks
    },
    projects: projectsHealth
  };
}

export function isBacklogTriageActionable(
  task: { status: string; triageState?: { status: string; snoozedUntil?: Date | string | null } | null },
  now: Date
): boolean {
  if (task.status !== 'BACKLOG') return false;
  if (!task.triageState || task.triageState.status === 'OPEN') return true;
  if (task.triageState.status !== 'SNOOZED') return false;
  if (!task.triageState.snoozedUntil) return false;
  return new Date(task.triageState.snoozedUntil).getTime() <= now.getTime();
}

function filterMembersForAccess(input: ComputeWorkHealthSummaryInput): HealthUser[] {
  if (input.access.workspaceWide) return input.members;

  const visibleUserIds = new Set<string>([input.access.userId, ...(input.visibleUserIds || [])]);
  for (const task of input.activeTasks) {
    if (task.assignee?.id) visibleUserIds.add(task.assignee.id);
    if (task.reporter?.id) visibleUserIds.add(task.reporter.id);
  }
  for (const project of input.projects) {
    if (project.lead?.id) visibleUserIds.add(project.lead.id);
  }

  return input.members.filter((membership) => visibleUserIds.has(membership.user.id));
}

function normalizeStatusCounts(
  explicitCounts: Partial<Record<string, number>> | undefined,
  activeTasks: HealthTask[],
  backlogTotal: number
): WorkHealthSummary['overview']['statusCounts'] {
  const counts: WorkHealthSummary['overview']['statusCounts'] = {
    BACKLOG: backlogTotal,
    TODO: 0,
    IN_PROGRESS: 0,
    IN_REVIEW: 0,
    BLOCKED: 0,
    DONE: 0,
    CANCELED: 0
  };

  if (explicitCounts) {
    for (const status of activeStatuses) {
      counts[status] = explicitCounts[status] || 0;
    }
    return counts;
  }

  for (const task of activeTasks) {
    if (task.status in counts) {
      counts[task.status as keyof typeof counts] += 1;
    }
  }

  return counts;
}

function buildPeopleHealth(
  members: HealthUser[],
  activeTasks: HealthTask[],
  now: Date,
  todayEnd: Date,
  capacityByUserId: Map<string, { dailyWeightLimit: number; active: boolean }>
): WorkHealthPerson[] {
  return members
    .map((membership) => {
      const capacityRecord = capacityByUserId.get(membership.user.id);
      const allTasks = activeTasks
        .filter((task) => task.assignee?.id === membership.user.id)
        .sort(byDueDateAsc);
      const workloadTasks = allTasks.filter((task) => isDueTodayOrEarlier(task, todayEnd));
      const displayTasks = workloadTasks.slice(0, queueLimit);
      const activeWeight = workloadTasks.reduce((sum, task) => sum + taskWeight(task), 0);
      const todayWeight = activeWeight;
      const capacityActive = capacityRecord?.active ?? true;
      const capacity = capacityActive ? capacityRecord?.dailyWeightLimit ?? workHealthThresholds.dailyWeightLimit : 0;
      const loadRatio = capacity > 0 ? activeWeight / capacity : activeWeight > 0 ? 999 : 0;

      return {
        user: membership.user,
        activeCount: workloadTasks.length,
        activeWeight,
        todayWeight,
        reviewCount: allTasks.filter((task) => task.status === 'IN_REVIEW').length,
        blockedCount: allTasks.filter((task) => task.status === 'BLOCKED').length,
        overdueCount: allTasks.filter((task) => isOverdue(task, now)).length,
        staleCount: allTasks.filter((task) => isStale(task, now)).length,
        capacity,
        capacityActive,
        loadRatio,
        status: capacityActive ? workloadStatus(workloadTasks.length, loadRatio) : activeWeight > 0 ? 'overloaded' : 'idle',
        tasks: displayTasks
      } satisfies WorkHealthPerson;
    })
    .sort((a, b) => {
      const statusRank = workloadRank(b.status) - workloadRank(a.status);
      if (statusRank !== 0) return statusRank;
      if (b.activeWeight !== a.activeWeight) return b.activeWeight - a.activeWeight;
      return a.user.name.localeCompare(b.user.name, 'fa');
    });
}

function buildProjectHealth(projects: HealthProject[], activeTasks: HealthTask[], now: Date): WorkHealthProject[] {
  return projects
    .map((project) => {
      const tasks = activeTasks.filter((task) => task.project?.id === project.id);
      const blockedCount = tasks.filter((task) => task.status === 'BLOCKED').length;
      const overdueCount = tasks.filter((task) => isOverdue(task, now)).length;
      const reviewCount = tasks.filter((task) => task.status === 'IN_REVIEW').length;
      const staleCount = tasks.filter((task) => isStale(task, now)).length;
      const unassignedCount = tasks.filter((task) => !task.assignee).length;
      const latestUpdate = project.healthUpdates?.[0] || null;
      const updateDue = latestUpdate?.nextUpdateDueAt
        ? latestUpdate.nextUpdateDueAt.getTime() < now.getTime()
        : false;
      const health = blockedCount > 0 || overdueCount > 0 || latestUpdate?.health === 'OFF_TRACK' || latestUpdate?.health === 'AT_RISK'
        ? 'at_risk'
        : reviewCount > 0 || staleCount > 0 || unassignedCount > 0 || updateDue
          ? 'needs_attention'
          : 'healthy';

      return {
        project,
        activeCount: tasks.length,
        activeWeight: tasks.reduce((sum, task) => sum + taskWeight(task), 0),
        blockedCount,
        overdueCount,
        reviewCount,
        staleCount,
        unassignedCount,
        health
      } satisfies WorkHealthProject;
    })
    .filter((item) => item.activeCount > 0 || item.health !== 'healthy')
    .sort((a, b) => {
      const healthRank = projectHealthRank(b.health) - projectHealthRank(a.health);
      if (healthRank !== 0) return healthRank;
      if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
      return a.project.name.localeCompare(b.project.name, 'fa');
    })
    .slice(0, queueLimit);
}

function buildAttention(input: {
  blocked: HealthTask[];
  overdue: HealthTask[];
  people: WorkHealthPerson[];
  review: HealthTask[];
  stale: HealthTask[];
  unassigned: HealthTask[];
  projects: WorkHealthProject[];
  now: Date;
}): WorkHealthAttentionItem[] {
  const items: WorkHealthAttentionItem[] = [];

  for (const task of input.overdue.slice(0, 8)) {
    items.push({
      id: `task:${task.id}:overdue`,
      reason: 'overdue_task',
      severity: overdueSeverity(task, input.now),
      title: `${task.key}: ${task.title}`,
      description: 'موعد این کار گذشته و باید تعیین تکلیف شود.',
      actionLabel: 'باز کردن کار',
      entityType: 'task',
      task,
      dueAt: isoDate(task.dueAt)
    });
  }

  for (const task of input.blocked.filter((task) => ageHours(task, input.now) >= workHealthThresholds.blockedSlaHours).slice(0, 8)) {
    const hours = ageHours(task, input.now);
    items.push({
      id: `task:${task.id}:blocked`,
      reason: 'blocked_task',
      severity: hours >= workHealthThresholds.blockedSlaHours * 2 ? 'HIGH' : 'MEDIUM',
      title: `${task.key}: ${task.title}`,
      description: 'این کار بیش از حد در وضعیت مسدود مانده است.',
      actionLabel: 'بررسی مانع',
      entityType: 'task',
      task,
      ageHours: hours
    });
  }

  for (const task of input.review.filter((task) => ageHours(task, input.now) >= workHealthThresholds.reviewSlaHours).slice(0, 8)) {
    const hours = ageHours(task, input.now);
    items.push({
      id: `task:${task.id}:review`,
      reason: 'review_waiting',
      severity: hours >= workHealthThresholds.reviewSlaHours * 2 ? 'HIGH' : 'MEDIUM',
      title: `${task.key}: ${task.title}`,
      description: 'این کار در صف بازبینی مانده و نیاز به پیگیری دارد.',
      actionLabel: 'باز کردن بازبینی',
      entityType: 'task',
      task,
      ageHours: hours
    });
  }

  for (const task of input.unassigned.filter((task) => isDueSoon(task, input.now)).slice(0, 8)) {
    items.push({
      id: `task:${task.id}:unassigned`,
      reason: 'unassigned_due_soon',
      severity: 'HIGH',
      title: `${task.key}: ${task.title}`,
      description: 'این کار نزدیک موعد است اما مسئول ندارد.',
      actionLabel: 'واگذاری کار',
      entityType: 'task',
      task,
      dueAt: isoDate(task.dueAt)
    });
  }

  for (const task of input.stale.slice(0, 6)) {
    items.push({
      id: `task:${task.id}:stale`,
      reason: 'stale_task',
      severity: 'LOW',
      title: `${task.key}: ${task.title}`,
      description: 'چند روز است تغییری روی این کار ثبت نشده است.',
      actionLabel: 'درخواست به‌روزرسانی',
      entityType: 'task',
      task,
      ageHours: ageHours(task, input.now)
    });
  }

  for (const person of input.people.filter((person) => person.status === 'overloaded').slice(0, 8)) {
    items.push({
      id: `user:${person.user.id}:overloaded`,
      reason: 'overloaded_person',
      severity: 'HIGH',
      title: person.user.name,
      description: 'حجم کار فعال این فرد از ظرفیت روزانه تعریف‌شده بیشتر است.',
      actionLabel: 'بازبینی حجم کار',
      entityType: 'user',
      user: person.user
    });
  }

  for (const person of input.people.filter((person) => person.status === 'idle' && person.capacityActive !== false).slice(0, 8)) {
    items.push({
      id: `user:${person.user.id}:idle`,
      reason: 'person_without_active_work',
      severity: 'LOW',
      title: person.user.name,
      description: 'کار فعال قابل مشاهده‌ای برای این فرد ثبت نشده است.',
      actionLabel: 'بررسی برنامه',
      entityType: 'user',
      user: person.user
    });
  }

  for (const projectHealth of input.projects.filter((item) => item.health !== 'healthy').slice(0, 8)) {
    const latestUpdate = projectHealth.project.healthUpdates?.[0] || null;
    const updateDue = latestUpdate?.nextUpdateDueAt
      ? latestUpdate.nextUpdateDueAt.getTime() < input.now.getTime()
      : false;
    if (latestUpdate?.health === 'OFF_TRACK' || latestUpdate?.health === 'AT_RISK') {
      items.push({
        id: `project:${projectHealth.project.id}:at-risk`,
        reason: 'project_at_risk',
        severity: latestUpdate.health === 'OFF_TRACK' ? 'HIGH' : 'MEDIUM',
        title: projectHealth.project.name,
        description: latestUpdate.summary || 'این پروژه نیازمند تصمیم یا پیگیری مدیریتی است.',
        actionLabel: 'باز کردن پروژه',
        entityType: 'project',
        project: projectHealth.project,
        dueAt: latestUpdate.nextUpdateDueAt?.toISOString() ?? null
      });
      continue;
    }
    if (updateDue) {
      items.push({
        id: `project:${projectHealth.project.id}:update-due`,
        reason: 'project_update_due',
        severity: 'LOW',
        title: projectHealth.project.name,
        description: 'زمان آپدیت سلامت بعدی این پروژه گذشته است.',
        actionLabel: 'ثبت آپدیت پروژه',
        entityType: 'project',
        project: projectHealth.project,
        dueAt: latestUpdate.nextUpdateDueAt?.toISOString() ?? null
      });
    }
  }

  return items.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).slice(0, queueLimit);
}

function isOverdue(task: HealthTask, now: Date): boolean {
  if (!executionStatuses.has(task.status)) return false;
  if (!task.dueAt) return false;
  return new Date(task.dueAt).getTime() < now.getTime();
}

function isDueSoon(task: HealthTask, now: Date): boolean {
  if (!task.dueAt) return false;
  const dueAt = new Date(task.dueAt).getTime();
  return dueAt >= now.getTime() && dueAt <= now.getTime() + workHealthThresholds.dueSoonHours * 60 * 60 * 1000;
}

function isDueTodayOrEarlier(task: HealthTask, todayEnd: Date): boolean {
  if (!task.dueAt) return false;
  return new Date(task.dueAt).getTime() <= todayEnd.getTime();
}

function isStale(task: HealthTask, now: Date): boolean {
  if (!executionStatuses.has(task.status)) return false;
  return ageHoursFromDate(task.updatedAt, now) >= workHealthThresholds.staleAfterHours;
}

function taskWeight(task: HealthTask): number {
  return typeof task.weight === 'number' && Number.isFinite(task.weight) && task.weight > 0 ? task.weight : 1;
}

function workloadStatus(activeCount: number, loadRatio: number): WorkHealthPerson['status'] {
  if (activeCount === 0) return 'idle';
  if (loadRatio > 1) return 'overloaded';
  if (loadRatio >= 0.75) return 'busy';
  return 'balanced';
}

function byDueDateAsc(left: HealthTask, right: HealthTask): number {
  return dateMs(left.dueAt) - dateMs(right.dueAt) || updatedAtMs(right) - updatedAtMs(left);
}

function dateMs(value: Date | string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function updatedAtMs(task: HealthTask): number {
  return new Date(task.updatedAt).getTime();
}

function ageMs(task: HealthTask, now: Date): number {
  return now.getTime() - statusStartedAt(task).getTime();
}

function ageHours(task: HealthTask, now: Date): number {
  return Math.max(0, Math.floor(ageMs(task, now) / (60 * 60 * 1000)));
}

function ageHoursFromDate(value: Date | string | null | undefined, now: Date): number {
  if (!value) return 0;
  const ms = now.getTime() - new Date(value).getTime();
  return Math.max(0, Math.floor(ms / (60 * 60 * 1000)));
}

function statusStartedAt(task: HealthTask): Date {
  if (task.status === 'IN_REVIEW' && task.activeReviewRequest?.requestedAt) {
    return new Date(task.activeReviewRequest.requestedAt);
  }
  return new Date(task.progressStartedAt || task.updatedAt || task.createdAt);
}

function overdueSeverity(task: HealthTask, now: Date): WorkHealthAttentionItem['severity'] {
  const overdueHours = ageHoursFromDate(task.dueAt, now);
  if (task.priority === 'URGENT' || overdueHours >= 72) return 'URGENT';
  if (task.priority === 'HIGH' || overdueHours >= 24) return 'HIGH';
  return 'MEDIUM';
}

function severityRank(severity: WorkHealthAttentionItem['severity']): number {
  return { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 }[severity];
}

function workloadRank(status: WorkHealthPerson['status']): number {
  return { idle: 0, balanced: 1, busy: 2, overloaded: 3 }[status];
}

function projectHealthRank(health: WorkHealthProject['health']): number {
  return { healthy: 0, needs_attention: 1, at_risk: 2 }[health];
}

function endOfDay(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
