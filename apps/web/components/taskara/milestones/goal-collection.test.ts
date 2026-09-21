import { describe, expect, test } from 'bun:test';
import type { TaskaraTask } from '@/lib/taskara-types';
import { goalTimelinePlacement } from './goal-collection';
import { mergeGoalTasks } from './milestone-tasks-panel';

const start = Date.parse('2026-09-01T00:00:00Z');
const end = Date.parse('2026-09-11T00:00:00Z');

describe('goal timeline', () => {
   test('clips a duration to the visible window', () => {
      expect(goalTimelinePlacement({ startsOn: '2026-08-01', targetOn: '2026-09-05' }, start, end)).toEqual({ left: 0, width: 50 });
      expect(goalTimelinePlacement({ startsOn: '2026-09-06', targetOn: '2026-10-01' }, start, end)).toEqual({ left: 50, width: 50 });
   });
   test('shows a target-only goal as a one-day marker', () => {
      expect(goalTimelinePlacement({ startsOn: null, targetOn: '2026-09-03' }, start, end)).toEqual({ left: 20, width: 10 });
   });
   test('does not invent dates for unscheduled or out-of-window goals', () => {
      expect(goalTimelinePlacement({ startsOn: null, targetOn: null }, start, end)).toBeNull();
      expect(goalTimelinePlacement({ startsOn: '2026-07-01', targetOn: '2026-08-31' }, start, end)).toBeNull();
      expect(goalTimelinePlacement({ startsOn: '2026-09-11', targetOn: '2026-09-15' }, start, end)).toBeNull();
      expect(goalTimelinePlacement({ startsOn: '2026-09-05', targetOn: '2026-09-02' }, start, end)).toBeNull();
      expect(goalTimelinePlacement({ startsOn: null, targetOn: 'invalid' }, start, end)).toBeNull();
   });
});

function task(id: string, overrides: Partial<TaskaraTask> = {}): TaskaraTask {
   return {
      id, key: `GOAL-${id}`, title: `Task ${id}`, status: 'TODO', priority: 'NO_PRIORITY',
      project: { id: 'project', name: 'Project', keyPrefix: 'GOAL' },
      milestoneId: 'goal', ...overrides,
   };
}

describe('live goal tasks', () => {
   test('retains historical tasks outside the hot cache and adds newly created work', () => {
      const old = task('old', { status: 'DONE' });
      const current = task('current');
      expect(mergeGoalTasks([old], [current], 'goal')).toEqual([old, current]);
   });
   test('removes tasks moved out and excludes efforts', () => {
      expect(mergeGoalTasks([task('1')], [task('1', { milestoneId: 'other' }), task('2', { kind: 'EFFORT' })], 'goal')).toEqual([]);
   });
   test('reconciles optimistic creates without leaving duplicate local rows', () => {
      const optimistic = task('local-1', { syncState: 'pending' });
      const confirmed = task('confirmed');
      expect(mergeGoalTasks([optimistic], [confirmed], 'goal')).toEqual([confirmed]);
      expect(mergeGoalTasks([optimistic], [optimistic], 'goal')).toEqual([optimistic]);
      expect(mergeGoalTasks([optimistic], [], 'goal')).toEqual([]);
   });
   test('applies the active search to local resource updates', () => {
      expect(mergeGoalTasks([], [task('1'), task('2')], 'goal', 'GOAL-2').map((item) => item.id)).toEqual(['2']);
   });
});
