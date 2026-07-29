import { describe, expect, test } from 'bun:test';
import type { GraphNode } from './graph-model';
import { diffNodeEntrances } from './use-node-entrances';

function node(id: string, kind: GraphNode['kind'] = 'task'): GraphNode {
   const base = { id, kind, label: id, radius: 6 };
   if (kind === 'task') {
      return { ...base, kind, taskId: id, taskKey: id, status: 'TODO', weight: null, overdue: false, assigneeId: 'u' } as GraphNode;
   }
   if (kind === 'person') {
      return { ...base, kind, userId: id, role: 'MEMBER', taskCount: 0, totalWeight: 0 } as GraphNode;
   }
   return { ...base, kind: 'workspace' } as GraphNode;
}

describe('diffNodeEntrances', () => {
   test('treats the first graph as already seen, so a page load stays silent', () => {
      const { entered, seen } = diffNodeEntrances(null, [node('a'), node('b')]);

      expect(entered).toEqual([]);
      expect([...seen].sort()).toEqual(['a', 'b']);
   });

   test('reports only ids that were not on the previous graph', () => {
      const first = diffNodeEntrances(null, [node('a')]);
      const second = diffNodeEntrances(first.seen, [node('a'), node('b'), node('c')]);

      expect(second.entered).toEqual(['b', 'c']);
   });

   test('does not re-announce a node that stays put', () => {
      const first = diffNodeEntrances(null, [node('a')]);
      const second = diffNodeEntrances(first.seen, [node('a'), node('b')]);
      const third = diffNodeEntrances(second.seen, [node('a'), node('b')]);

      expect(third.entered).toEqual([]);
   });

   test('announces a node that left and came back, such as work reopened after completion', () => {
      const first = diffNodeEntrances(null, [node('a'), node('b')]);
      const removed = diffNodeEntrances(first.seen, [node('a')]);
      const restored = diffNodeEntrances(removed.seen, [node('a'), node('b')]);

      expect(removed.entered).toEqual([]);
      expect(restored.entered).toEqual(['b']);
   });

   test('preserves graph order so the arrival stagger follows the layout', () => {
      const first = diffNodeEntrances(null, []);
      const { entered } = diffNodeEntrances(first.seen, [node('z'), node('y'), node('x')]);

      expect(entered).toEqual(['z', 'y', 'x']);
   });
});
