'use client';

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { EyeOff } from 'lucide-react';
import { linearStatusMeta } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';
import type { GraphNode, PersonGraphNode, TaskGraphNode, WorkspaceGraphNode } from './graph-model';

export interface GraphNodeShapeProps {
   node: GraphNode;
   dimmed: boolean;
   /** Position in an arrival burst, or undefined when the node was already on the graph. */
   entering?: number;
   hovered: boolean;
   pressed: boolean;
   selected: boolean;
   /** Task titles are noise at a distance, so they appear on hover or once the view is zoomed in. */
   showTaskLabel: boolean;
   onActivate: (node: GraphNode) => void;
   onHide: (node: PersonGraphNode) => void;
   onHover: (node: GraphNode | null) => void;
   onPointerDown: (node: GraphNode, event: ReactPointerEvent<SVGGElement>) => void;
}

function truncate(value: string, max: number): string {
   return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function initials(name: string): string {
   const parts = name.trim().split(/\s+/).slice(0, 2);
   return parts.map((part) => Array.from(part)[0] ?? '').join('');
}

/** The colour a node paints with, as a Tailwind text class consumed through currentColor. */
function nodeColorClassName(node: GraphNode): string {
   if (node.kind === 'task') return (linearStatusMeta[node.status] || linearStatusMeta.TODO).iconClassName;
   return 'text-primary';
}

function WorkspaceShape({ node }: { node: WorkspaceGraphNode }) {
   return (
      <>
         <circle className="team-overview-aura pointer-events-none fill-primary/10" r={node.radius * 1.7} />
         <circle className="fill-primary/12 stroke-primary/50" r={node.radius} strokeWidth={1.5} />
         <circle className="fill-primary/70" r={node.radius * 0.34} />
      </>
   );
}

function PersonShape({ node }: { node: PersonGraphNode }) {
   const clipId = `team-overview-avatar-${node.userId}`;

   return (
      <>
         <circle className="fill-container stroke-border" r={node.radius} strokeWidth={1.5} />
         {node.avatarUrl ? (
            <>
               <clipPath id={clipId}>
                  <circle r={node.radius - 2} />
               </clipPath>
               <image
                  clipPath={`url(#${clipId})`}
                  height={(node.radius - 2) * 2}
                  href={node.avatarUrl}
                  preserveAspectRatio="xMidYMid slice"
                  width={(node.radius - 2) * 2}
                  x={-(node.radius - 2)}
                  y={-(node.radius - 2)}
               />
            </>
         ) : (
            <text
               className="fill-muted-foreground pointer-events-none text-[12px] font-medium"
               dominantBaseline="central"
               textAnchor="middle"
            >
               {initials(node.label)}
            </text>
         )}
      </>
   );
}

/**
 * The badge that takes someone off the graph, revealed on hover over their node.
 *
 * It sits inside the person's group, so reaching for it never counts as leaving the node, and it
 * swallows both the press and the click: the gesture that hides someone must not also drag them or
 * open their sheet. Mirrored to the top-start corner, which in this RTL app is the right.
 */
function HidePersonBadge({ node, onHide }: { node: PersonGraphNode; onHide: (node: PersonGraphNode) => void }) {
   const label = fa.teamOverview.hidePerson(node.label);
   const offset = node.radius * 0.86;

   return (
      <g
         aria-label={label}
         className="cursor-pointer"
         data-testid="hide-person"
         onClick={(event: ReactMouseEvent<SVGGElement>) => {
            event.stopPropagation();
            onHide(node);
         }}
         onPointerDown={(event: ReactPointerEvent<SVGGElement>) => event.stopPropagation()}
         role="button"
         transform={`translate(${offset}, ${-offset})`}
      >
         <title>{label}</title>
         <g className="team-overview-hide">
            <circle
               className="fill-[#141417] stroke-white/20 transition-colors hover:fill-[#26262b]"
               r={9}
               strokeWidth={1}
            />
            <EyeOff
               className="pointer-events-none text-zinc-300"
               height={10}
               strokeWidth={2.25}
               width={10}
               x={-5}
               y={-5}
            />
         </g>
      </g>
   );
}

function TaskShape({ node }: { node: TaskGraphNode }) {
   const meta = linearStatusMeta[node.status] || linearStatusMeta.TODO;
   const unestimated = node.weight === null;

   return (
      <>
         {node.overdue ? (
            <circle className="fill-none stroke-red-500/70" r={node.radius + 4} strokeWidth={1.5} />
         ) : null}
         <circle
            // The status colour comes from the same map the task lists use, painted via currentColor.
            className={cn(meta.iconClassName, unestimated ? 'fill-none stroke-current' : 'fill-current')}
            r={node.radius}
            strokeDasharray={unestimated ? '3 2.5' : undefined}
            strokeWidth={unestimated ? 1.75 : undefined}
         />
      </>
   );
}

export function GraphNodeShape({
   node,
   dimmed,
   entering,
   hovered,
   pressed,
   selected,
   showTaskLabel,
   onActivate,
   onHide,
   onHover,
   onPointerDown,
}: GraphNodeShapeProps) {
   const isTask = node.kind === 'task';
   const isWorkspace = node.kind === 'workspace';
   const colorClassName = nodeColorClassName(node);
   const arriving = entering !== undefined;
   const animationDelay = arriving ? `${Math.min(entering, 6) * 70}ms` : undefined;
   const scale = pressed ? 0.9 : hovered && !isWorkspace ? 1.16 : 1;
   const labelOffset = node.radius + (isTask ? 11 : isWorkspace ? 18 : 15);

   return (
      <g
         className={cn(
            'transition-opacity duration-150',
            dimmed ? 'opacity-20' : 'opacity-100',
            isWorkspace ? 'cursor-default' : 'cursor-pointer'
         )}
         data-entering={arriving ? 'true' : undefined}
         data-node-id={node.id}
         data-node-kind={node.kind}
         data-node-label={node.label}
         data-overdue={isTask && node.overdue ? 'true' : undefined}
         data-status={isTask ? node.status : undefined}
         onClick={() => onActivate(node)}
         onPointerDown={(event) => onPointerDown(node, event)}
         onPointerEnter={() => onHover(node)}
         onPointerLeave={() => onHover(null)}
         transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
      >
         <g className={cn(arriving && 'team-overview-pop')} style={arriving ? { animationDelay } : undefined}>
            {/* The shockwave marks where new work landed, then gets out of the way. */}
            {arriving ? (
               <circle
                  className={cn('team-overview-shockwave pointer-events-none fill-none stroke-current', colorClassName)}
                  r={node.radius}
                  strokeWidth={2}
                  style={{ animationDelay }}
               />
            ) : null}

            {/* A generous invisible target keeps small task nodes clickable. */}
            <circle className="fill-transparent" r={Math.max(node.radius + 6, 12)} />

            <g className="team-overview-node" style={{ transform: `scale(${scale})` }}>
               {hovered && !isWorkspace ? (
                  <circle
                     className={cn('pointer-events-none fill-current opacity-15', colorClassName)}
                     r={node.radius * 2}
                  />
               ) : null}
               {selected ? (
                  <circle className="pointer-events-none fill-none stroke-primary" r={node.radius + 6} strokeWidth={2} />
               ) : null}
               {isWorkspace ? <WorkspaceShape node={node} /> : null}
               {node.kind === 'person' ? <PersonShape node={node} /> : null}
               {isTask ? <TaskShape node={node} /> : null}
            </g>

            {/* Outside the scaled group: the target a pointer is travelling towards should not
                move or resize under it. */}
            {node.kind === 'person' && hovered ? <HidePersonBadge node={node} onHide={onHide} /> : null}

            {!isTask ? (
               <text
                  className={cn(
                     'fill-foreground pointer-events-none',
                     isWorkspace ? 'text-[13px] font-medium' : 'text-[11px]'
                  )}
                  textAnchor="middle"
                  y={labelOffset}
               >
                  {truncate(node.label, isWorkspace ? 24 : 18)}
               </text>
            ) : null}

            {isTask && showTaskLabel ? (
               <text
                  className="fill-muted-foreground pointer-events-none text-[9px]"
                  textAnchor="middle"
                  y={labelOffset}
               >
                  {truncate(node.label, 26)}
               </text>
            ) : null}
         </g>
      </g>
   );
}
