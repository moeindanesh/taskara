import { describe, expect, test } from 'bun:test';
import type { TaskaraTask } from '@/lib/taskara-types';
import { admitTasksToCache, isEffort, selectWorkTasks } from './work-tasks';

describe('telling an effort from work', () => {
   test('an effort is not work', () => {
      expect(isEffort(task({ kind: 'EFFORT' }))).toBe(true);
      expect(isEffort(task({ kind: 'WORK' }))).toBe(false);
   });

   test('a row that carries no kind is work, because efforts postdate every such row', () => {
      expect(isEffort(task({}))).toBe(false);
   });

   test('emptiness is never the test — a work row stripped of every work field is still work', () => {
      const bare = task({ assignee: null, dueAt: null, weight: null, milestoneId: null, parentId: null });

      expect(isEffort(bare)).toBe(false);
      expect(selectWorkTasks([bare])).toEqual([bare]);
   });
});

describe('the client task cache admits work only', () => {
   test('drops efforts arriving from the server', () => {
      const work = task({ id: 'work-1', kind: 'WORK' });
      const effort = task({ id: 'effort-1', kind: 'EFFORT' });

      expect(admitTasksToCache([], [work, effort])).toEqual([work]);
   });

   test('drops efforts written by an updater, not just by a replacement array', () => {
      const work = task({ id: 'work-1', kind: 'WORK' });
      const effort = task({ id: 'effort-1', kind: 'EFFORT' });

      expect(admitTasksToCache([work], (current) => [effort, ...current])).toEqual([work]);
   });

   test('evicts an effort that a stale snapshot already put in the cache', () => {
      const stale = task({ id: 'effort-1', kind: 'EFFORT' });
      const work = task({ id: 'work-1', kind: 'WORK' });

      expect(admitTasksToCache([stale], (current) => [...current, work])).toEqual([work]);
   });

   test('leaves an ordinary write untouched so the gate costs consumers nothing', () => {
      const tasks = [task({ id: 'work-1' }), task({ id: 'work-2' })];

      expect(admitTasksToCache([], tasks)).toEqual(tasks);
   });
});

function task(overrides: Partial<TaskaraTask>): TaskaraTask {
   return {
      id: 'task-1',
      key: 'CORE-1',
      title: 'Task',
      status: 'TODO',
      priority: 'NO_PRIORITY',
      ...overrides,
   };
}
