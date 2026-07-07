import { prisma, type Prisma, type WorkspaceRole } from '@taskara/db';
import type { z } from 'zod';
import type { assignmentRecommendationSchema } from '@taskara/shared';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import {
  projectWhereForAccess,
  resolveWorkspaceAccess,
  taskWhereForAccess
} from './team-access';
import { findTaskByIdOrKey } from './tasks';

type AssignmentRecommendationInput = z.infer<typeof assignmentRecommendationSchema>;

const assignmentActiveStatuses = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] as const;
const defaultDailyCapacity = 8;
const dueSoonHours = 48;

export interface AssignmentUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  mattermostUsername?: string | null;
  avatarUrl?: string | null;
}

export interface AssignmentCandidateFacts {
  user: AssignmentUser;
  workspaceRole: WorkspaceRole;
  teamIds: string[];
  projectIds: string[];
  capacity: number;
  active: boolean;
  activeCount: number;
  activeWeight: number;
  reviewCount: number;
  blockedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  projectActiveCount: number;
}

export interface AssignmentContext {
  projectId: string;
  projectTeamId?: string | null;
  taskId?: string | null;
  weight: number;
  priority: string;
  dueAt?: Date | string | null;
  activeWipLimit?: number | null;
  reviewWipLimit?: number | null;
  now: Date;
}

export interface AssignmentReason {
  code:
    | 'capacity_available'
    | 'no_visible_active_work'
    | 'project_context'
    | 'busy'
    | 'over_capacity'
    | 'zero_capacity'
    | 'review_load'
    | 'blocked_load'
    | 'due_pressure'
    | 'over_wip_limit'
    | 'over_review_wip_limit';
  tone: 'positive' | 'neutral' | 'warning';
  message: string;
}

export interface AssignmentRecommendation {
  user: AssignmentUser;
  capacity: number;
  activeCount: number;
  activeWeight: number;
  projectedWeight: number;
  loadRatio: number;
  projectedLoadRatio: number;
  reviewCount: number;
  blockedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  projectActiveCount: number;
  score: number;
  status: 'available' | 'busy' | 'overloaded' | 'unavailable';
  reasons: AssignmentReason[];
}

export interface AssignmentRecommendationResponse {
  generatedAt: string;
  project: {
    id: string;
    name: string;
    keyPrefix: string;
    teamId?: string | null;
    team?: { id: string; name: string; slug: string } | null;
  };
  task?: {
    id: string;
    key: string;
    title: string;
    assigneeId?: string | null;
  } | null;
  context: {
    weight: number;
    priority: string;
    dueAt?: string | null;
    activeWipLimit?: number | null;
    reviewWipLimit?: number | null;
  };
  recommendations: AssignmentRecommendation[];
  excluded: {
    inactive: number;
    unsupportedRole: number;
    outsideProjectMembership: number;
  };
}

type AssignmentTask = {
  id: string;
  projectId: string;
  assigneeId: string | null;
  status: string;
  priority: string;
  weight: number | null;
  dueAt: Date | null;
};

type CandidateMember = Prisma.WorkspaceMemberGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        name: true;
        email: true;
        phone: true;
        mattermostUsername: true;
        avatarUrl: true;
        teamMemberships: { select: { teamId: true } };
        projectMemberships: { select: { projectId: true } };
      };
    };
  };
}>;

export async function recommendAssignment(
  actor: RequestActor,
  input: AssignmentRecommendationInput,
  now = new Date()
): Promise<AssignmentRecommendationResponse> {
  const access = await resolveWorkspaceAccess(actor);
  const task = input.taskIdOrKey
    ? await findTaskByIdOrKey(actor.workspace.id, input.taskIdOrKey, access)
    : null;
  if (input.taskIdOrKey && !task) throw new HttpError(404, 'Task not found');

  const projectId = input.projectId || task?.projectId;
  if (!projectId) throw new HttpError(400, 'Project is required for assignment recommendation');

  const project = await prisma.project.findFirst({
    where: {
      ...projectWhereForAccess(access),
      id: projectId,
      status: { not: 'ARCHIVED' }
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      teamId: true,
      team: { select: { id: true, name: true, slug: true } }
    }
  });
  if (!project) throw new HttpError(404, 'Project not found');

  const [members, capacities, visibleTasks, activeReviews, agreement] = await Promise.all([
    listWorkspaceCandidateMembers(actor.workspace.id),
    prisma.userCapacity.findMany({
      where: { workspaceId: actor.workspace.id }
    }),
    prisma.task.findMany({
      where: {
        ...taskWhereForAccess(access),
        status: { in: [...assignmentActiveStatuses] },
        assigneeId: { not: null }
      },
      select: {
        id: true,
        projectId: true,
        assigneeId: true,
        status: true,
        priority: true,
        weight: true,
        dueAt: true
      }
    }),
    prisma.taskReviewRequest.groupBy({
      by: ['reviewerId'],
      where: {
        workspaceId: actor.workspace.id,
        status: 'REQUESTED',
        task: taskWhereForAccess(access)
      },
      _count: { _all: true }
    }),
    getWorkingAgreement(actor.workspace.id, project.teamId)
  ]);

  const capacityByUserId = new Map(capacities.map((capacity) => [capacity.userId, capacity]));
  const reviewCountByUserId = new Map(activeReviews.map((review) => [review.reviewerId, review._count._all]));
  const taskWeight = normalizeAssignmentWeight(input.weight ?? task?.weight ?? 1);
  const candidateFacts = buildAssignmentCandidateFacts({
    members,
    capacities: capacityByUserId,
    visibleTasks,
    reviewerLoad: reviewCountByUserId,
    projectId: project.id,
    now
  });
  const eligibility = eligibleAssignmentCandidates(candidateFacts, {
    projectTeamId: project.teamId,
    projectId: project.id
  });
  const recommendations = buildAssignmentRecommendations(
    eligibility.candidates,
    {
      projectId: project.id,
      projectTeamId: project.teamId,
      taskId: task?.id,
      weight: taskWeight,
      priority: input.priority || task?.priority || 'NO_PRIORITY',
      dueAt: input.dueAt ?? task?.dueAt ?? null,
      activeWipLimit: agreement?.activeWipLimit ?? null,
      reviewWipLimit: agreement?.reviewWipLimit ?? null,
      now
    },
    input.limit
  );

  return {
    generatedAt: now.toISOString(),
    project,
    task: task
      ? {
          id: task.id,
          key: task.key,
          title: task.title,
          assigneeId: task.assigneeId
        }
      : null,
    context: {
      weight: taskWeight,
      priority: input.priority || task?.priority || 'NO_PRIORITY',
      dueAt: isoDate(input.dueAt ?? task?.dueAt ?? null),
      activeWipLimit: agreement?.activeWipLimit ?? null,
      reviewWipLimit: agreement?.reviewWipLimit ?? null
    },
    recommendations,
    excluded: eligibility.excluded
  };
}

export function eligibleAssignmentCandidates(
  candidates: AssignmentCandidateFacts[],
  context: { projectTeamId?: string | null; projectId: string }
): {
  candidates: AssignmentCandidateFacts[];
  excluded: AssignmentRecommendationResponse['excluded'];
} {
  const excluded = {
    inactive: 0,
    unsupportedRole: 0,
    outsideProjectMembership: 0
  };
  const eligible: AssignmentCandidateFacts[] = [];

  for (const candidate of candidates) {
    if (!candidate.active) {
      excluded.inactive += 1;
      continue;
    }
    if (candidate.workspaceRole === 'GUEST' || candidate.workspaceRole === 'AGENT') {
      excluded.unsupportedRole += 1;
      continue;
    }
    if (context.projectTeamId && !candidate.teamIds.includes(context.projectTeamId)) {
      excluded.outsideProjectMembership += 1;
      continue;
    }
    eligible.push(candidate);
  }

  return { candidates: eligible, excluded };
}

export function buildAssignmentRecommendations(
  candidates: AssignmentCandidateFacts[],
  context: AssignmentContext,
  limit = 8
): AssignmentRecommendation[] {
  return candidates
    .map((candidate) => recommendationFromCandidate(candidate, context))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.projectActiveCount !== right.projectActiveCount) return right.projectActiveCount - left.projectActiveCount;
      if (left.projectedWeight !== right.projectedWeight) return left.projectedWeight - right.projectedWeight;
      return left.user.name.localeCompare(right.user.name, 'fa');
    })
    .slice(0, Math.max(1, limit));
}

function recommendationFromCandidate(
  candidate: AssignmentCandidateFacts,
  context: AssignmentContext
): AssignmentRecommendation {
  const projectedWeight = candidate.activeWeight + context.weight;
  const loadRatio = ratio(candidate.activeWeight, candidate.capacity);
  const projectedLoadRatio = ratio(projectedWeight, candidate.capacity);
  const reasons = assignmentReasons(candidate, context, projectedWeight, projectedLoadRatio);
  const status = assignmentStatus(candidate, projectedLoadRatio);
  const priorityPressure = context.priority === 'URGENT' ? 8 : context.priority === 'HIGH' ? 4 : 0;
  const duePressure = context.dueAt ? dueSoonPenalty(context.dueAt, context.now) : 0;
  const score = Math.round(
    100
      - projectedLoadRatio * 45
      - candidate.activeCount * 2
      - candidate.reviewCount * 4
      - candidate.blockedCount * 4
      - candidate.overdueCount * 5
      - candidate.dueSoonCount * 3
      - duePressure
      - priorityPressure
      + Math.min(candidate.projectActiveCount * 6, 18)
  );

  return {
    user: candidate.user,
    capacity: candidate.capacity,
    activeCount: candidate.activeCount,
    activeWeight: candidate.activeWeight,
    projectedWeight,
    loadRatio,
    projectedLoadRatio,
    reviewCount: candidate.reviewCount,
    blockedCount: candidate.blockedCount,
    overdueCount: candidate.overdueCount,
    dueSoonCount: candidate.dueSoonCount,
    projectActiveCount: candidate.projectActiveCount,
    score,
    status,
    reasons
  };
}

function assignmentReasons(
  candidate: AssignmentCandidateFacts,
  context: AssignmentContext,
  projectedWeight: number,
  projectedLoadRatio: number
): AssignmentReason[] {
  const reasons: AssignmentReason[] = [];
  if (candidate.capacity <= 0) {
    reasons.push({ code: 'zero_capacity', tone: 'warning', message: 'Configured capacity is zero' });
  } else if (candidate.activeCount === 0) {
    reasons.push({ code: 'no_visible_active_work', tone: 'positive', message: 'No visible active work' });
  } else if (projectedLoadRatio <= 0.75) {
    reasons.push({ code: 'capacity_available', tone: 'positive', message: 'Capacity remains available after assignment' });
  }

  if (candidate.projectActiveCount > 0) {
    reasons.push({ code: 'project_context', tone: 'positive', message: 'Already has context in this project' });
  }
  if (projectedLoadRatio >= 1) {
    reasons.push({ code: 'over_capacity', tone: 'warning', message: 'Would be over capacity after assignment' });
  } else if (projectedLoadRatio >= 0.75) {
    reasons.push({ code: 'busy', tone: 'neutral', message: 'Would be busy after assignment' });
  }
  if (candidate.reviewCount > 0) {
    reasons.push({ code: 'review_load', tone: candidate.reviewCount >= 3 ? 'warning' : 'neutral', message: 'Has active review load' });
  }
  if (candidate.blockedCount > 0) {
    reasons.push({ code: 'blocked_load', tone: 'warning', message: 'Has blocked work' });
  }
  if (candidate.overdueCount > 0 || candidate.dueSoonCount > 0) {
    reasons.push({ code: 'due_pressure', tone: 'warning', message: 'Has due-date pressure' });
  }
  if (context.activeWipLimit !== null && context.activeWipLimit !== undefined && candidate.activeCount + 1 > context.activeWipLimit) {
    reasons.push({ code: 'over_wip_limit', tone: 'warning', message: 'Would exceed active WIP agreement' });
  }
  if (context.reviewWipLimit !== null && context.reviewWipLimit !== undefined && candidate.reviewCount > context.reviewWipLimit) {
    reasons.push({ code: 'over_review_wip_limit', tone: 'warning', message: 'Review load exceeds team agreement' });
  }

  if (!reasons.length) {
    reasons.push({ code: 'capacity_available', tone: 'positive', message: `Projected weight ${projectedWeight}` });
  }
  return reasons.slice(0, 5);
}

function assignmentStatus(candidate: AssignmentCandidateFacts, projectedLoadRatio: number): AssignmentRecommendation['status'] {
  if (candidate.capacity <= 0) return 'unavailable';
  if (projectedLoadRatio >= 1) return 'overloaded';
  if (projectedLoadRatio >= 0.75 || candidate.activeCount >= 5) return 'busy';
  return 'available';
}

function buildAssignmentCandidateFacts(input: {
  members: CandidateMember[];
  capacities: Map<string, { dailyWeightLimit: number; active: boolean }>;
  visibleTasks: AssignmentTask[];
  reviewerLoad: Map<string, number>;
  projectId: string;
  now: Date;
}): AssignmentCandidateFacts[] {
  const tasksByAssignee = new Map<string, AssignmentTask[]>();
  for (const task of input.visibleTasks) {
    if (!task.assigneeId) continue;
    const tasks = tasksByAssignee.get(task.assigneeId) || [];
    tasks.push(task);
    tasksByAssignee.set(task.assigneeId, tasks);
  }

  return input.members.map((member) => {
    const tasks = tasksByAssignee.get(member.userId) || [];
    const capacity = input.capacities.get(member.userId);
    const dueSoonCutoff = input.now.getTime() + dueSoonHours * 60 * 60 * 1000;

    return {
      user: {
        id: member.user.id,
        name: member.user.name,
        email: member.user.email,
        phone: member.user.phone,
        mattermostUsername: member.user.mattermostUsername,
        avatarUrl: member.user.avatarUrl
      },
      workspaceRole: member.role,
      teamIds: member.user.teamMemberships.map((membership) => membership.teamId),
      projectIds: member.user.projectMemberships.map((membership) => membership.projectId),
      capacity: capacity?.dailyWeightLimit ?? defaultDailyCapacity,
      active: capacity?.active ?? true,
      activeCount: tasks.length,
      activeWeight: tasks.reduce((sum, task) => sum + normalizeAssignmentWeight(task.weight), 0),
      reviewCount: tasks.filter((task) => task.status === 'IN_REVIEW').length + (input.reviewerLoad.get(member.userId) || 0),
      blockedCount: tasks.filter((task) => task.status === 'BLOCKED').length,
      overdueCount: tasks.filter((task) => task.dueAt && task.dueAt.getTime() < input.now.getTime()).length,
      dueSoonCount: tasks.filter((task) => {
        if (!task.dueAt) return false;
        const dueAt = task.dueAt.getTime();
        return dueAt >= input.now.getTime() && dueAt <= dueSoonCutoff;
      }).length,
      projectActiveCount: tasks.filter((task) => task.projectId === input.projectId).length
    };
  });
}

async function listWorkspaceCandidateMembers(workspaceId: string): Promise<CandidateMember[]> {
  return prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          mattermostUsername: true,
          avatarUrl: true,
          teamMemberships: { select: { teamId: true } },
          projectMemberships: { select: { projectId: true } }
        }
      }
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }]
  });
}

async function getWorkingAgreement(workspaceId: string, teamId?: string | null) {
  const scopeKeys = teamId ? [`team:${teamId}`, 'workspace'] : ['workspace'];
  const agreements = await prisma.teamWorkingAgreement.findMany({
    where: {
      workspaceId,
      scopeKey: { in: scopeKeys }
    }
  });
  return agreements.find((agreement) => agreement.scopeKey === `team:${teamId}`) || agreements.find((agreement) => agreement.scopeKey === 'workspace') || null;
}

function normalizeAssignmentWeight(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1;
  return value;
}

function ratio(weight: number, capacity: number): number {
  if (capacity <= 0) return 999;
  return Number(weight / capacity);
}

function dueSoonPenalty(value: Date | string, now: Date): number {
  const dueAt = new Date(value).getTime();
  if (!Number.isFinite(dueAt)) return 0;
  if (dueAt < now.getTime()) return 10;
  if (dueAt <= now.getTime() + 24 * 60 * 60 * 1000) return 6;
  if (dueAt <= now.getTime() + dueSoonHours * 60 * 60 * 1000) return 3;
  return 0;
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
