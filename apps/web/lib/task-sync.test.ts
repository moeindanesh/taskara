import { describe, expect, test } from 'bun:test';
import type { TaskaraTask } from '@/lib/taskara-types';
import {
   reconcileBootstrappedTasksAfterSyncGap,
   replayPendingTaskMutationsForBootstrap,
   taskSyncMutationActionLabel,
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
