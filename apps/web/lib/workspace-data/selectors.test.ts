import { describe, expect, test } from 'bun:test';
import { selectIssueDetail, selectSidebarCounts, selectTasksAssignedToUser } from './selectors';
import { createWorkspaceDataState, emptyWorkspaceDataEntities, type WorkspaceDataEntities } from './store';
import type { TaskaraMilestone, TaskaraTask, TaskaraTaskReview } from '../taskara-types';

const baseNow = Date.parse('2026-07-05T10:00:00.000Z');

describe('workspace-data selectors', () => {
   test('derives sidebar counts from active manager entities without counting future snoozes', () => {
      const restoreNow = mockNow(baseNow);
      try {
         const state = createWorkspaceDataState(
            {
               tasks: [
                  task({ id: 'task-1', assignee: user('user-1'), status: 'TODO' }),
                  task({ id: 'task-2', assignee: user('user-1'), status: 'DONE' }),
                  task({ id: 'task-3', assignee: user('user-2'), status: 'BLOCKED' }),
               ],
               milestones: [
                  milestone({ id: 'overdue-owned', ownerId: 'user-1', targetOn: '2026-07-04' }),
                  milestone({ id: 'future-owned', ownerId: 'user-1', targetOn: '2026-07-06' }),
                  milestone({ id: 'overdue-other', ownerId: 'user-2', targetOn: '2026-07-01' }),
               ],
               projects: [],
               teams: [],
               users: [],
               views: [],
            },
            entities({
               attention: {
                  'attention-open': attention({ id: 'attention-open', status: 'OPEN' }),
                  'attention-future': attention({
                     id: 'attention-future',
                     status: 'SNOOZED',
                     snoozedUntil: '2026-07-05T12:00:00.000Z',
                  }),
                  'attention-due': attention({
                     id: 'attention-due',
                     status: 'SNOOZED',
                     snoozedUntil: '2026-07-05T09:00:00.000Z',
                  }),
               },
               reviews: {
                  'review-1': review({ id: 'review-1', status: 'REQUESTED' }),
                  'review-2': review({ id: 'review-2', status: 'APPROVED' }),
               },
            })
         );

         expect(selectSidebarCounts(state, 'user-1')).toEqual({
            activeAttentionCount: 2,
            reviewCount: 1,
            activeTaskCount: 2,
            myActiveTaskCount: 1,
            myOpenActionItemCount: 0,
            myOverdueMilestoneCount: 1,
         });
      } finally {
         restoreNow();
      }
   });

   test('selects issue detail and sorts reviews newest first', () => {
      const state = createWorkspaceDataState(
         {
            tasks: [task({ id: 'task-1', key: 'CORE-1' })],
            milestones: [],
            projects: [],
            teams: [],
            users: [user('user-1')],
            views: [],
         },
         entities({
            reviews: {
               old: review({ id: 'old', taskId: 'task-1', requestedAt: '2026-07-01T00:00:00.000Z' }),
               new: review({ id: 'new', taskId: 'task-1', requestedAt: '2026-07-05T00:00:00.000Z' }),
            },
         })
      );

      const detail = selectIssueDetail(state, 'CORE-1');

      expect(detail.task?.id).toBe('task-1');
      expect(detail.reviews.map((item) => item.id)).toEqual(['new', 'old']);
      expect(detail.users.map((item) => item.id)).toEqual(['user-1']);
   });

   test('selects assigned tasks in recent order', () => {
      const state = createWorkspaceDataState({
         tasks: [
            task({ id: 'old', assignee: user('user-1'), updatedAt: '2026-07-01T00:00:00.000Z' }),
            task({ id: 'other', assignee: user('user-2'), updatedAt: '2026-07-06T00:00:00.000Z' }),
            task({ id: 'new', assignee: user('user-1'), updatedAt: '2026-07-05T00:00:00.000Z' }),
         ],
         milestones: [],
         projects: [],
         teams: [],
         users: [],
         views: [],
      });

      expect(selectTasksAssignedToUser(state, 'user-1').map((item) => item.id)).toEqual(['new', 'old']);
   });
});

function entities(overrides: Partial<WorkspaceDataEntities>): WorkspaceDataEntities {
   return { ...emptyWorkspaceDataEntities(), ...overrides };
}

function milestone(overrides: Partial<TaskaraMilestone> = {}): TaskaraMilestone {
   return {
      id: 'milestone-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      ownerId: null,
      name: 'Milestone',
      kind: 'FEATURE',
      status: 'ACTIVE',
      health: null,
      position: 1024,
      version: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      project: { id: 'project-1', name: 'Project', keyPrefix: 'CORE' },
      owner: null,
      progress: {
         totalTasks: 0,
         eligibleTasks: 0,
         completedTasks: 0,
         canceledTasks: 0,
         blockedTasks: 0,
         overdueTasks: 0,
         totalWeight: 0,
         completedWeight: 0,
         percentage: null,
      },
      ...overrides,
   };
}

function task(overrides: Partial<TaskaraTask> = {}): TaskaraTask {
   return {
      id: 'task-1',
      key: 'CORE-1',
      title: 'Task',
      status: 'TODO',
      priority: 'MEDIUM',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      assignee: null,
      ...overrides,
   };
}

function review(overrides: Partial<TaskaraTaskReview> = {}): TaskaraTaskReview {
   return {
      id: 'review-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      reviewerId: 'user-1',
      status: 'REQUESTED',
      requestedAt: '2026-07-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
   };
}

function attention(overrides: Record<string, unknown> = {}) {
   return {
      id: 'attention-1',
      workspaceId: 'workspace-1',
      assigneeId: 'user-1',
      managerId: null,
      entityType: 'task',
      entityId: 'task-1',
      reason: 'overdue_task',
      severity: 'HIGH',
      status: 'OPEN',
      firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z',
      snoozedUntil: null,
      resolvedAt: null,
      dismissedAt: null,
      dismissalReason: null,
      payload: {},
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
   } as WorkspaceDataEntities['attention'][string];
}

function user(id: string) {
   return {
      id,
      membershipId: `member-${id}`,
      email: `${id}@example.com`,
      name: id,
      role: 'MEMBER',
      joinedAt: '2026-07-01T00:00:00.000Z',
   };
}

function mockNow(value: number): () => void {
   const original = Date.now;
   Date.now = () => value;
   return () => {
      Date.now = original;
   };
}
