import { describe, expect, test } from 'bun:test';
import type { GraphLink, GraphNode, TeamOverviewGraph } from './graph-model';
import { layoutSignature, personNodeId, taskNodeId, workspaceNodeId } from './graph-model';

function person(userId: string): GraphNode {
   return {
      id: personNodeId(userId),
      kind: 'person',
      label: userId,
      radius: 19,
      userId,
      avatarUrl: null,
      role: 'MEMBER',
      agent: false,
      taskCount: 1,
      totalWeight: 1,
   };
}

function task(taskId: string, overrides: Partial<Extract<GraphNode, { kind: 'task' }>> = {}): GraphNode {
   return {
      id: taskNodeId(taskId),
      kind: 'task',
      label: taskId,
      radius: 5.5,
      taskId,
      taskKey: `CORE-${taskId}`,
      status: 'TODO',
      weight: null,
      overdue: false,
      dueAt: null,
      assigneeId: 'u1',
      agent: false,
      ...overrides,
   };
}

function graph(nodes: GraphNode[], links: GraphLink[] = []): TeamOverviewGraph {
   return { nodes, links };
}

const workspace: GraphNode = { id: workspaceNodeId, kind: 'workspace', label: 'Avantech', radius: 30 };

const membership: GraphLink = {
   id: 'membership:u1',
   source: workspaceNodeId,
   target: personNodeId('u1'),
   kind: 'membership',
};

const assignment: GraphLink = {
   id: 'assignment:t1',
   source: personNodeId('u1'),
   target: taskNodeId('t1'),
   kind: 'assignment',
};

describe('layoutSignature', () => {
   test('is unchanged by a rebuild that says nothing new, which is what a poll hands back', () => {
      const build = () => graph([workspace, person('u1'), task('t1')], [membership, assignment]);

      expect(layoutSignature(build())).toBe(layoutSignature(build()));
   });

   test('ignores what a node looks like, because colour and lateness do not move anything', () => {
      const before = graph([task('t1')]);
      const after = graph([task('t1', { status: 'DONE', overdue: true, label: 'renamed' })]);

      expect(layoutSignature(after)).toBe(layoutSignature(before));
   });

   test('changes when work arrives', () => {
      const before = graph([workspace, person('u1')], [membership]);
      const after = graph([workspace, person('u1'), task('t1')], [membership, assignment]);

      expect(layoutSignature(after)).not.toBe(layoutSignature(before));
   });

   test('changes when work leaves', () => {
      const before = graph([workspace, person('u1'), task('t1')], [membership, assignment]);
      const after = graph([workspace, person('u1')], [membership]);

      expect(layoutSignature(after)).not.toBe(layoutSignature(before));
   });

   test('changes when a task is re-estimated, since size is what the collision force sees', () => {
      const before = graph([task('t1', { radius: 5.5, weight: 1 })]);
      const after = graph([task('t1', { radius: 15.5, weight: 8 })]);

      expect(layoutSignature(after)).not.toBe(layoutSignature(before));
   });

   test('changes when work moves to someone else, which re-hangs it on the graph', () => {
      const before = graph([person('u1'), person('u2'), task('t1')], [assignment]);
      const after = graph(
         [person('u1'), person('u2'), task('t1')],
         [{ ...assignment, source: personNodeId('u2') }]
      );

      expect(layoutSignature(after)).not.toBe(layoutSignature(before));
   });

   test('survives a reorder, because a rename re-sorts people without moving any of them', () => {
      const before = graph([person('u1'), person('u2')]);
      const after = graph([person('u2'), person('u1')]);

      expect(layoutSignature(after)).toBe(layoutSignature(before));
   });

   test('reads link ends the same whether or not d3 has rewritten them into node references', () => {
      const asIds = graph([person('u1'), task('t1')], [assignment]);
      const asReferences = graph(
         [person('u1'), task('t1')],
         [{ ...assignment, source: person('u1'), target: task('t1') }]
      );

      expect(layoutSignature(asReferences)).toBe(layoutSignature(asIds));
   });
});
