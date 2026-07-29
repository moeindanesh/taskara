import { describe, expect, test } from 'bun:test';
import { type ListedTask, isDueToday, selectPersonTasks, selectUnassignedTasks, urgencyRank, urgencyRanks } from './person-tasks';
import { workspaceDay } from './today-load';

const today = workspaceDay('2026-07-29', 'Asia/Tehran');

function task(overrides: Partial<ListedTask> = {}): ListedTask {
   return {
      id: overrides.id ?? 'task-1',
      key: overrides.key ?? 'TSK-1',
      title: overrides.title ?? 'کار',
      status: overrides.status ?? 'TODO',
      priority: overrides.priority ?? 'NO_PRIORITY',
      dueAt: overrides.dueAt ?? null,
      weight: overrides.weight ?? null,
      assignee: overrides.assignee === undefined ? { id: 'user-1' } : overrides.assignee,
   };
}

describe('urgency', () => {
   test('ranks overdue ahead of today, today ahead of upcoming, undated last', () => {
      expect(urgencyRank(task({ dueAt: '2026-07-20T08:00:00.000Z' }), today)).toBe(urgencyRanks.overdue);
      expect(urgencyRank(task({ dueAt: '2026-07-29T08:00:00.000Z' }), today)).toBe(urgencyRanks.today);
      expect(urgencyRank(task({ dueAt: '2026-08-05T08:00:00.000Z' }), today)).toBe(urgencyRanks.upcoming);
      expect(urgencyRank(task({ dueAt: null }), today)).toBe(urgencyRanks.undated);
   });

   test('due today follows the workspace clock, not the browser one', () => {
      expect(isDueToday(task({ dueAt: '2026-07-28T21:00:00.000Z' }), today)).toBe(true);
      expect(isDueToday(task({ dueAt: '2026-07-28T20:00:00.000Z' }), today)).toBe(false);
      expect(isDueToday(task({ dueAt: null }), today)).toBe(false);
   });
});

describe('selectPersonTasks', () => {
   test('keeps every open task for the person, whatever it is due', () => {
      const tasks = [
         task({ id: 'a', key: 'TSK-1', dueAt: '2026-07-29T08:00:00.000Z' }),
         task({ id: 'b', key: 'TSK-2', dueAt: null }),
         task({ id: 'c', key: 'TSK-3', dueAt: '2026-09-01T08:00:00.000Z' }),
      ];

      expect(selectPersonTasks(tasks, 'user-1', today).map((item) => item.id)).toEqual(['a', 'c', 'b']);
   });

   test('drops finished, canceled and other people’s work', () => {
      const tasks = [
         task({ id: 'mine', key: 'TSK-1' }),
         task({ id: 'done', key: 'TSK-2', status: 'DONE' }),
         task({ id: 'canceled', key: 'TSK-3', status: 'CANCELED' }),
         task({ id: 'theirs', key: 'TSK-4', assignee: { id: 'user-2' } }),
         task({ id: 'nobody', key: 'TSK-5', assignee: null }),
      ];

      expect(selectPersonTasks(tasks, 'user-1', today).map((item) => item.id)).toEqual(['mine']);
   });

   test('sorts overdue first, then by date, then by priority', () => {
      const tasks = [
         task({ id: 'today-low', key: 'TSK-3', dueAt: '2026-07-29T08:00:00.000Z', priority: 'LOW' }),
         task({ id: 'today-urgent', key: 'TSK-4', dueAt: '2026-07-29T08:00:00.000Z', priority: 'URGENT' }),
         task({ id: 'overdue', key: 'TSK-1', dueAt: '2026-07-01T08:00:00.000Z', priority: 'LOW' }),
         task({ id: 'later', key: 'TSK-5', dueAt: '2026-08-20T08:00:00.000Z', priority: 'URGENT' }),
      ];

      expect(selectPersonTasks(tasks, 'user-1', today).map((item) => item.id)).toEqual([
         'overdue',
         'today-urgent',
         'today-low',
         'later',
      ]);
   });
});

describe('selectUnassignedTasks', () => {
   test('returns only open work nobody owns, most urgent first', () => {
      const tasks = [
         task({ id: 'free-later', key: 'TSK-2', assignee: null, dueAt: '2026-08-10T08:00:00.000Z' }),
         task({ id: 'free-overdue', key: 'TSK-1', assignee: null, dueAt: '2026-07-02T08:00:00.000Z' }),
         task({ id: 'free-done', key: 'TSK-3', assignee: null, status: 'DONE' }),
         task({ id: 'taken', key: 'TSK-4' }),
      ];

      expect(selectUnassignedTasks(tasks, today).map((item) => item.id)).toEqual(['free-overdue', 'free-later']);
   });
});
