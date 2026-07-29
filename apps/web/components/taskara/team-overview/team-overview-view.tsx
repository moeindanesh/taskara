'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { IssuePage } from '@/components/taskara/issue-page';
import { LinearEmptyState } from '@/components/taskara/linear-ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { fa } from '@/lib/fa-copy';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { isSoundEnabled, playNodeOpen, playSoundEnabled, setSoundEnabled } from '@/lib/ui-sound';
import { cn } from '@/lib/utils';
import { GraphCanvas } from './graph-canvas';
import { type GraphNode, type PersonGraphNode, personNodeId, taskNodeId } from './graph-model';
import { PersonSheet } from './person-sheet';
import { useTeamOverviewGraph } from './use-team-overview-graph';

/** The sync stream already pushes changes; this is the safety net for a dropped connection. */
const pollIntervalMs = 45_000;

export function TeamOverviewView() {
   const { day, error, hasBootstrapped, links, loading, nodes } = useTeamOverviewGraph();
   const { refresh } = useWorkspaceTaskSync();
   const [issueTaskKey, setIssueTaskKey] = useState<string | null>(null);
   const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
   const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
   const [soundOn, setSoundOn] = useState(false);

   useEffect(() => setSoundOn(isSoundEnabled()), []);

   // Work created by other people should land on the graph on its own, so an arrival is something
   // you watch happen rather than something you find after a reload.
   useEffect(() => {
      const tick = () => {
         if (document.hidden) return;
         void refresh({ preserveVisibleState: true });
      };
      const timer = window.setInterval(tick, pollIntervalMs);
      document.addEventListener('visibilitychange', tick);
      return () => {
         window.clearInterval(timer);
         document.removeEventListener('visibilitychange', tick);
      };
   }, [refresh]);

   const graph = useMemo(() => ({ links, nodes }), [links, nodes]);
   const taskCount = useMemo(() => nodes.filter((node) => node.kind === 'task').length, [nodes]);

   const closeIssue = useCallback(() => {
      setIssueTaskKey(null);
      setSelectedTaskId(null);
   }, []);

   const selectedPerson = useMemo(
      () =>
         (nodes.find((node) => node.kind === 'person' && node.userId === selectedPersonId) as
            | PersonGraphNode
            | undefined) ?? null,
      [nodes, selectedPersonId]
   );

   const handleSelectNode = useCallback((node: GraphNode) => {
      if (node.kind === 'task') {
         playNodeOpen();
         setSelectedTaskId(node.taskId);
         setIssueTaskKey(node.taskKey);
         return;
      }

      if (node.kind === 'person') {
         playNodeOpen();
         setSelectedPersonId(node.userId);
      }
   }, []);

   const toggleSound = useCallback(() => {
      setSoundOn((current) => {
         const next = !current;
         setSoundEnabled(next);
         if (next) playSoundEnabled();
         return next;
      });
   }, []);

   return (
      <div className="relative flex h-full min-h-0 w-full flex-col">
         {error ? (
            <div className="px-4 pt-3">
               <LinearEmptyState className="border-red-500/30 text-red-300">{error}</LinearEmptyState>
            </div>
         ) : null}

         <div className="relative min-h-0 flex-1">
            {hasBootstrapped ? (
               <GraphCanvas
                  graph={graph}
                  onSelectNode={handleSelectNode}
                  selectedNodeId={
                     selectedTaskId
                        ? taskNodeId(selectedTaskId)
                        : selectedPersonId
                          ? personNodeId(selectedPersonId)
                          : null
                  }
               />
            ) : null}

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
               <>
                  <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-[11px] text-zinc-600">
                     {fa.teamOverview.hint}
                  </p>
                  <button
                     aria-label={soundOn ? fa.teamOverview.soundOff : fa.teamOverview.soundOn}
                     aria-pressed={soundOn}
                     className={cn(
                        'absolute bottom-4 start-4 inline-flex size-9 items-center justify-center rounded-full border',
                        'border-white/8 bg-white/[0.03] text-zinc-500 backdrop-blur-sm transition-all duration-200',
                        'hover:scale-105 hover:bg-white/[0.07] hover:text-zinc-300 active:scale-95',
                        soundOn && 'text-primary'
                     )}
                     onClick={toggleSound}
                     title={soundOn ? fa.teamOverview.soundOff : fa.teamOverview.soundOn}
                     type="button"
                  >
                     {soundOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                  </button>
               </>
            ) : null}
         </div>

         <PersonSheet
            day={day}
            onOpenChange={(open) => {
               if (!open) setSelectedPersonId(null);
            }}
            onOpenTask={setIssueTaskKey}
            person={selectedPerson}
         />

         <Dialog open={Boolean(issueTaskKey)} onOpenChange={(open) => !open && closeIssue()}>
            <DialogContent
               className="h-[calc(100svh-2rem)] max-h-[920px] max-w-[1280px] gap-0 overflow-hidden rounded-2xl border-white/10 bg-[#101011] p-0 text-zinc-100 [direction:rtl]"
               showCloseButton={false}
            >
               <DialogTitle className="sr-only">جزئیات کار {issueTaskKey}</DialogTitle>
               <DialogDescription className="sr-only">مشاهده و ویرایش جزئیات کار</DialogDescription>
               {issueTaskKey ? <IssuePage taskKey={issueTaskKey} onClose={closeIssue} /> : null}
            </DialogContent>
         </Dialog>
      </div>
   );
}
