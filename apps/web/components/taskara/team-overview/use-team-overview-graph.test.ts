import { describe, expect, test } from 'bun:test';
import { type GraphPersonInput, type GraphTaskInput, buildTeamOverviewGraph } from './use-team-overview-graph';
import { currentWorkspaceDay } from './today-load';

const day = currentWorkspaceDay();

const people: GraphPersonInput[] = [
   { id: 'user-a', name: 'آرش', role: 'MEMBER' },
   { id: 'user-b', name: 'بهار', role: 'MEMBER' },
   { id: 'user-guest', name: 'مهمان', role: 'GUEST' },
];

const task = (id: string, assigneeId: string): GraphTaskInput => ({
   id,
   key: id.toUpperCase(),
   title: id,
   status: 'TODO',
   weight: 2,
   dueAt: new Date(day.start + 60_000).toISOString(),
   completedAt: null,
   assignee: { id: assigneeId },
});

function build(hiddenPersonIds?: Set<string>) {
   return buildTeamOverviewGraph({
      day,
      hiddenPersonIds,
      people,
      tasks: [task('task-a1', 'user-a'), task('task-a2', 'user-a'), task('task-b1', 'user-b')],
      workspaceLabel: 'فضای کاری',
   });
}

describe('buildTeamOverviewGraph with hidden people', () => {
   test('draws everyone with a seat when nobody is hidden', () => {
      const graph = build();

      expect(graph.nodes.filter((node) => node.kind === 'person').map((node) => node.label)).toEqual(['آرش', 'بهار']);
      expect(graph.hidden).toEqual([]);
   });

   test('takes a hidden person off the graph together with the work hanging from them', () => {
      const graph = build(new Set(['user-a']));

      expect(graph.nodes.filter((node) => node.kind === 'person').map((node) => node.label)).toEqual(['بهار']);
      expect(graph.nodes.filter((node) => node.kind === 'task').map((node) => node.label)).toEqual(['task-b1']);
      // Nothing may be left pointing at a node that is no longer drawn.
      const drawn = new Set(graph.nodes.map((node) => node.id));
      for (const link of graph.links) {
         expect(drawn.has(String(link.source))).toBe(true);
         expect(drawn.has(String(link.target))).toBe(true);
      }
   });

   test('reports the hidden person, and how much work went with them, so they can be brought back', () => {
      expect(build(new Set(['user-a'])).hidden).toEqual([
         { userId: 'user-a', name: 'آرش', avatarUrl: null, agent: false, taskCount: 2 },
      ]);
   });

   test('ignores an id for someone who had no seat anyway, such as an idle guest or a former member', () => {
      const graph = build(new Set(['user-guest', 'user-gone']));

      expect(graph.hidden).toEqual([]);
      expect(graph.nodes.filter((node) => node.kind === 'person')).toHaveLength(2);
   });

   test('keeps the workspace itself, even with the whole team hidden', () => {
      const graph = build(new Set(['user-a', 'user-b']));

      expect(graph.nodes.map((node) => node.kind)).toEqual(['workspace']);
      expect(graph.links).toEqual([]);
      expect(graph.hidden.map((person) => person.name)).toEqual(['آرش', 'بهار']);
   });
});
