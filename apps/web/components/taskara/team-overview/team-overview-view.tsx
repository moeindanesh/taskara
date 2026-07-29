'use client';

import { useCallback, useMemo, useState } from 'react';
import { IssuePage } from '@/components/taskara/issue-page';
import { LinearEmptyState } from '@/components/taskara/linear-ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { fa } from '@/lib/fa-copy';
import { GraphCanvas } from './graph-canvas';
import type { GraphNode } from './graph-model';
import { endOfWorkspaceDay } from './today-load';
import { useTeamOverviewGraph } from './use-team-overview-graph';

export function TeamOverviewView() {
   const { day, error, hasBootstrapped, links, loading, nodes } = useTeamOverviewGraph();
   const [issueTaskKey, setIssueTaskKey] = useState<string | null>(null);

   const graph = useMemo(() => ({ links, nodes }), [links, nodes]);
   const taskCount = useMemo(() => nodes.filter((node) => node.kind === 'task').length, [nodes]);

   const handleSelectNode = useCallback(
      (node: GraphNode) => {
         if (node.kind === 'task') {
            setIssueTaskKey(node.taskKey);
            return;
         }

         if (node.kind === 'person') {
            // Dating it today means the new task joins this person's load on the graph immediately.
            window.dispatchEvent(
               new CustomEvent('taskara:create-issue', {
                  detail: { assigneeId: node.userId, dueAt: endOfWorkspaceDay(day).toISOString() },
               })
            );
         }
      },
      [day]
   );

   return (
      <div className="relative flex h-full min-h-0 w-full flex-col">
         {error ? (
            <div className="px-4 pt-3">
               <LinearEmptyState className="border-red-500/30 text-red-300">{error}</LinearEmptyState>
            </div>
         ) : null}

         <div className="relative min-h-0 flex-1">
            {hasBootstrapped ? <GraphCanvas graph={graph} onSelectNode={handleSelectNode} /> : null}

            {!hasBootstrapped && loading ? (
               <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                  {fa.teamOverview.loading}
               </div>
            ) : null}

            {hasBootstrapped && taskCount === 0 ? (
               <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center px-4">
                  <LinearEmptyState className="max-w-sm">{fa.teamOverview.emptyLoad}</LinearEmptyState>
               </div>
            ) : null}

            {hasBootstrapped ? (
               <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-[11px] text-zinc-600">
                  {fa.teamOverview.hint}
               </p>
            ) : null}
         </div>

         <Dialog open={Boolean(issueTaskKey)} onOpenChange={(open) => !open && setIssueTaskKey(null)}>
            <DialogContent
               className="h-[calc(100svh-2rem)] max-h-[920px] max-w-[1280px] gap-0 overflow-hidden rounded-2xl border-white/10 bg-[#101011] p-0 text-zinc-100 [direction:rtl]"
               showCloseButton={false}
            >
               <DialogTitle className="sr-only">جزئیات کار {issueTaskKey}</DialogTitle>
               <DialogDescription className="sr-only">مشاهده و ویرایش جزئیات کار</DialogDescription>
               {issueTaskKey ? <IssuePage taskKey={issueTaskKey} onClose={() => setIssueTaskKey(null)} /> : null}
            </DialogContent>
         </Dialog>
      </div>
   );
}
