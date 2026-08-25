'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
   type Simulation,
   forceCollide,
   forceLink,
   forceManyBody,
   forceRadial,
   forceSimulation,
   forceX,
   forceY,
} from 'd3-force';
import type { GraphLink, GraphNode, TeamOverviewGraph } from './graph-model';
import { layoutSignature, linkEndId, workspaceNodeId } from './graph-model';

// Simulation coordinates are centred on the origin; the canvas translates them into view space.
const membershipDistance = 175;
const assignmentDistance = 52;
const personOrbitRadius = 190;

/**
 * Runs the force layout over the current graph.
 *
 * Nodes are matched by id across rebuilds so a sync update — a task finishing, someone else's
 * work arriving — nudges the layout instead of scattering it. New nodes spawn on their parent so
 * they visibly bud off the person who owns them. An update the layout cannot see does not nudge it
 * at all: a settled graph stays exactly where the reader left it.
 */
export function useForceSimulation(graph: TeamOverviewGraph, onSettle?: () => void) {
   const settleRef = useRef(onSettle);
   settleRef.current = onSettle;

   const simulationRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
   const nodesRef = useRef<GraphNode[]>([]);
   const linksRef = useRef<GraphLink[]>([]);
   const signatureRef = useRef<string | null>(null);
   const [, setFrame] = useState(0);

   useEffect(() => {
      const signature = layoutSignature(graph);
      const layoutChanged = signature !== signatureRef.current;
      signatureRef.current = signature;

      const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
      const parentById = new Map<string, string>();
      for (const link of graph.links) parentById.set(linkEndId(link.target), linkEndId(link.source));

      const placed = new Map<string, GraphNode>();
      const nodes = graph.nodes.map((node, index) => {
         const prior = previous.get(node.id);
         if (prior) {
            Object.assign(node, { x: prior.x, y: prior.y, vx: prior.vx, vy: prior.vy, fx: prior.fx, fy: prior.fy });
         } else if (node.id === workspaceNodeId) {
            Object.assign(node, { x: 0, y: 0 });
         } else {
            const parent = placed.get(parentById.get(node.id) ?? '');
            const angle = index * 2.39996; // golden angle keeps fresh siblings from stacking up
            const spread = node.kind === 'person' ? personOrbitRadius : assignmentDistance;
            Object.assign(node, {
               x: (parent?.x ?? 0) + Math.cos(angle) * spread,
               y: (parent?.y ?? 0) + Math.sin(angle) * spread,
            });
         }

         if (node.id === workspaceNodeId) Object.assign(node, { fx: 0, fy: 0 });
         placed.set(node.id, node);
         return node;
      });

      // d3 rewrites link endpoints into node references, so hand it copies and keep ours by id.
      const links = graph.links.map((link) => ({ ...link }));
      nodesRef.current = nodes;
      linksRef.current = links;

      const simulation =
         simulationRef.current ??
         forceSimulation<GraphNode, GraphLink>()
            .force('charge', forceManyBody<GraphNode>().strength((node) => (node.kind === 'task' ? -70 : -260)))
            .force(
               'collide',
               forceCollide<GraphNode>()
                  .radius((node) => node.radius + (node.kind === 'task' ? 5 : 12))
                  .strength(0.85)
            )
            .force(
               'orbit',
               forceRadial<GraphNode>(personOrbitRadius, 0, 0).strength((node) => (node.kind === 'person' ? 0.28 : 0))
            )
            .force('x', forceX<GraphNode>(0).strength(0.012))
            .force('y', forceY<GraphNode>(0).strength(0.012));

      simulation.nodes(nodes).force(
         'link',
         forceLink<GraphNode, GraphLink>(links)
            .id((node) => node.id)
            .distance((link) => (link.kind === 'membership' ? membershipDistance : assignmentDistance))
            .strength((link) => (link.kind === 'membership' ? 0.35 : 0.9))
      );

      // Handing d3 the rebuilt nodes costs nothing and moves nothing; reheating is what moves
      // things, so it is spent only on a graph the layout would actually place differently. The
      // frame bump is what a skipped reheat owes the canvas: the nodes it is drawing were just
      // swapped for new objects carrying the new status, weight and titles.
      if (layoutChanged) simulation.alpha(simulationRef.current ? 0.55 : 1).restart();
      else setFrame((frame) => frame + 1);

      if (!simulationRef.current) {
         simulation.on('tick', () => setFrame((frame) => frame + 1));
         simulation.on('end', () => settleRef.current?.());
         simulationRef.current = simulation;
      }
   }, [graph]);

   useEffect(() => {
      // A settling graph in a hidden tab is pure battery burn.
      function handleVisibilityChange() {
         const simulation = simulationRef.current;
         if (!simulation) return;
         if (document.hidden) simulation.stop();
         else if (simulation.alpha() > simulation.alphaMin()) simulation.restart();
      }

      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
   }, []);

   useEffect(
      () => () => {
         // Everything the layout remembers goes with the simulation it belongs to. Leaving the
         // signature behind would tell a remount that the graph it is holding has already been laid
         // out, and it would sit on a stopped simulation forever — which is exactly what a
         // StrictMode double mount does in development.
         simulationRef.current?.stop();
         simulationRef.current = null;
         signatureRef.current = null;
      },
      []
   );

   // Pinning where the node already sits moves nothing. The layout is deliberately left cold until
   // the first actual move, because most presses on a node are a click that opens it, and those
   // have no business stirring the graph.
   const startDrag = useCallback((node: GraphNode) => {
      node.fx = node.x;
      node.fy = node.y;
   }, []);

   const moveDrag = useCallback((node: GraphNode, x: number, y: number) => {
      const simulation = simulationRef.current;
      if (simulation && simulation.alphaTarget() === 0) simulation.alphaTarget(0.3).restart();
      node.fx = x;
      node.fy = y;
      setFrame((frame) => frame + 1);
   }, []);

   const endDrag = useCallback((node: GraphNode) => {
      simulationRef.current?.alphaTarget(0);
      // The workspace stays pinned at the centre; everything else falls back under the forces.
      if (node.id !== workspaceNodeId) {
         node.fx = null;
         node.fy = null;
      }
   }, []);

   return { nodes: nodesRef.current, links: linksRef.current, startDrag, moveDrag, endDrag };
}
