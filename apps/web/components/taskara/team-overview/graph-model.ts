// The shape of the Team Overview graph: one workspace at the centre, a person per member, and each
// person's Today Load hanging off them. Kept free of React and d3 so the layout rules stay testable.

import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';

export type GraphNodeKind = 'workspace' | 'person' | 'task';

interface GraphNodeBase extends SimulationNodeDatum {
   /** Stable across rebuilds so the simulation keeps a node's position when data changes. */
   id: string;
   kind: GraphNodeKind;
   label: string;
   radius: number;
}

export interface WorkspaceGraphNode extends GraphNodeBase {
   kind: 'workspace';
}

export interface PersonGraphNode extends GraphNodeBase {
   kind: 'person';
   userId: string;
   avatarUrl?: string | null;
   role: string;
   /** An agent teammate. Rendered like anyone else, but never announced or counted as a person. */
   agent: boolean;
   /** Today Load task count, for the person's tooltip. */
   taskCount: number;
   /** Summed weight of that load; unweighted tasks count as zero. */
   totalWeight: number;
}

export interface TaskGraphNode extends GraphNodeBase {
   kind: 'task';
   taskId: string;
   taskKey: string;
   status: string;
   /** Null means nobody estimated it — rendered smallest, with a dashed outline. */
   weight: number | null;
   overdue: boolean;
   dueAt?: string | null;
   assigneeId: string;
   /** Whether the assignee is an agent, so agent work can animate in without chiming. */
   agent: boolean;
}

export type GraphNode = WorkspaceGraphNode | PersonGraphNode | TaskGraphNode;

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
   id: string;
   source: string | GraphNode;
   target: string | GraphNode;
   kind: 'membership' | 'assignment';
}

export interface TeamOverviewGraph {
   nodes: GraphNode[];
   links: GraphLink[];
}

/** d3 rewrites link endpoints from ids into node references once the simulation runs. */
export function linkEndId(end: GraphLink['source']): string {
   return typeof end === 'string' ? end : end.id;
}

/**
 * Everything the force layout can see, and nothing else.
 *
 * A graph is rebuilt from scratch on every sync update, and most of those say nothing new: the
 * 45-second safety-net poll hands back the same workspace with fresh object identities. Re-running
 * the layout for one of those is what walks a settled graph across the canvas, so the simulation
 * compares this instead of the object it was handed. Sorted, because a rename can reorder people
 * without moving anything, and status, overdueness and labels are absent, because they change what
 * a node looks like rather than where it belongs.
 */
export function layoutSignature(graph: TeamOverviewGraph): string {
   const nodes = graph.nodes.map((node) => `${node.id}@${node.radius}`).sort();
   const links = graph.links.map((link) => `${linkEndId(link.source)}>${linkEndId(link.target)}`).sort();
   return `${nodes.join(',')}|${links.join(',')}`;
}

export const workspaceNodeId = 'workspace';
export const personNodeId = (userId: string) => `user:${userId}`;
export const taskNodeId = (taskId: string) => `task:${taskId}`;

export const workspaceNodeRadius = 30;
export const personNodeRadius = 19;

/** The legal weights (packages/shared taskWeights); anything else is clamped into this span. */
const minWeight = 1;
const maxWeight = 8;
const taskRadiusUnit = 5.5;

/**
 * Area tracks weight, so a weight-8 task looks eight times the work of a weight-1 one rather than
 * eight times as wide. Unestimated tasks take the smallest radius and earn a dashed outline instead.
 */
export function taskNodeRadius(weight: number | null | undefined): number {
   if (weight === null || weight === undefined || !Number.isFinite(weight) || weight <= 0) {
      return taskRadiusUnit;
   }
   return taskRadiusUnit * Math.sqrt(Math.min(Math.max(weight, minWeight), maxWeight));
}
