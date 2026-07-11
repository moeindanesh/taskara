'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ListPlus, Loader2, MoreHorizontal, Plus, Search, Unlink, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { LinearAvatar, linearStatusMeta, StatusIcon } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type { PaginatedResponse, TaskaraMilestone, TaskaraTask } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { MilestoneSelector } from './milestone-selector';
import { MilestoneEmptyState } from './primitives';
import { useOnlineStatus } from './use-online-status';

const statusOrder = ['IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'TODO', 'BACKLOG', 'DONE', 'CANCELED'];

export function MilestoneTasksPanel({
   milestone,
   workspaceSlug,
   onMilestoneRefresh,
}: {
   milestone: TaskaraMilestone;
   workspaceSlug: string;
   onMilestoneRefresh: () => void;
}) {
   const taskSync = useWorkspaceTaskSync();
   const online = useOnlineStatus();
   const [tasks, setTasks] = useState<TaskaraTask[]>(() => dedupeTasks([
      ...(milestone.tasks || []),
      ...taskSync.tasks.filter((task) => (task.milestoneId || task.milestone?.id) === milestone.id),
   ]));
   const [total, setTotal] = useState(milestone.progress.totalTasks);
   const [query, setQuery] = useState('');
   const [debouncedQuery, setDebouncedQuery] = useState('');
   const [loading, setLoading] = useState(!(milestone.tasks?.length));
   const [loadingMore, setLoadingMore] = useState(false);
   const [error, setError] = useState('');
   const [addOpen, setAddOpen] = useState(false);
   const [updatingTaskIds, setUpdatingTaskIds] = useState<Set<string>>(new Set());
   const requestRef = useRef(0);
   const canManage = milestone.canManage !== false;
   const canAssign = canManage && !milestone.archivedAt && (milestone.status === 'PLANNED' || milestone.status === 'ACTIVE');

   useEffect(() => {
      const timer = window.setTimeout(() => setDebouncedQuery(query.trim().slice(0, 200)), 250);
      return () => window.clearTimeout(timer);
   }, [query]);

   const load = useCallback(async (offset = 0) => {
      const requestId = ++requestRef.current;
      if (offset) setLoadingMore(true);
      else setLoading(true);
      setError('');
      const params = new URLSearchParams({
         milestoneId: milestone.id,
         limit: '100',
         offset: String(offset),
      });
      if (debouncedQuery) params.set('q', debouncedQuery);

      try {
         const result = await taskaraRequest<PaginatedResponse<TaskaraTask>>(`/tasks?${params.toString()}`);
         if (requestId !== requestRef.current) return;
         setTasks((current) => offset ? dedupeTasks([...current, ...result.items]) : result.items);
         setTotal(result.total);
      } catch (loadError) {
         if (requestId !== requestRef.current) return;
         setError(loadError instanceof Error ? loadError.message : fa.milestone.detailLoadingFailed);
      } finally {
         if (requestId === requestRef.current) {
            setLoading(false);
            setLoadingMore(false);
         }
      }
   }, [debouncedQuery, milestone.id]);

   useEffect(() => {
      void load(0);
      return () => {
         requestRef.current += 1;
      };
   }, [load]);

   const groups = useMemo(() => {
      const grouped = new Map<string, TaskaraTask[]>();
      for (const task of tasks) {
         const list = grouped.get(task.status) || [];
         list.push(task);
         grouped.set(task.status, list);
      }
      return [...grouped.entries()].sort(
         ([left], [right]) => statusRank(left) - statusRank(right)
      );
   }, [tasks]);

   async function updateTaskMilestone(task: TaskaraTask, milestoneId: string | null) {
      if (!canManage || updatingTaskIds.has(task.id)) return;
      setUpdatingTaskIds((current) => new Set(current).add(task.id));
      const previous = tasks;
      if (milestoneId !== milestone.id) setTasks((current) => current.filter((item) => item.id !== task.id));
      try {
         const updated = await taskSync.updateTask(task, { milestoneId });
         if (milestoneId === milestone.id) {
            setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
         } else {
            setTotal((current) => Math.max(0, current - 1));
            toast.success(fa.milestone.taskRemoved);
         }
         onMilestoneRefresh();
      } catch (updateError) {
         setTasks(previous);
         toast.error(updateError instanceof Error ? updateError.message : fa.milestone.taskRemoveFailed);
      } finally {
         setUpdatingTaskIds((current) => {
            const next = new Set(current);
            next.delete(task.id);
            return next;
         });
      }
   }

   function createTask() {
      window.dispatchEvent(new CustomEvent('taskara:create-issue', {
         detail: { projectId: milestone.projectId, milestoneId: milestone.id },
      }));
   }

   return (
      <div className="space-y-4">
         <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
               <h2 className="text-sm font-semibold">{fa.milestone.work}</h2>
               <p className="mt-1 text-xs text-muted-foreground">
                  {fa.milestone.taskCount(total)} • {fa.milestone.progressCount(milestone.progress.completedTasks, milestone.progress.eligibleTasks)}
               </p>
            </div>
            {canAssign ? (
               <div className="flex items-center gap-2">
                  <Button className="h-9 rounded-full" disabled={!online} size="sm" title={!online ? 'افزودن کار موجود در حالت آفلاین در دسترس نیست.' : undefined} variant="secondary" onClick={() => setAddOpen(true)}>
                     <ListPlus className="size-4" />
                     <span className="hidden sm:inline">{fa.milestone.addExistingTasks}</span>
                  </Button>
                  <Button className="h-9 rounded-full bg-indigo-500 text-white hover:bg-indigo-400" size="sm" onClick={createTask}>
                     <Plus className="size-4" />
                     {fa.milestone.createTask}
                  </Button>
               </div>
            ) : null}
         </div>

         <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
               aria-label={fa.milestone.tasksSearchPlaceholder}
               className="h-9 bg-card ps-9 pe-9"
               placeholder={fa.milestone.tasksSearchPlaceholder}
               value={query}
               onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
               <button
                  aria-label={fa.app.clear}
                  className="absolute left-1.5 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  type="button"
                  onClick={() => setQuery('')}
               >
                  <X className="size-3.5" />
               </button>
            ) : null}
         </div>

         {error ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground" role="alert">
               <span>{error}</span>
               <button className="underline" type="button" onClick={() => void load(0)}>{fa.milestone.retry}</button>
            </div>
         ) : null}
         {!online ? (
            <p className="rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-200" role="status">
               محتوای ذخیره‌شده نمایش داده می‌شود. ساخت کار و تغییر پیوند کارهای نمایش‌داده‌شده در صف همگام‌سازی قرار می‌گیرد؛ افزودن از فهرست پروژه پس از اتصال فعال می‌شود.
            </p>
         ) : null}

         {loading && !tasks.length ? (
            <div className="flex min-h-40 items-center justify-center text-muted-foreground">
               <Loader2 aria-label={fa.app.loading} className="size-5 animate-spin" />
            </div>
         ) : groups.length ? (
            <div className="space-y-4">
               {groups.map(([status, groupTasks]) => {
                  const meta = linearStatusMeta[status] || linearStatusMeta.TODO;
                  return (
                     <section key={status} aria-labelledby={`milestone-status-${status}`}>
                        <div className="mb-1 flex h-8 items-center gap-2 px-2 text-xs text-muted-foreground">
                           <StatusIcon status={status} />
                           <h3 id={`milestone-status-${status}`}>{meta.label}</h3>
                           <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{groupTasks.length.toLocaleString('fa-IR')}</span>
                        </div>
                        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/35">
                           {groupTasks.map((task) => (
                              <MilestoneTaskRow
                                 key={task.id}
                                 disabled={updatingTaskIds.has(task.id)}
                                 milestone={milestone}
                                 openMilestones={taskSync.milestones}
                                 task={task}
                                 workspaceSlug={workspaceSlug}
                                 onMilestoneChange={(milestoneId) => void updateTaskMilestone(task, milestoneId)}
                              />
                           ))}
                        </div>
                     </section>
                  );
               })}
               {tasks.length < total ? (
                  <div className="flex justify-center">
                     <Button disabled={loadingMore} size="sm" variant="secondary" onClick={() => void load(tasks.length)}>
                        {loadingMore ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                        نمایش کارهای بیشتر
                     </Button>
                  </div>
               ) : null}
            </div>
         ) : (
            <MilestoneEmptyState
               action={canAssign && !query ? (
                  <>
                     <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>{fa.milestone.addExistingTasks}</Button>
                     <Button className="bg-indigo-500 text-white hover:bg-indigo-400" size="sm" onClick={createTask}>{fa.milestone.createTask}</Button>
                  </>
               ) : undefined}
               description={query ? undefined : fa.milestone.noTasksDescription}
            >
               {query ? fa.milestone.noFilteredResults : fa.milestone.noTasks}
            </MilestoneEmptyState>
         )}

         <AddExistingTasksDialog
            milestone={milestone}
            open={addOpen}
            onAdded={() => {
               setAddOpen(false);
               void load(0);
               onMilestoneRefresh();
            }}
            onOpenChange={setAddOpen}
         />
      </div>
   );
}

function MilestoneTaskRow({
   disabled,
   milestone,
   openMilestones,
   task,
   workspaceSlug,
   onMilestoneChange,
}: {
   disabled: boolean;
   milestone: TaskaraMilestone;
   openMilestones: TaskaraMilestone[];
   task: TaskaraTask;
   workspaceSlug: string;
   onMilestoneChange: (milestoneId: string | null) => void;
}) {
   const canManage = milestone.canManage !== false && !milestone.archivedAt;
   return (
      <div className="group flex min-h-12 items-center gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0 hover:bg-muted/35">
         <StatusIcon className="shrink-0" status={task.status} />
         <Link
            className="min-w-0 flex-1 rounded-sm text-sm text-foreground outline-none hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-400/60 dark:hover:text-indigo-300"
            to={`/${workspaceSlug}/issue/${encodeURIComponent(task.key)}`}
         >
            <span className="block truncate">{task.title}</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">{task.key}</span>
         </Link>
         {task.assignee ? (
            <LinearAvatar className="size-6 shrink-0" name={task.assignee.name} src={task.assignee.avatarUrl} />
         ) : null}
         {canManage ? (
            <MilestoneSelector
               className="hidden h-8 max-w-44 md:flex"
               currentMilestone={{
                  archivedAt: milestone.archivedAt,
                  id: milestone.id,
                  kind: milestone.kind,
                  name: milestone.name,
                  projectId: milestone.projectId,
                  status: milestone.status,
               }}
               disabled={disabled}
               milestones={openMilestones}
               projectId={milestone.projectId}
               value={task.milestoneId || task.milestone?.id || milestone.id}
               onChange={onMilestoneChange}
            />
         ) : null}
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <button
                  aria-label={`اقدام‌های ${task.title}`}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-indigo-400/60 group-hover:opacity-100"
                  disabled={disabled}
                  type="button"
               >
                  {disabled ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
               </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 [direction:rtl]">
               <DropdownMenuItem onSelect={() => window.location.assign(`/${workspaceSlug}/issue/${encodeURIComponent(task.key)}`)}>
                  مشاهده کار
               </DropdownMenuItem>
               {canManage ? (
                  <DropdownMenuItem className="text-rose-600 dark:text-rose-300" onSelect={() => onMilestoneChange(null)}>
                     <Unlink className="size-4" />
                     {fa.milestone.removeTask}
                  </DropdownMenuItem>
               ) : null}
            </DropdownMenuContent>
         </DropdownMenu>
      </div>
   );
}

function AddExistingTasksDialog({
   milestone,
   open,
   onAdded,
   onOpenChange,
}: {
   milestone: TaskaraMilestone;
   open: boolean;
   onAdded: () => void;
   onOpenChange: (open: boolean) => void;
}) {
   const taskSync = useWorkspaceTaskSync();
   const [query, setQuery] = useState('');
   const [tasks, setTasks] = useState<TaskaraTask[]>([]);
   const [selected, setSelected] = useState<Set<string>>(new Set());
   const [loading, setLoading] = useState(false);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!open) return;
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
         setLoading(true);
         setError('');
         const params = new URLSearchParams({ projectId: milestone.projectId, limit: '200', offset: '0' });
         if (query.trim()) params.set('q', query.trim().slice(0, 200));
         void taskaraRequest<PaginatedResponse<TaskaraTask>>(`/tasks?${params.toString()}`, { signal: controller.signal })
            .then((result) => setTasks(result.items.filter((task) =>
               (task.milestoneId || task.milestone?.id) !== milestone.id
            )))
            .catch((loadError) => {
               if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : fa.milestone.detailLoadingFailed);
            })
            .finally(() => {
               if (!controller.signal.aborted) setLoading(false);
            });
      }, query ? 250 : 0);
      return () => {
         controller.abort();
         window.clearTimeout(timer);
      };
   }, [milestone.id, milestone.projectId, open, query]);

   useEffect(() => {
      if (open) {
         setSelected(new Set());
         setQuery('');
         setError('');
      }
   }, [open]);

   async function addSelected() {
      if (!selected.size) return;
      setSubmitting(true);
      setError('');
      const selectedTasks = tasks.filter((task) => selected.has(task.id));
      const results = await Promise.allSettled(
         selectedTasks.map((task) => taskSync.updateTask(task, { milestoneId: milestone.id }))
      );
      const failedIds = new Set(
         results.flatMap((result, index) => result.status === 'rejected' ? [selectedTasks[index].id] : [])
      );
      setSubmitting(false);
      if (failedIds.size) {
         setSelected(failedIds);
         setError(`${failedIds.size.toLocaleString('fa-IR')} کار افزوده نشد. دوباره تلاش کنید.`);
         toast.error(fa.milestone.tasksAddFailed);
         return;
      }
      toast.success(fa.milestone.tasksAdded);
      onAdded();
   }

   return (
      <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[720px] flex-col overflow-hidden border-border bg-popover p-0 [direction:rtl]">
            <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 text-right">
               <DialogTitle>{fa.milestone.addExistingTasks}</DialogTitle>
               <DialogDescription className="text-right">{fa.milestone.addTasksDescription}</DialogDescription>
            </DialogHeader>
            <div className="shrink-0 px-5 pt-4">
               <div className="relative">
                  <Search className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                     aria-label={fa.milestone.tasksSearchPlaceholder}
                     className="h-9 bg-card ps-9"
                     placeholder={fa.milestone.tasksSearchPlaceholder}
                     value={query}
                     onChange={(event) => setQuery(event.target.value)}
                  />
               </div>
            </div>
            <div className="min-h-48 flex-1 overflow-y-auto p-5 pt-3">
               {loading ? (
                  <div className="flex min-h-40 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
               ) : error && !tasks.length ? (
                  <p className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs text-destructive-foreground" role="alert">{error}</p>
               ) : tasks.length ? (
                  <div className="overflow-hidden rounded-xl border border-border/70">
                     {tasks.map((task) => {
                        const linkedMilestone = task.milestone?.name;
                        return (
                           <label className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0 hover:bg-muted/40" key={task.id}>
                              <input
                                 aria-label={task.title}
                                 className="size-4 shrink-0 accent-indigo-500"
                                 checked={selected.has(task.id)}
                                 type="checkbox"
                                 onChange={(event) => setSelected((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) next.add(task.id);
                                    else next.delete(task.id);
                                    return next;
                                 })}
                              />
                              <StatusIcon status={task.status} />
                              <span className="min-w-0 flex-1">
                                 <span className="block truncate text-sm">{task.title}</span>
                                 <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                                    {task.key}{linkedMilestone ? ` • انتقال از ${linkedMilestone}` : ''}
                                 </span>
                              </span>
                              {task.assignee ? <LinearAvatar className="size-6" name={task.assignee.name} src={task.assignee.avatarUrl} /> : null}
                           </label>
                        );
                     })}
                  </div>
               ) : (
                  <MilestoneEmptyState>{fa.milestone.noFilteredResults}</MilestoneEmptyState>
               )}
               {error && tasks.length ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
            </div>
            <DialogFooter className="shrink-0 flex-row items-center justify-between border-t border-border/60 px-5 py-3 sm:justify-between">
               <span className="text-xs text-muted-foreground">{selected.size.toLocaleString('fa-IR')} انتخاب</span>
               <div className="flex gap-2">
                  <Button disabled={submitting} type="button" variant="secondary" onClick={() => onOpenChange(false)}>{fa.app.cancel}</Button>
                  <Button disabled={submitting || selected.size === 0} type="button" onClick={() => void addSelected()}>
                     {submitting ? <Loader2 className="size-4 animate-spin" /> : <ListPlus className="size-4" />}
                     {fa.milestone.addSelectedTasks}
                  </Button>
               </div>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}

function statusRank(status: string) {
   const index = statusOrder.indexOf(status);
   return index === -1 ? statusOrder.length : index;
}

function dedupeTasks(tasks: TaskaraTask[]) {
   return [...new Map(tasks.map((task) => [task.id, task])).values()];
}
