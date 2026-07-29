'use client';

import { useCallback, useMemo, useState } from 'react';
import { CalendarPlus, Plus, UserPlus } from 'lucide-react';
import { LinearAvatar, StatusIcon } from '@/components/taskara/linear-ui';
import { ComposerPriorityPill } from '@/components/taskara/workspace-task-composer';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import type { TaskaraTask } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import type { PersonGraphNode } from './graph-model';
import { isDueToday, isOverdue, selectPersonTasks, selectUnassignedTasks } from './person-tasks';
import { type WorkspaceDay, endOfWorkspaceDay } from './today-load';

type SheetTab = 'person' | 'unassigned';

export interface PersonSheetProps {
   day: WorkspaceDay;
   person: PersonGraphNode | null;
   onOpenTask: (taskKey: string) => void;
   onOpenChange: (open: boolean) => void;
}

export function PersonSheet({ day, person, onOpenTask, onOpenChange }: PersonSheetProps) {
   const { tasks, updateTask } = useWorkspaceTaskSync();
   const [tab, setTab] = useState<SheetTab>('person');
   const [openPriorityFor, setOpenPriorityFor] = useState<string | null>(null);
   const [pending, setPending] = useState<Set<string>>(new Set());

   const personTasks = useMemo(
      () => (person ? selectPersonTasks(tasks, person.userId, day) : []),
      [day, person, tasks]
   );
   const unassignedTasks = useMemo(() => selectUnassignedTasks(tasks, day), [day, tasks]);

   const mutate = useCallback(
      async (task: TaskaraTask, patch: Parameters<typeof updateTask>[1]) => {
         setPending((current) => new Set(current).add(task.id));
         try {
            await updateTask(task, patch);
         } finally {
            setPending((current) => {
               const next = new Set(current);
               next.delete(task.id);
               return next;
            });
         }
      },
      [updateTask]
   );

   const pullIntoToday = useCallback(
      (task: TaskaraTask) => void mutate(task, { dueAt: endOfWorkspaceDay(day).toISOString() }),
      [day, mutate]
   );

   const claimForPerson = useCallback(
      (task: TaskaraTask) => {
         if (!person) return;
         // Assigning without a date would drop the task into a pool the graph never shows, so the
         // one action does both: it belongs to someone, and it belongs to today.
         void mutate(task, { assigneeId: person.userId, dueAt: endOfWorkspaceDay(day).toISOString() });
      },
      [day, mutate, person]
   );

   const composeForPerson = useCallback(() => {
      if (!person) return;
      window.dispatchEvent(
         new CustomEvent('taskara:create-issue', {
            detail: { assigneeId: person.userId, dueAt: endOfWorkspaceDay(day).toISOString() },
         })
      );
   }, [day, person]);

   const visible = tab === 'person' ? personTasks : unassignedTasks;

   return (
      <Sheet open={Boolean(person)} onOpenChange={onOpenChange}>
         <SheetContent
            className="w-full gap-0 border-white/10 bg-[#0b0b0c] p-0 text-zinc-100 sm:max-w-xl [direction:rtl]"
            side="left"
         >
            <SheetHeader className="gap-3 border-b border-white/6 px-5 py-4">
               {/* The sheet's own close button is pinned to the physical right, which is where an
                   RTL header starts — so the title yields that corner to it. */}
               <SheetTitle className="flex items-center gap-2.5 ps-8 text-sm font-medium text-zinc-100">
                  {person ? <LinearAvatar name={person.label} src={person.avatarUrl} className="size-7" /> : null}
                  <span className="truncate">{person?.label}</span>
               </SheetTitle>
               <SheetDescription className="text-xs text-zinc-500">
                  {fa.teamOverview.sheetDescription}
               </SheetDescription>

               <div className="flex items-center gap-1.5">
                  <TabButton active={tab === 'person'} onClick={() => setTab('person')}>
                     {fa.teamOverview.tabPersonTasks} ({personTasks.length.toLocaleString('fa-IR')})
                  </TabButton>
                  <TabButton active={tab === 'unassigned'} onClick={() => setTab('unassigned')}>
                     {fa.teamOverview.tabUnassigned} ({unassignedTasks.length.toLocaleString('fa-IR')})
                  </TabButton>
                  <button
                     className="ms-auto inline-flex h-7 items-center gap-1 rounded-full bg-indigo-500 px-3 text-[12px] text-white transition-colors hover:bg-indigo-400"
                     onClick={composeForPerson}
                     type="button"
                  >
                     <Plus className="size-3.5" />
                     {fa.teamOverview.newIssue}
                  </button>
               </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" data-testid="person-sheet-list">
               {visible.length === 0 ? (
                  <p className="px-3 py-10 text-center text-xs text-zinc-600">
                     {tab === 'person' ? fa.teamOverview.emptyPersonTasks : fa.teamOverview.emptyUnassigned}
                  </p>
               ) : null}

               {visible.map((task) => (
                  <div
                     className="group flex items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
                     data-task-key={task.key}
                     data-testid="person-sheet-row"
                     key={task.id}
                  >
                     <button
                        className="flex min-w-0 flex-1 items-center gap-2 text-start"
                        onClick={() => onOpenTask(task.key)}
                        type="button"
                     >
                        <StatusIcon status={task.status} />
                        <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">{task.key}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">{task.title}</span>
                     </button>

                     <span
                        className={cn(
                           'shrink-0 text-[11px] tabular-nums',
                           isOverdue(task, day) ? 'text-red-400' : 'text-zinc-600'
                        )}
                     >
                        {task.dueAt ? formatJalaliDate(task.dueAt) : fa.teamOverview.noDueDate}
                     </span>

                     <ComposerPriorityPill
                        className="shrink-0"
                        disabled={pending.has(task.id)}
                        onAfterChange={() => setOpenPriorityFor(null)}
                        onChange={(priority) => void mutate(task, { priority })}
                        onOpenChange={(open) => setOpenPriorityFor(open ? task.id : null)}
                        open={openPriorityFor === task.id}
                        priority={task.priority}
                     />

                     {tab === 'person' ? (
                        isDueToday(task, day) ? null : (
                           <FastAction
                              disabled={pending.has(task.id)}
                              icon={<CalendarPlus className="size-3.5" />}
                              label={fa.teamOverview.moveToToday}
                              onClick={() => pullIntoToday(task)}
                              testId="pull-into-today"
                           />
                        )
                     ) : (
                        <FastAction
                           disabled={pending.has(task.id)}
                           icon={<UserPlus className="size-3.5" />}
                           label={fa.teamOverview.assignToPerson(person?.label ?? '')}
                           onClick={() => claimForPerson(task)}
                           testId="claim-for-person"
                        />
                     )}
                  </div>
               ))}
            </div>
         </SheetContent>
      </Sheet>
   );
}

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
   return (
      <button
         aria-pressed={active}
         className={cn(
            'h-7 rounded-full px-3 text-[12px] transition-colors',
            active ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
         )}
         onClick={onClick}
         type="button"
      >
         {children}
      </button>
   );
}

function FastAction({
   disabled,
   icon,
   label,
   onClick,
   testId,
}: {
   disabled: boolean;
   icon: React.ReactNode;
   label: string;
   onClick: () => void;
   testId: string;
}) {
   return (
      <button
         aria-label={label}
         className={cn(
            'inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-white/8 text-zinc-500 transition-all',
            'hover:scale-110 hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-indigo-300',
            'disabled:pointer-events-none disabled:opacity-40'
         )}
         data-testid={testId}
         disabled={disabled}
         onClick={onClick}
         title={label}
         type="button"
      >
         {icon}
      </button>
   );
}
