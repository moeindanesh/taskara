import { describe, expect, test } from 'bun:test';
import { buildTeamOverviewGraph, type GraphPersonInput, type GraphTaskInput } from './use-team-overview-graph';
import { announcedArrivals } from './use-node-entrances';
import { taskNodeRadius } from './graph-model';
import { isInTodayLoad, isOverdue, workspaceDateKey, workspaceDay } from './today-load';

const tehran = 'Asia/Tehran';
// Tehran runs at UTC+03:30 year round, so a local day starts at 20:30 UTC the evening before.
const today = workspaceDay('2026-07-29', tehran);

function task(overrides: Partial<GraphTaskInput> = {}): GraphTaskInput {
   return {
      id: overrides.id ?? 'task-1',
      key: overrides.key ?? 'TSK-1',
      title: overrides.title ?? 'کار نمونه',
      status: overrides.status ?? 'TODO',
      dueAt: overrides.dueAt ?? null,
      completedAt: overrides.completedAt ?? null,
      weight: overrides.weight ?? null,
      assignee: overrides.assignee === undefined ? { id: 'user-1' } : overrides.assignee,
   };
}

function person(overrides: Partial<GraphPersonInput> = {}): GraphPersonInput {
   return {
      id: overrides.id ?? 'user-1',
      name: overrides.name ?? 'آرش',
      role: overrides.role ?? 'MEMBER',
      kind: overrides.kind ?? 'HUMAN',
      avatarUrl: overrides.avatarUrl ?? null,
   };
}

describe('workspace day boundaries', () => {
   test('resolves the day key in the workspace timezone, not the runtime one', () => {
      // 21:00 UTC on the 28th is already 00:30 on the 29th in Tehran.
      expect(workspaceDateKey(new Date('2026-07-28T21:00:00.000Z'), tehran)).toBe('2026-07-29');
      expect(workspaceDateKey(new Date('2026-07-28T20:00:00.000Z'), tehran)).toBe('2026-07-28');
   });

   test('covers the half-open range from local midnight to local midnight', () => {
      expect(new Date(today.start).toISOString()).toBe('2026-07-28T20:30:00.000Z');
      expect(new Date(today.end).toISOString()).toBe('2026-07-29T20:30:00.000Z');
   });
});

describe('isInTodayLoad', () => {
   const dueToday = '2026-07-29T10:00:00.000Z';
   const dueYesterday = '2026-07-28T10:00:00.000Z';
   const dueLongAgo = '2026-06-01T10:00:00.000Z';
   const dueTomorrow = '2026-07-30T10:00:00.000Z';

   for (const status of ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']) {
      test(`${status} counts when due today, however long overdue, and never when undated`, () => {
         expect(isInTodayLoad(task({ status, dueAt: dueToday }), today)).toBe(true);
         expect(isInTodayLoad(task({ status, dueAt: dueYesterday }), today)).toBe(true);
         expect(isInTodayLoad(task({ status, dueAt: dueLongAgo }), today)).toBe(true);
         expect(isInTodayLoad(task({ status, dueAt: dueTomorrow }), today)).toBe(false);
         expect(isInTodayLoad(task({ status, dueAt: null }), today)).toBe(false);
      });
   }

   test('DONE counts only when it was completed during this day', () => {
      expect(isInTodayLoad(task({ status: 'DONE', completedAt: '2026-07-29T09:00:00.000Z' }), today)).toBe(true);
      expect(isInTodayLoad(task({ status: 'DONE', completedAt: '2026-07-28T19:00:00.000Z' }), today)).toBe(false);
      expect(isInTodayLoad(task({ status: 'DONE', completedAt: null, dueAt: dueToday }), today)).toBe(false);
   });

   test('DONE respects the workspace midnight, not the UTC one', () => {
      // 20:29 UTC is 23:59 Tehran — still today. One minute later belongs to tomorrow.
      expect(isInTodayLoad(task({ status: 'DONE', completedAt: '2026-07-29T20:29:00.000Z' }), today)).toBe(true);
      expect(isInTodayLoad(task({ status: 'DONE', completedAt: '2026-07-29T20:30:00.000Z' }), today)).toBe(false);
      expect(isInTodayLoad(task({ status: 'DONE', completedAt: '2026-07-28T20:30:00.000Z' }), today)).toBe(true);
   });

   test('CANCELED never counts, however it is dated', () => {
      expect(isInTodayLoad(task({ status: 'CANCELED', dueAt: dueToday }), today)).toBe(false);
      expect(isInTodayLoad(task({ status: 'CANCELED', dueAt: dueYesterday }), today)).toBe(false);
      expect(isInTodayLoad(task({ status: 'CANCELED', completedAt: '2026-07-29T09:00:00.000Z' }), today)).toBe(false);
   });

   test('tolerates lowercase statuses and unparseable dates', () => {
      expect(isInTodayLoad(task({ status: 'in_progress', dueAt: dueToday }), today)).toBe(true);
      expect(isInTodayLoad(task({ status: 'TODO', dueAt: 'not-a-date' }), today)).toBe(false);
   });
});

describe('isOverdue', () => {
   test('is true only for unfinished work dated before this day began', () => {
      expect(isOverdue(task({ dueAt: '2026-07-28T10:00:00.000Z' }), today)).toBe(true);
      expect(isOverdue(task({ dueAt: '2026-07-29T10:00:00.000Z' }), today)).toBe(false);
      expect(isOverdue(task({ dueAt: null }), today)).toBe(false);
   });

   test('completed and canceled work is never overdue', () => {
      const dueAt = '2026-07-01T10:00:00.000Z';
      expect(isOverdue(task({ status: 'DONE', dueAt, completedAt: '2026-07-29T09:00:00.000Z' }), today)).toBe(false);
      expect(isOverdue(task({ status: 'CANCELED', dueAt }), today)).toBe(false);
   });
});

describe('taskNodeRadius', () => {
   test('grows with the square root of weight so area tracks the estimate', () => {
      expect(taskNodeRadius(4)).toBeCloseTo(taskNodeRadius(1) * 2, 5);
      expect(taskNodeRadius(8)).toBeGreaterThan(taskNodeRadius(4));
   });

   test('unestimated work takes the smallest radius', () => {
      expect(taskNodeRadius(null)).toBe(taskNodeRadius(1));
      expect(taskNodeRadius(undefined)).toBe(taskNodeRadius(1));
      expect(taskNodeRadius(0)).toBe(taskNodeRadius(1));
   });
});

describe('buildTeamOverviewGraph', () => {
   const workspaceLabel = 'دستک';

   function build(people: GraphPersonInput[], tasks: GraphTaskInput[]) {
      return buildTeamOverviewGraph({ day: today, people, tasks, workspaceLabel });
   }

   test('puts the workspace at the centre with a link to every visible person', () => {
      const graph = build([person({ id: 'user-1' }), person({ id: 'user-2', name: 'بهار' })], []);

      expect(graph.nodes[0]).toMatchObject({ id: 'workspace', kind: 'workspace', label: workspaceLabel });
      expect(graph.nodes.filter((node) => node.kind === 'person')).toHaveLength(2);
      expect(graph.links.filter((link) => link.kind === 'membership')).toHaveLength(2);
      expect(graph.links.every((link) => link.kind !== 'membership' || link.source === 'workspace')).toBe(true);
   });

   test('keeps humans and agents on the graph with an empty load, and hides only idle guests', () => {
      const graph = build(
         [
            person({ id: 'owner', role: 'OWNER', name: 'الف' }),
            person({ id: 'admin', role: 'ADMIN', name: 'ب' }),
            person({ id: 'member', role: 'MEMBER', name: 'پ' }),
            person({ id: 'guest', role: 'GUEST', name: 'ت' }),
            // Role MEMBER on purpose: agent-ness lives on the user, not on the membership role.
            person({ id: 'agent', role: 'MEMBER', kind: 'AGENT', name: 'ث' }),
         ],
         []
      );

      // An idle agent keeps its seat: it is a teammate, not a thing that appears only while busy.
      expect(graph.nodes.filter((node) => node.kind === 'person').map((node) => node.id)).toEqual([
         'user:owner',
         'user:admin',
         'user:member',
         'user:agent',
      ]);
   });

   test('an agent keeps its seat whatever role it holds, while a guest earns one with work', () => {
      const idle = build(
         [
            person({ id: 'guest', role: 'GUEST', name: 'الف' }),
            person({ id: 'agent', role: 'AGENT', kind: 'AGENT', name: 'ب' }),
         ],
         []
      );
      expect(idle.nodes.filter((node) => node.kind === 'person').map((node) => node.id)).toEqual(['user:agent']);

      const working = build(
         [
            person({ id: 'guest', role: 'GUEST', name: 'الف' }),
            person({ id: 'agent', role: 'AGENT', kind: 'AGENT', name: 'ب' }),
         ],
         [task({ id: 'a', key: 'TSK-1', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'guest' } })]
      );
      expect(working.nodes.filter((node) => node.kind === 'person').map((node) => node.id)).toEqual([
         'user:guest',
         'user:agent',
      ]);
   });

   test('marks agent people and their work so the renderer and the chime can tell them apart', () => {
      const graph = build(
         [
            person({ id: 'human', name: 'الف' }),
            person({ id: 'agent', role: 'MEMBER', kind: 'AGENT', name: 'ب' }),
         ],
         [
            task({ id: 'a', key: 'TSK-1', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'human' } }),
            task({ id: 'b', key: 'TSK-2', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'agent' } }),
         ]
      );

      const agentOf = (id: string) => graph.nodes.find((node) => node.id === id);
      expect(agentOf('user:human')).toMatchObject({ agent: false });
      expect(agentOf('user:agent')).toMatchObject({ agent: true });
      expect(agentOf('task:a')).toMatchObject({ agent: false });
      expect(agentOf('task:b')).toMatchObject({ agent: true });
   });

   test('agent work animates in without spending a chime slot', () => {
      const graph = build(
         [
            person({ id: 'human', name: 'الف' }),
            person({ id: 'agent', role: 'MEMBER', kind: 'AGENT', name: 'ب' }),
         ],
         [
            task({ id: 'a', key: 'TSK-1', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'human' } }),
            task({ id: 'b', key: 'TSK-2', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'agent' } }),
         ]
      );
      const entered = ['task:a', 'task:b', 'user:agent'];

      // Both task nodes arrived; only the human's is announced. People never chime at all.
      expect(announcedArrivals(entered, graph.nodes)).toEqual(['task:a']);
   });

   test('drops unassigned work and work belonging to former members', () => {
      const graph = build(
         [person({ id: 'user-1' })],
         [
            task({ id: 'a', key: 'TSK-1', dueAt: '2026-07-29T08:00:00.000Z', assignee: null }),
            task({ id: 'b', key: 'TSK-2', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'departed' } }),
            task({ id: 'c', key: 'TSK-3', dueAt: '2026-07-29T08:00:00.000Z' }),
         ]
      );

      expect(graph.nodes.filter((node) => node.kind === 'task').map((node) => node.id)).toEqual(['task:c']);
   });

   test('hangs each task off its assignee and carries the render inputs', () => {
      const graph = build(
         [person({ id: 'user-1' })],
         [task({ id: 'a', key: 'TSK-9', status: 'BLOCKED', weight: 4, dueAt: '2026-07-20T08:00:00.000Z' })]
      );

      const taskNode = graph.nodes.find((node) => node.kind === 'task');
      expect(taskNode).toMatchObject({
         id: 'task:a',
         taskKey: 'TSK-9',
         status: 'BLOCKED',
         weight: 4,
         overdue: true,
         assigneeId: 'user-1',
      });
      expect(graph.links).toContainEqual({
         id: 'assignment:a',
         source: 'user:user-1',
         target: 'task:a',
         kind: 'assignment',
      });
   });

   test('summarises each person load for their tooltip, counting unweighted work as zero', () => {
      const graph = build(
         [person({ id: 'user-1' })],
         [
            task({ id: 'a', key: 'TSK-1', weight: 3, dueAt: '2026-07-29T08:00:00.000Z' }),
            task({ id: 'b', key: 'TSK-2', weight: null, dueAt: '2026-07-29T08:00:00.000Z' }),
            task({ id: 'c', key: 'TSK-3', weight: 8, dueAt: '2026-07-30T08:00:00.000Z' }),
         ]
      );

      expect(graph.nodes.find((node) => node.kind === 'person')).toMatchObject({ taskCount: 2, totalWeight: 3 });
   });

   test('orders people and their work deterministically so the layout is stable', () => {
      const people = [person({ id: 'user-2', name: 'بهار' }), person({ id: 'user-1', name: 'آرش' })];
      const tasks = [
         task({ id: 'b', key: 'TSK-2', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'user-1' } }),
         task({ id: 'a', key: 'TSK-1', dueAt: '2026-07-29T08:00:00.000Z', assignee: { id: 'user-1' } }),
      ];

      expect(build(people, tasks).nodes.map((node) => node.id)).toEqual(
         build([...people].reverse(), [...tasks].reverse()).nodes.map((node) => node.id)
      );
   });
});
