import { describe, expect, test } from 'bun:test';
import type { TaskaraTask } from '@/lib/taskara-types';
import {
   isOpenBlocker,
   matchesBlockersFilter,
   openBlockerCount,
   readTakeability,
} from './takeability';

describe('what counts as still in the way', () => {
   test('an unfinished blocker is open', () => {
      for (const status of ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']) {
         expect(isOpenBlocker({ status })).toBe(true);
      }
   });

   test('a finished or abandoned blocker is not', () => {
      expect(isOpenBlocker({ status: 'DONE' })).toBe(false);
      expect(isOpenBlocker({ status: 'CANCELED' })).toBe(false);
   });
});

describe('reading takeability off the detail payload', () => {
   test('openness comes from the blocker status, not from edge membership', () => {
      const state = readTakeability(
         task({
            blockingDependencies: [
               edge('dep-1', blocker('B-1', 'IN_PROGRESS')),
               edge('dep-2', blocker('B-2', 'DONE')),
            ],
         })
      );

      expect(state.openBlockers.map((item) => item.key)).toEqual(['B-1']);
      expect(state.takeable).toBe(false);
   });

   test('a task whose only blocker is finished is takeable, though the edge remains', () => {
      const state = readTakeability(
         task({ blockingDependencies: [edge('dep-1', blocker('B-1', 'DONE'))] })
      );

      expect(state.takeable).toBe(true);
      expect(state.openBlockers).toEqual([]);
      expect(state.closedBlockers.map((item) => item.key)).toEqual(['B-1']);
   });

   test('a canceled blocker is closed too, so cancelling a prerequisite unblocks the task', () => {
      const state = readTakeability(
         task({ blockingDependencies: [edge('dep-1', blocker('B-1', 'CANCELED'))] })
      );

      expect(state.takeable).toBe(true);
      expect(state.closedBlockers.map((item) => item.key)).toEqual(['B-1']);
   });

   test('closed blockers are kept as history rather than dropped', () => {
      const state = readTakeability(
         task({
            blockingDependencies: [
               edge('dep-1', blocker('B-1', 'DONE')),
               edge('dep-2', blocker('B-2', 'CANCELED')),
            ],
         })
      );

      expect(state.closedBlockers.map((item) => item.key)).toEqual(['B-1', 'B-2']);
   });

   test('the downstream direction is carried too, unfiltered', () => {
      const state = readTakeability(
         task({
            blockedTasks: [
               reverseEdge('dep-1', blocker('D-1', 'TODO')),
               reverseEdge('dep-2', blocker('D-2', 'DONE')),
            ],
         })
      );

      expect(state.blocks.map((item) => item.key)).toEqual(['D-1', 'D-2']);
   });

   test('a task with nothing at either end has no dependencies to draw', () => {
      const state = readTakeability(task({ blockingDependencies: [], blockedTasks: [] }));

      expect(state.hasDependencies).toBe(false);
      expect(state.takeable).toBe(true);
   });

   test('a row from a list payload, with no edge arrays at all, is silent rather than broken', () => {
      const state = readTakeability(task({}));

      expect(state.hasDependencies).toBe(false);
      expect(state.openBlockers).toEqual([]);
      expect(state.blocks).toEqual([]);
   });

   // The reason the section exists at all rather than a rail-only chip: a map needs the downstream
   // direction as much as the upstream one, and this task is takeable *and* worth drawing.
   test('a takeable task that blocks something else still has dependencies to draw', () => {
      const state = readTakeability(
         task({ blockedTasks: [reverseEdge('dep-1', blocker('D-1', 'TODO'))] })
      );

      expect(state.takeable).toBe(true);
      expect(state.hasDependencies).toBe(true);
   });

   test('a task whose every blocker is finished still has dependencies to draw', () => {
      const state = readTakeability(
         task({ blockingDependencies: [edge('dep-1', blocker('B-1', 'DONE'))] })
      );

      expect(state.hasDependencies).toBe(true);
   });

   test('an edge with nothing on the far end is dropped rather than counted as a blocker', () => {
      const state = readTakeability(
         task({ blockingDependencies: [{ id: 'dep-1' }, edge('dep-2', blocker('B-2', 'TODO'))] })
      );

      expect(state.openBlockers.map((item) => item.key)).toEqual(['B-2']);
   });
});

describe('the count a list row carries', () => {
   test('is the server-filtered open-blocker count', () => {
      expect(openBlockerCount(task({ _count: { blockingDependencies: 2 } }))).toBe(2);
   });

   test('is zero for a row that carries no count, such as one created offline', () => {
      expect(openBlockerCount(task({}))).toBe(0);
   });
});

describe('the blockers filter', () => {
   const blocked = task({ id: 'blocked', _count: { blockingDependencies: 1 } });
   const free = task({ id: 'free', _count: { blockingDependencies: 0 } });

   test('all admits everything', () => {
      expect(matchesBlockersFilter(blocked, 'all')).toBe(true);
      expect(matchesBlockersFilter(free, 'all')).toBe(true);
   });

   test('none is the frontier', () => {
      expect(matchesBlockersFilter(free, 'none')).toBe(true);
      expect(matchesBlockersFilter(blocked, 'none')).toBe(false);
   });

   test('any is what is stuck', () => {
      expect(matchesBlockersFilter(blocked, 'any')).toBe(true);
      expect(matchesBlockersFilter(free, 'any')).toBe(false);
   });
});

function task(overrides: Partial<TaskaraTask>): TaskaraTask {
   return {
      id: 'task-1',
      key: 'CORE-1',
      title: 'کار نمونه',
      status: 'TODO',
      priority: 'NO_PRIORITY',
      ...overrides,
   };
}

function blocker(key: string, status: string) {
   return { id: `id-${key}`, key, title: `عنوان ${key}`, status };
}

function edge(id: string, blockedByTask: ReturnType<typeof blocker>) {
   return { id, blockedByTask };
}

function reverseEdge(id: string, downstream: ReturnType<typeof blocker>) {
   return { id, task: downstream };
}
