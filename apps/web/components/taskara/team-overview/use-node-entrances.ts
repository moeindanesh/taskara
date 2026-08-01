'use client';

import { useEffect, useRef, useState } from 'react';
import { isTaskArrivalSoundSuppressed, playTaskArrival } from '@/lib/ui-sound';
import type { GraphNode, TeamOverviewGraph } from './graph-model';

/** How long a node stays in its entrance animation; must match the keyframes in styles.css. */
export const entranceDurationMs = 900;
/** Beyond this many at once the stagger stops reading as an arpeggio and starts sounding like noise. */
const maxAnnouncedArrivals = 5;

export interface NodeEntranceDiff {
   entered: string[];
   seen: Set<string>;
}

/**
 * Which nodes are new since the last graph.
 *
 * A null `previous` means this is the first graph we have seen: everything is seeded as already
 * known so a page load does not fire an animation and a fanfare for the whole workspace.
 */
export function diffNodeEntrances(previous: Set<string> | null, nodes: GraphNode[]): NodeEntranceDiff {
   const seen = new Set(nodes.map((node) => node.id));
   if (!previous) return { entered: [], seen };
   return { entered: nodes.filter((node) => !previous.has(node.id)).map((node) => node.id), seen };
}

/**
 * Which of the arriving nodes are worth a chime.
 *
 * Agent work still animates in — it is real work and the graph should show it arriving. It is only
 * left out of the announcement: the chime budget is capped, and an agent working through a queue
 * would spend every slot a human arrival should have had, on every open tab.
 */
export function announcedArrivals(entered: string[], nodes: GraphNode[]): string[] {
   const byId = new Map(nodes.map((node) => [node.id, node]));
   return entered.filter((id) => {
      const node = byId.get(id);
      return node?.kind === 'task' && !node.agent;
   });
}

export interface NodeEntrances {
   /** Node id to its position in the arrival burst, used to stagger the animation. */
   entering: Map<string, number>;
   isAnimated: boolean;
}

function prefersReducedMotion(): boolean {
   if (typeof window === 'undefined' || !window.matchMedia) return false;
   return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Announces work arriving on the graph: tasks created by anyone, in this tab or another, pop in and
 * chime. People and the workspace enter quietly — a colleague joining is not an event you need to
 * hear about mid-flow.
 */
export function useNodeEntrances(graph: TeamOverviewGraph): NodeEntrances {
   const seenRef = useRef<Set<string> | null>(null);
   const timersRef = useRef<number[]>([]);
   const [entering, setEntering] = useState<Map<string, number>>(new Map());
   const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

   useEffect(() => {
      const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
      if (!query) return;
      const update = () => setReducedMotion(query.matches);
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
   }, []);

   useEffect(() => {
      const { entered, seen } = diffNodeEntrances(seenRef.current, graph.nodes);
      seenRef.current = seen;
      if (!entered.length) return;

      const arrivedTasks = announcedArrivals(entered, graph.nodes);

      // The composer already announced anything this tab just created.
      if (!isTaskArrivalSoundSuppressed()) {
         arrivedTasks.slice(0, maxAnnouncedArrivals).forEach((_, index) => playTaskArrival(index));
      }

      if (reducedMotion) return;

      setEntering((current) => {
         const next = new Map(current);
         entered.forEach((id, index) => next.set(id, index));
         return next;
      });

      const timer = window.setTimeout(() => {
         setEntering((current) => {
            const next = new Map(current);
            for (const id of entered) next.delete(id);
            return next;
         });
      }, entranceDurationMs + Math.min(entered.length, maxAnnouncedArrivals) * 75);
      timersRef.current.push(timer);
   }, [graph, reducedMotion]);

   useEffect(
      () => () => {
         for (const timer of timersRef.current) window.clearTimeout(timer);
         timersRef.current = [];
      },
      []
   );

   return { entering, isAnimated: !reducedMotion };
}
