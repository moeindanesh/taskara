'use client';

import type { PointerEvent as ReactPointerEvent } from 'react';
import { linearStatusMeta } from '@/components/taskara/linear-ui';
import { cn } from '@/lib/utils';
import type { GraphNode, PersonGraphNode, TaskGraphNode, WorkspaceGraphNode } from './graph-model';

export interface GraphNodeShapeProps {
   node: GraphNode;
   dimmed: boolean;
   /** Task titles are noise at a distance, so they appear on hover or once the view is zoomed in. */
   showTaskLabel: boolean;
   onActivate: (node: GraphNode) => void;
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

function WorkspaceShape({ node }: { node: WorkspaceGraphNode }) {
   return (
      <>
         <circle className="fill-primary/12 stroke-primary/50" r={node.radius} strokeWidth={1.5} />
         <circle className="fill-primary/70" r={node.radius * 0.34} />
         <text
            className="fill-foreground pointer-events-none text-[13px] font-medium"
            textAnchor="middle"
            y={node.radius + 18}
         >
            {truncate(node.label, 24)}
         </text>
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
         <text
            className="fill-foreground pointer-events-none text-[11px]"
            textAnchor="middle"
            y={node.radius + 15}
         >
            {truncate(node.label, 18)}
         </text>
      </>
   );
}

function TaskShape({ node, showLabel }: { node: TaskGraphNode; showLabel: boolean }) {
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
         {showLabel ? (
            <text
               className="fill-muted-foreground pointer-events-none text-[9px]"
               textAnchor="middle"
               y={node.radius + 11}
            >
               {truncate(node.label, 26)}
            </text>
         ) : null}
      </>
   );
}

export function GraphNodeShape({
   node,
   dimmed,
   showTaskLabel,
   onActivate,
   onHover,
   onPointerDown,
}: GraphNodeShapeProps) {
   const isTask = node.kind === 'task';

   return (
      <g
         className={cn(
            'cursor-pointer transition-opacity duration-150',
            dimmed ? 'opacity-20' : 'opacity-100',
            node.kind === 'workspace' && 'cursor-default'
         )}
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
         {/* A generous invisible target keeps small task nodes clickable. */}
         <circle className="fill-transparent" r={Math.max(node.radius + 6, 12)} />
         {node.kind === 'workspace' ? <WorkspaceShape node={node} /> : null}
         {node.kind === 'person' ? <PersonShape node={node} /> : null}
         {isTask ? <TaskShape node={node} showLabel={showTaskLabel} /> : null}
      </g>
   );
}
