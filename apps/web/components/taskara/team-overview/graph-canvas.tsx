'use client';

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { GraphNodeShape } from './graph-nodes';
import { type GraphNode, type TeamOverviewGraph, linkEndId } from './graph-model';
import { useForceSimulation } from './use-force-simulation';
import { useNodeEntrances } from './use-node-entrances';

const minZoom = 0.35;
const maxZoom = 3;
/** A small team should be centred and readable, not blown up to fill the screen. */
const fitMaxZoom = 1.15;
/** Below this the graph reads as shape and colour; above it there is room for task titles. */
const taskLabelZoom = 1.3;

interface ViewTransform {
   x: number;
   y: number;
   k: number;
}

interface DragState {
   pointerId: number;
   node?: GraphNode;
   originX: number;
   originY: number;
   startX: number;
   startY: number;
   moved: boolean;
}

export interface GraphCanvasProps {
   graph: TeamOverviewGraph;
   /** Node currently held open elsewhere, drawn with a persistent ring. */
   selectedNodeId?: string | null;
   onSelectNode: (node: GraphNode) => void;
}

export function GraphCanvas({ graph, selectedNodeId, onSelectNode }: GraphCanvasProps) {
   const containerRef = useRef<HTMLDivElement | null>(null);
   const svgRef = useRef<SVGSVGElement | null>(null);
   const dragRef = useRef<DragState | null>(null);
   // Survives past pointerup so the click that follows a drag can be told apart from a real click.
   const dragMovedRef = useRef(false);
   const [size, setSize] = useState({ width: 0, height: 0 });
   const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
   const [hovered, setHovered] = useState<string | null>(null);
   const [pressed, setPressed] = useState<string | null>(null);
   const nodesRef = useRef<GraphNode[]>([]);
   const sizeRef = useRef(size);
   sizeRef.current = size;
   const fittedRef = useRef(false);

   /** Frames the whole team once the first layout settles, so the graph fills the canvas it is given. */
   const fitToContent = useCallback(() => {
      const nodes = nodesRef.current;
      const { height, width } = sizeRef.current;
      if (!nodes.length || !width || !height) return;

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
         minX = Math.min(minX, (node.x ?? 0) - node.radius);
         maxX = Math.max(maxX, (node.x ?? 0) + node.radius);
         minY = Math.min(minY, (node.y ?? 0) - node.radius);
         maxY = Math.max(maxY, (node.y ?? 0) + node.radius);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

      const padding = 72;
      const k = Math.min(
         fitMaxZoom,
         Math.max(minZoom, Math.min((width - padding) / (maxX - minX || 1), (height - padding) / (maxY - minY || 1)))
      );
      setView({
         k,
         x: width / 2 - ((minX + maxX) / 2) * k,
         y: height / 2 - ((minY + maxY) / 2) * k,
      });
   }, []);

   const handleSettle = useCallback(() => {
      // Only the first settle reframes; later ones follow a drag or a sync update, where yanking the
      // viewport out from under the reader would be hostile.
      if (fittedRef.current) return;
      fittedRef.current = true;
      fitToContent();
   }, [fitToContent]);

   const { nodes, links, startDrag, moveDrag, endDrag } = useForceSimulation(graph, handleSettle);
   nodesRef.current = nodes;

   useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const observer = new ResizeObserver(([entry]) => {
         const { height, width } = entry.contentRect;
         setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
      });
      observer.observe(container);
      return () => observer.disconnect();
   }, []);

   // The simulation is centred on the origin, so the view starts by putting the origin mid-canvas.
   // Once the first layout settles, fitToContent reframes around whatever the team actually looks like.
   const centredRef = useRef(false);
   useEffect(() => {
      if (centredRef.current || !size.width || !size.height) return;
      centredRef.current = true;
      setView({ x: size.width / 2, y: size.height / 2, k: 1 });
   }, [size]);

   useEffect(() => {
      const svg = svgRef.current;
      if (!svg) return;

      function handleWheel(event: WheelEvent) {
         event.preventDefault();
         const rect = svg!.getBoundingClientRect();
         const pointerX = event.clientX - rect.left;
         const pointerY = event.clientY - rect.top;

         setView((current) => {
            const scale = Math.exp(-event.deltaY * 0.0015);
            const k = Math.min(maxZoom, Math.max(minZoom, current.k * scale));
            if (k === current.k) return current;
            // Keep whatever sits under the cursor pinned there while the scale changes.
            const ratio = k / current.k;
            return { k, x: pointerX - (pointerX - current.x) * ratio, y: pointerY - (pointerY - current.y) * ratio };
         });
      }

      svg.addEventListener('wheel', handleWheel, { passive: false });
      return () => svg.removeEventListener('wheel', handleWheel);
   }, []);

   const beginDrag = useCallback(
      (node: GraphNode | undefined, event: ReactPointerEvent<SVGElement>) => {
         if (event.button !== 0) return;
         event.currentTarget.setPointerCapture?.(event.pointerId);
         dragMovedRef.current = false;
         if (node) {
            startDrag(node);
            setPressed(node.id);
         }
         dragRef.current = {
            pointerId: event.pointerId,
            node,
            originX: node ? node.x ?? 0 : view.x,
            originY: node ? node.y ?? 0 : view.y,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
         };
      },
      [startDrag, view.x, view.y]
   );

   const handlePointerMove = useCallback(
      (event: ReactPointerEvent<SVGSVGElement>) => {
         const drag = dragRef.current;
         if (!drag || drag.pointerId !== event.pointerId) return;

         const dx = event.clientX - drag.startX;
         const dy = event.clientY - drag.startY;
         if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
         if (!drag.moved) return;

         if (drag.node) moveDrag(drag.node, drag.originX + dx / view.k, drag.originY + dy / view.k);
         else setView((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
      },
      [moveDrag, view.k]
   );

   const finishDrag = useCallback(
      (event: ReactPointerEvent<SVGSVGElement>) => {
         const drag = dragRef.current;
         if (!drag || drag.pointerId !== event.pointerId) return;
         if (drag.node) endDrag(drag.node);
         dragMovedRef.current = drag.moved;
         dragRef.current = null;
         setPressed(null);
      },
      [endDrag]
   );

   const handleActivate = useCallback(
      (node: GraphNode) => {
         // The click that follows a drag was a reposition, not a selection.
         if (dragMovedRef.current) {
            dragMovedRef.current = false;
            return;
         }
         onSelectNode(node);
      },
      [onSelectNode]
   );

   const neighbours = useMemo(() => {
      if (!hovered) return null;
      const connected = new Set<string>([hovered]);
      for (const link of links) {
         const source = linkEndId(link.source);
         const target = linkEndId(link.target);
         if (source === hovered) connected.add(target);
         else if (target === hovered) connected.add(source);
      }
      return connected;
   }, [hovered, links]);

   const showTaskLabels = view.k >= taskLabelZoom;
   const { entering } = useNodeEntrances(graph);

   return (
      <div className="relative h-full w-full overflow-hidden" ref={containerRef}>
         <svg
            className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
            onPointerCancel={finishDrag}
            onPointerDown={(event) => {
               if (event.target === event.currentTarget) beginDrag(undefined, event);
            }}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            ref={svgRef}
         >
            <g transform={`translate(${view.x}, ${view.y}) scale(${view.k})`}>
               <g className="stroke-border">
                  {links.map((link) => {
                     const source = typeof link.source === 'string' ? undefined : link.source;
                     const target = typeof link.target === 'string' ? undefined : link.target;
                     if (!source || !target) return null;
                     const faded = neighbours ? !neighbours.has(source.id) || !neighbours.has(target.id) : false;
                     // A link to arriving work draws itself outward, so the task reads as pulled
                     // out of the person rather than dropped next to them.
                     const arriving = entering.get(target.id);

                     return (
                        <line
                           className={cn(
                              'transition-opacity duration-150',
                              faded ? 'opacity-10' : 'opacity-60',
                              arriving !== undefined && 'team-overview-link-draw'
                           )}
                           key={link.id}
                           pathLength={1}
                           strokeWidth={link.kind === 'membership' ? 1.25 : 0.85}
                           style={
                              arriving !== undefined
                                 ? { animationDelay: `${Math.min(arriving, 6) * 70}ms` }
                                 : undefined
                           }
                           x1={source.x ?? 0}
                           x2={target.x ?? 0}
                           y1={source.y ?? 0}
                           y2={target.y ?? 0}
                        />
                     );
                  })}
               </g>
               {nodes.map((node) => (
                  <GraphNodeShape
                     dimmed={neighbours ? !neighbours.has(node.id) : false}
                     entering={entering.get(node.id)}
                     hovered={hovered === node.id}
                     key={node.id}
                     node={node}
                     onActivate={handleActivate}
                     onHover={(next) => setHovered(next?.id ?? null)}
                     onPointerDown={beginDrag}
                     pressed={pressed === node.id}
                     selected={selectedNodeId === node.id}
                     showTaskLabel={showTaskLabels || hovered === node.id}
                  />
               ))}
            </g>
         </svg>
      </div>
   );
}
