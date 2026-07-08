import { describe, expect, test } from 'bun:test';
import type { WorkspaceAccess } from './team-access';
import {
  computeWorkHealthSummary,
  isBacklogTriageActionable,
  type HealthProject,
  type HealthTask,
  type HealthUser
} from './work-health';

const now = new Date('2026-07-05T12:00:00.000Z');

const workspaceAccess: WorkspaceAccess = {
  workspaceId: 'workspace-1',
  userId: 'admin',
  workspaceWide: true,
  teamIds: [],
  projectIds: []
};

const scopedAccess: WorkspaceAccess = {
  workspaceId: 'workspace-1',
  userId: 'actor',
  workspaceWide: false,
  teamIds: ['team-1'],
  projectIds: ['project-direct']
};

describe('work health summary computation', () => {
  test('derives fixed-clock attention for overdue, blocked, review, stale, and due-soon unassigned work', () => {
    const summary = computeWorkHealthSummary({
      access: workspaceAccess,
      activeTasks: [
        task({ id: 'overdue', key: 'OPS-1', dueAt: dateFromNow(-80), priority: 'LOW' }),
        task({ id: 'blocked', key: 'OPS-2', status: 'BLOCKED', progressStartedAt: isoFromNow(-30), updatedAt: dateFromNow(-4) }),
        task({
          id: 'review',
          key: 'OPS-3',
          status: 'IN_REVIEW',
          progressStartedAt: isoFromNow(-5),
          updatedAt: dateFromNow(-1),
          activeReviewRequest: {
            id: 'review-1',
            reviewerId: 'reviewer-1',
            requestedAt: isoFromNow(-55),
            dueAt: null
          }
        }),
        task({ id: 'stale', key: 'OPS-4', updatedAt: dateFromNow(-80) }),
        task({ id: 'due-soon', key: 'OPS-5', assignee: null, dueAt: dateFromNow(12) })
      ],
      activeTotal: 5,
      backlogTasks: [],
      backlogTotal: 0,
      members: [member('assignee')],
      projects: [project()],
      now
    });

    expect(summary.overview).toMatchObject({
      overdueTasks: 1,
      blockedTasks: 1,
      reviewTasks: 1,
      staleTasks: 1,
      unassignedActiveTasks: 1
    });
    expect(summary.attention.map((item) => item.reason)).toEqual([
      'overdue_task',
      'review_waiting',
      'unassigned_due_soon',
      'blocked_task',
      'stale_task'
    ]);
    expect(summary.attention.find((item) => item.reason === 'overdue_task')?.severity).toBe('URGENT');
    expect(summary.attention.find((item) => item.reason === 'review_waiting')?.ageHours).toBe(55);
    expect(summary.attention.find((item) => item.reason === 'blocked_task')?.ageHours).toBe(30);
  });

  test('calculates person workload from due-today and overdue tasks while limiting display tasks', () => {
    const activeTasks = Array.from({ length: 30 }, (_, index) => task({
      id: `load-${index}`,
      key: `OPS-${index + 1}`,
      weight: 1,
      dueAt: dateFromNow(index % 2 === 0 ? -1 : 0),
      assignee: user('loaded')
    })).concat([
      task({ id: 'future-load', key: 'OPS-99', weight: 8, dueAt: dateFromNow(48), assignee: user('loaded') }),
      task({ id: 'unscheduled-load', key: 'OPS-100', weight: 8, dueAt: null, assignee: user('loaded') })
    ]);

    const summary = computeWorkHealthSummary({
      access: workspaceAccess,
      activeTasks,
      activeTotal: activeTasks.length,
      backlogTasks: [],
      backlogTotal: 0,
      members: [member('loaded')],
      projects: [project()],
      now
    });

    expect(summary.people[0]).toMatchObject({
      activeCount: 30,
      activeWeight: 30,
      todayWeight: 30,
      status: 'overloaded'
    });
    expect(summary.people[0]?.tasks).toHaveLength(24);
    expect(summary.people[0]?.tasks.some((item) => item.id === 'future-load' || item.id === 'unscheduled-load')).toBe(false);
    expect(summary.overview.overloadedPeople).toBe(1);
    expect(summary.attention.some((item) => item.reason === 'overloaded_person')).toBe(true);
  });

  test('uses configured capacity and suppresses idle attention for inactive people', () => {
    const activeTasks = Array.from({ length: 4 }, (_, index) => task({
      id: `custom-load-${index}`,
      key: `OPS-${index + 1}`,
      weight: 2,
      dueAt: dateFromNow(-2),
      assignee: user('custom-capacity')
    }));

    const summary = computeWorkHealthSummary({
      access: workspaceAccess,
      activeTasks,
      activeTotal: activeTasks.length,
      backlogTasks: [],
      backlogTotal: 0,
      members: [member('custom-capacity'), member('inactive')],
      projects: [project()],
      capacities: [
        { userId: 'custom-capacity', dailyWeightLimit: 16, active: true },
        { userId: 'inactive', dailyWeightLimit: 8, active: false }
      ],
      now
    });

    expect(summary.people.find((person) => person.user.id === 'custom-capacity')).toMatchObject({
      activeWeight: 8,
      capacity: 16,
      loadRatio: 0.5,
      status: 'balanced'
    });
    expect(summary.overview.peopleWithoutActiveWork).toBe(0);
    expect(summary.attention.some((item) => item.reason === 'person_without_active_work')).toBe(false);
  });

  test('scoped summaries include only the actor and users in the visible work graph', () => {
    const summary = computeWorkHealthSummary({
      access: scopedAccess,
      activeTasks: [
        task({
          id: 'visible-task',
          key: 'OPS-1',
          assignee: user('task-assignee'),
          reporter: user('task-reporter')
        })
      ],
      activeTotal: 1,
      backlogTasks: [],
      backlogTotal: 0,
      members: [
        member('actor'),
        member('team-peer'),
        member('project-peer'),
        member('task-assignee'),
        member('task-reporter'),
        member('project-lead'),
        member('unrelated')
      ],
      projects: [project({ lead: user('project-lead') })],
      now,
      visibleUserIds: ['team-peer', 'project-peer']
    });

    expect(summary.people.map((person) => person.user.id).sort()).toEqual([
      'actor',
      'project-lead',
      'project-peer',
      'task-assignee',
      'task-reporter',
      'team-peer'
    ]);
    expect(summary.people.some((person) => person.user.id === 'unrelated')).toBe(false);
    expect(summary.attention.some((item) => item.entityType === 'user' && item.user?.id === 'unrelated')).toBe(false);
  });

  test('reports true totals separately from capped queue payloads', () => {
    const backlogTasks = Array.from({ length: 24 }, (_, index) => task({
      id: `backlog-${index}`,
      key: `OPS-B${index + 1}`,
      status: 'BACKLOG'
    }));
    const activeTasks = [task({ id: 'active', key: 'OPS-1' })];

    const summary = computeWorkHealthSummary({
      access: workspaceAccess,
      activeTasks,
      activeTotal: 2500,
      backlogTasks,
      backlogTotal: 99,
      members: [member('admin'), member('assignee')],
      projects: [project()],
      now
    });

    expect(summary.overview.activeTasks).toBe(2500);
    expect(summary.overview.loadedActiveTasks).toBe(1);
    expect(summary.overview.truncated).toBe(true);
    expect(summary.overview.backlogTasks).toBe(99);
    expect(summary.overview.statusCounts).toMatchObject({
      BACKLOG: 99,
      TODO: 1,
      IN_PROGRESS: 0,
      IN_REVIEW: 0,
      BLOCKED: 0
    });
    expect(summary.queues.backlog).toHaveLength(24);
  });

  test('filters waiting and future-snoozed backlog items out of the actionable triage queue', () => {
    const actionable = task({ id: 'backlog-open', key: 'OPS-B1', status: 'BACKLOG' });
    const waiting = task({
      id: 'backlog-waiting',
      key: 'OPS-B2',
      status: 'BACKLOG',
      triageState: {
        id: 'triage-waiting',
        status: 'WAITING_FOR_INFO',
        requestedInfo: 'Need expected result',
        snoozedUntil: null,
        reason: null,
        decidedById: 'admin',
        createdAt: dateFromNow(-2),
        updatedAt: dateFromNow(-2)
      }
    });
    const futureSnoozed = task({
      id: 'backlog-snoozed',
      key: 'OPS-B3',
      status: 'BACKLOG',
      triageState: {
        id: 'triage-snoozed',
        status: 'SNOOZED',
        requestedInfo: null,
        snoozedUntil: dateFromNow(24),
        reason: 'Wait for planning',
        decidedById: 'admin',
        createdAt: dateFromNow(-1),
        updatedAt: dateFromNow(-1)
      }
    });
    const dueSnoozed = task({
      id: 'backlog-due',
      key: 'OPS-B4',
      status: 'BACKLOG',
      triageState: {
        id: 'triage-due',
        status: 'SNOOZED',
        requestedInfo: null,
        snoozedUntil: dateFromNow(-1),
        reason: 'Back after planning',
        decidedById: 'admin',
        createdAt: dateFromNow(-25),
        updatedAt: dateFromNow(-25)
      }
    });

    const summary = computeWorkHealthSummary({
      access: workspaceAccess,
      activeTasks: [],
      activeTotal: 0,
      backlogTasks: [actionable, waiting, futureSnoozed, dueSnoozed],
      backlogTotal: 2,
      members: [member('admin')],
      projects: [project()],
      now
    });

    expect(isBacklogTriageActionable(waiting, now)).toBe(false);
    expect(isBacklogTriageActionable(futureSnoozed, now)).toBe(false);
    expect(isBacklogTriageActionable(dueSnoozed, now)).toBe(true);
    expect(summary.queues.backlog.map((item) => item.id)).toEqual(['backlog-open', 'backlog-due']);
  });
});

function dateFromNow(hours: number): Date {
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

function isoFromNow(hours: number): string {
  return dateFromNow(hours).toISOString();
}

function user(id: string) {
  return {
    id,
    name: `User ${id}`,
    email: `${id}@example.test`,
    phone: null,
    mattermostUsername: null,
    avatarUrl: null
  };
}

function member(id: string): HealthUser {
  return {
    id: `membership-${id}`,
    workspaceId: 'workspace-1',
    userId: id,
    role: 'MEMBER',
    createdAt: now,
    user: user(id)
  } as HealthUser;
}

function project(overrides: Partial<HealthProject> = {}): HealthProject {
  return {
    id: 'project-1',
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    parentId: null,
    leadId: null,
    name: 'Operations',
    keyPrefix: 'OPS',
    description: null,
    status: 'ACTIVE',
    nextTaskNumber: 1,
    createdAt: now,
    updatedAt: now,
    team: { id: 'team-1', name: 'Ops', slug: 'ops' },
    lead: null,
    ...overrides
  } as HealthProject;
}

function task(overrides: Partial<HealthTask> = {}): HealthTask {
  return {
    id: 'task-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    cycleId: null,
    parentId: null,
    key: 'OPS-1',
    sequence: 1,
    title: 'Task',
    description: null,
    status: 'TODO',
    priority: 'NO_PRIORITY',
    weight: 1,
    assigneeId: 'assignee',
    reporterId: null,
    dueAt: null,
    completedAt: null,
    source: 'WEB',
    version: 1,
    createdAt: dateFromNow(-120),
    updatedAt: dateFromNow(-2),
    progressStartedAt: null,
    project: {
      id: 'project-1',
      name: 'Operations',
      keyPrefix: 'OPS',
      parentId: null,
      team: { id: 'team-1', name: 'Ops', slug: 'ops' }
    },
    assignee: user('assignee'),
    reporter: null,
    attachments: [],
    labels: [],
    triageState: null,
    _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
    ...overrides
  } as HealthTask;
}
