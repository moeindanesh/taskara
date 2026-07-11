import { describe, expect, test } from 'bun:test';
import type { TaskaraMilestone, TaskaraProject, TaskaraTask } from '@/lib/taskara-types';
import {
   applyMilestoneEventsWithPending,
   applyOptimisticMilestoneLifecycle,
   applyOptimisticMilestonePatch,
   applyOptimisticMilestoneReorder,
   applyOptimisticTaskPatch,
   buildOptimisticMilestone,
   reconcileBootstrappedTasksAfterSyncGap,
   normalizeMilestoneResources,
   mutationBelongsToAuthIdentity,
   orderPersistedTaskMutations,
   replayPendingMilestoneMutationsForBootstrap,
   replayPendingTaskMutationsForBootstrap,
   taskSyncMutationActionLabel,
   taskSyncScopeKeyForIdentity,
   taskSyncMutationUserMessage,
   type PersistedTaskMutation,
} from './task-sync';

describe('task sync mutation rejection copy', () => {
   test('formats manager conflict messages with action-specific Persian copy', () => {
      expect(
         taskSyncMutationUserMessage({
            code: 'mutation_conflict',
            name: 'project_health_update.create',
            status: 'conflict',
         })
      ).toBe('ثبت آپدیت سلامت پروژه اعمال نشد، چون داده روی سرور تغییر کرده است. صفحه را به‌روزرسانی کنید و دوباره تصمیم بگیرید.');
   });

   test('formats rejected attention actions without exposing raw mutation names', () => {
      const message = taskSyncMutationUserMessage({
         code: 'mutation_failed',
         name: 'attention.snooze',
         status: 'rejected',
      });

      expect(message).toContain('تعویق مورد توجه');
      expect(message).not.toContain('attention.snooze');
   });

   test('falls back safely for unknown mutation names', () => {
      expect(taskSyncMutationActionLabel('unknown.mutation')).toBe('این تغییر');
      expect(
         taskSyncMutationUserMessage({
            code: 'mutation_failed',
            name: 'unknown.mutation',
            status: 'rejected',
         })
      ).toContain('این تغییر اعمال نشد');
   });
});

describe('task sync bootstrap pending replay', () => {
   test('normalizes v1 cache snapshots without milestones and rejects malformed resources', () => {
      expect(normalizeMilestoneResources(undefined)).toEqual([]);
      expect(normalizeMilestoneResources([{ id: 'broken' }, null, 'bad'])).toEqual([]);
   });

   test('partitions cache scopes and queued writes by authenticated workspace user', () => {
      const scope = { workspaceSlug: 'dastak', teamId: 'all', mine: false };
      const aliceScope = taskSyncScopeKeyForIdentity(scope, { workspaceSlug: 'dastak', userId: 'alice' });
      const bobScope = taskSyncScopeKeyForIdentity(scope, { workspaceSlug: 'dastak', userId: 'bob' });
      expect(aliceScope).not.toBe(bobScope);

      const aliceMutation = mutation({ authIdentityKey: 'dastak:alice', scopeKey: aliceScope });
      expect(mutationBelongsToAuthIdentity(aliceMutation, 'dastak:alice')).toBeTrue();
      expect(mutationBelongsToAuthIdentity(aliceMutation, 'dastak:bob')).toBeFalse();
      expect(mutationBelongsToAuthIdentity(mutation({ authIdentityKey: undefined }), 'dastak:alice')).toBeFalse();
   });

   test('replays pending task create, update, and delete mutations over fresh bootstrap data', () => {
      const updated = task({
         id: 'task-update',
         key: 'CORE-2',
         title: 'Offline title',
         syncState: 'pending',
         syncMutationId: 'mutation-update',
      });
      const created = task({
         id: 'local-mutation-create',
         key: 'NEW-MUTATION',
         title: 'Offline create',
         syncState: 'pending',
         syncMutationId: 'mutation-create',
      });

      const next = replayPendingTaskMutationsForBootstrap(
         [
            task({ id: 'task-delete', key: 'CORE-1', title: 'Server delete candidate' }),
            task({ id: 'task-update', key: 'CORE-2', title: 'Server title' }),
         ],
         [
            mutation({ mutationId: 'mutation-delete', deletedTaskId: 'task-delete', deletedTaskKey: 'CORE-1' }),
            mutation({ mutationId: 'mutation-update', optimisticTask: updated }),
            mutation({ mutationId: 'mutation-create', optimisticTask: created }),
         ]
      );

      expect(next.map((item) => item.id)).toEqual(['local-mutation-create', 'task-update']);
      expect(next.find((item) => item.id === 'task-update')?.title).toBe('Offline title');
      expect(next.find((item) => item.id === 'task-delete')).toBeUndefined();
   });

   test('preserves visible pending tasks when reset-required pull forces re-bootstrap', () => {
      const pendingVisible = task({
         id: 'local-visible',
         key: 'NEW-VISIBLE',
         title: 'Visible pending create',
         syncState: 'pending',
         syncMutationId: 'mutation-visible',
      });

      const next = reconcileBootstrappedTasksAfterSyncGap(
         [pendingVisible, task({ id: 'task-stale', key: 'CORE-1', title: 'Old visible task' })],
         [task({ id: 'task-fresh', key: 'CORE-2', title: 'Fresh bootstrap task' })],
         [mutation({ mutationId: 'mutation-visible', optimisticTask: pendingVisible })]
      );

      expect(next.map((item) => item.id)).toEqual(['local-visible', 'task-fresh']);
      expect(next[0]?.syncState).toBe('pending');
   });

   test('replays pending milestone creates and successive edits over a fresh bootstrap', () => {
      const created = milestone({
         id: 'pending-milestone',
         name: 'Offline phase',
         version: 1,
         syncState: 'pending',
         syncMutationId: 'milestone-create',
      });
      const edited = milestone({
         ...created,
         name: 'Offline phase renamed',
         version: 2,
         syncMutationId: 'milestone-update',
      });

      const next = replayPendingMilestoneMutationsForBootstrap(
         [milestone({ id: 'server-milestone', name: 'Server milestone' })],
         [
            mutation({
               mutationId: 'milestone-create',
               name: 'milestone.create',
               optimisticMilestone: created,
            }),
            mutation({
               mutationId: 'milestone-update',
               name: 'milestone.update',
               createdAt: '2026-07-05T10:01:00.000Z',
               optimisticMilestone: edited,
            }),
         ]
      );

      expect(next.map((item) => item.id)).toEqual(['pending-milestone', 'server-milestone']);
      expect(next[0]?.name).toBe('Offline phase renamed');
      expect(next[0]?.version).toBe(2);
      expect(next[0]?.syncMutationId).toBe('milestone-update');
   });

   test('orders dependent offline mutations before consumers even when IndexedDB key order differs', () => {
      const taskAssignment = mutation({
         mutationId: 'aaa-task-assignment',
         name: 'task.update',
         createdAt: '2026-07-05T10:00:00.000Z',
         dependsOnMutationIds: ['zzz-milestone-create'],
      });
      const milestoneCreate = mutation({
         mutationId: 'zzz-milestone-create',
         name: 'milestone.create',
         createdAt: '2026-07-05T10:00:00.000Z',
      });
      const laterMetadata = mutation({
         mutationId: 'bbb-milestone-update',
         name: 'milestone.update',
         createdAt: '2026-07-05T10:00:00.001Z',
         dependsOnMutationIds: ['zzz-milestone-create'],
      });

      expect(orderPersistedTaskMutations([taskAssignment, laterMetadata, milestoneCreate]).map((item) => item.mutationId)).toEqual([
         'zzz-milestone-create',
         'aaa-task-assignment',
         'bbb-milestone-update',
      ]);
   });
});

describe('milestone local-first mutations', () => {
   const baseProject = project('project-a', 'A');
   const resources = {
      milestones: [milestone({ id: 'existing', projectId: baseProject.id, project: baseProject, position: 1024 })],
      projects: [baseProject],
      teams: [],
      users: [{
         id: 'user-1',
         membershipId: 'membership-1',
         name: 'Owner',
         email: 'owner@example.com',
         phone: null,
         avatarUrl: null,
         role: 'MEMBER',
         joinedAt: '2026-07-01T00:00:00.000Z',
      }],
      views: [],
   };

   test('builds a stable client-id create that later offline task mutations can reference', () => {
      const optimistic = buildOptimisticMilestone(
         '11111111-1111-4111-8111-111111111111',
         {
            id: '11111111-1111-4111-8111-111111111111',
            projectId: baseProject.id,
            name: 'Client allocated milestone',
            kind: 'FEATURE',
            status: 'PLANNED',
            ownerId: 'user-1',
         },
         resources,
         'mutation-create'
      );

      expect(optimistic.id).toBe('11111111-1111-4111-8111-111111111111');
      expect(optimistic.position).toBe(2048);
      expect(optimistic.owner?.id).toBe('user-1');
      expect(optimistic.syncState).toBe('pending');
      expect(optimistic.version).toBe(1);
      expect(optimistic.readyToComplete).toBe(false);
      expect(optimistic.attentionReasons).toEqual([{ reason: 'target_missing' }]);
   });

   test('increments optimistic versions across metadata, order, and lifecycle changes', () => {
      const current = milestone({ version: 4, position: 2048 });
      const updated = applyOptimisticMilestonePatch(
         current,
         { name: 'Retained draft', ownerId: 'user-1' },
         resources,
         'mutation-update'
      );
      const reordered = applyOptimisticMilestoneReorder(
         [milestone({ id: 'before', position: 1024 }), current, milestone({ id: 'after', position: 4096 })],
         updated,
         { beforeId: 'before', afterId: 'after' },
         'mutation-reorder'
      );
      const completed = applyOptimisticMilestoneLifecycle(reordered, 'complete', 'mutation-complete');

      expect(updated.version).toBe(5);
      expect(updated.owner?.id).toBe('user-1');
      expect(reordered.version).toBe(6);
      expect(reordered.position).toBe(2560);
      expect(completed.version).toBe(7);
      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).toBeTruthy();
      expect(completed.canceledAt).toBeNull();
      expect(completed.attentionReasons.some((reason) => reason.reason === 'target_overdue')).toBe(false);
   });

   test('keeps the latest optimistic draft through remote and stale local events, then acknowledges it', () => {
      const pending = milestone({
         name: 'Latest local draft',
         syncState: 'pending',
         syncMutationId: 'mutation-latest',
      });
      const remote = milestone({ name: 'Remote value', version: 2 });
      const staleLocal = milestone({ name: 'Earlier local value', version: 2 });
      const confirmed = milestone({ name: 'Latest local draft', version: 3 });

      const afterRemote = applyMilestoneEventsWithPending([pending], [{
         entityType: 'milestone',
         entityId: pending.id,
         type: 'upsert',
         entity: remote,
         clientId: 'another-client',
         mutationId: 'remote-mutation',
      }], 'client-1');
      const afterStale = applyMilestoneEventsWithPending(afterRemote, [{
         entityType: 'milestone',
         entityId: pending.id,
         type: 'upsert',
         entity: staleLocal,
         clientId: 'client-1',
         mutationId: 'mutation-earlier',
      }], 'client-1');
      const afterAck = applyMilestoneEventsWithPending(afterStale, [{
         entityType: 'milestone',
         entityId: pending.id,
         type: 'upsert',
         entity: confirmed,
         clientId: 'client-1',
         mutationId: 'mutation-latest',
      }], 'client-1');

      expect(afterRemote[0]?.name).toBe('Latest local draft');
      expect(afterStale[0]?.name).toBe('Latest local draft');
      expect(afterAck[0]?.version).toBe(3);
      expect(afterAck[0]?.syncState).toBeUndefined();
      expect(afterAck[0]?.syncMutationId).toBeUndefined();
   });
});

describe('task sync optimistic milestone relations', () => {
   const projectA = project('project-a', 'A');
   const projectB = project('project-b', 'B');
   const milestoneA = milestone({ id: 'milestone-a', projectId: projectA.id, project: projectA });
   const milestoneB = milestone({ id: 'milestone-b', projectId: projectB.id, project: projectB });
   const resources = { milestones: [milestoneA, milestoneB], projects: [projectA, projectB], teams: [], users: [], views: [] };

   test('clears the milestone immediately when a project changes without a replacement', () => {
      const current = task({
         project: projectA,
         milestoneId: milestoneA.id,
         milestone: {
            id: milestoneA.id,
            name: milestoneA.name,
            kind: milestoneA.kind,
            status: milestoneA.status,
            projectId: projectA.id,
         },
      });

      const next = applyOptimisticTaskPatch(current, { projectId: projectB.id }, resources);
      expect(next.project?.id).toBe(projectB.id);
      expect(next.milestoneId).toBeNull();
      expect(next.milestone).toBeNull();
   });

   test('supports an atomic project and milestone move', () => {
      const current = task({ project: projectA, milestoneId: milestoneA.id });
      const next = applyOptimisticTaskPatch(
         current,
         { projectId: projectB.id, milestoneId: milestoneB.id },
         resources
      );
      expect(next.project?.id).toBe(projectB.id);
      expect(next.milestoneId).toBe(milestoneB.id);
      expect(next.milestone?.projectId).toBe(projectB.id);
   });
});

function mutation(overrides: Partial<PersistedTaskMutation>): PersistedTaskMutation {
   return {
      clientId: 'client-1',
      mutationId: 'mutation-1',
      name: 'task.update',
      args: {},
      createdAt: '2026-07-05T10:00:00.000Z',
      scopeKey: 'dastak:all:all',
      ...overrides,
   };
}

function task(overrides: Partial<TaskaraTask> = {}): TaskaraTask {
   return {
      id: 'task-1',
      key: 'CORE-1',
      title: 'Task',
      description: null,
      status: 'TODO',
      priority: 'MEDIUM',
      weight: null,
      dueAt: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      completedAt: null,
      progressStartedAt: null,
      version: 1,
      assignee: null,
      project: null,
      labels: [],
      _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
      ...overrides,
   };
}

function project(id: string, keyPrefix: string): TaskaraProject {
   return { id, name: `Project ${keyPrefix}`, keyPrefix, status: 'ACTIVE' };
}

function milestone(overrides: Partial<TaskaraMilestone> = {}): TaskaraMilestone {
   const baseProject = project('project-a', 'A');
   return {
      id: 'milestone-a',
      workspaceId: 'workspace-1',
      projectId: baseProject.id,
      ownerId: null,
      name: 'Feature milestone',
      kind: 'FEATURE',
      status: 'ACTIVE',
      health: null,
      position: 1024,
      version: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      project: baseProject,
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
