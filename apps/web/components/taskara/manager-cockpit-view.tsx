'use client';

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
   ArrowUpRight,
   CalendarDays,
   CheckCircle2,
   CircleDot,
   EyeOff,
   ListChecks,
   Loader2,
   MessagesSquare,
   RefreshCw,
   Save,
   TimerReset,
} from 'lucide-react';
import { LinearAvatar, LinearEmptyState, ProjectGlyph, StatusIcon } from '@/components/taskara/linear-ui';
import { IssuePage } from '@/components/taskara/issue-page';
import { TaskDueDateControl } from '@/components/taskara/task-due-date-control';
import {
   ComposerAssigneePill,
   ComposerPriorityPill,
   ComposerProjectPill,
   ComposerStatusPill,
} from '@/components/taskara/workspace-task-composer';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { managerAttentionGroupKey } from '@/lib/manager-attention';
import { useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { isRetryableTaskSyncError, loadPendingTaskSyncMutations, sendTaskSyncMutation } from '@/lib/task-sync';
import type { TaskUpdatePatch } from '@/lib/task-sync';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import {
   applyPendingAgendaItemMutations,
   applyPendingAttentionAction,
   applyPendingAttentionMutations,
   applyPendingCarryForwardAgendaMutations,
   applyPendingMeetingActionItemMutations,
   type PendingAttentionAction,
} from '@/lib/workspace-data/pending';
import type {
   TaskaraAttentionItem,
   TaskaraAttentionResponse,
   TaskaraMeetingActionItem,
   TaskaraMeetingActionItemListResponse,
   TaskaraOneOnOneAgendaResponse,
   TaskaraTask,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { getAuthSession } from '@/store/auth-store';
import { toast } from 'sonner';

const numberFormatter = new Intl.NumberFormat('fa-IR');

interface ManagerQueueItem {
   id: string;
   items: TaskaraAttentionItem[];
   primary: TaskaraAttentionItem;
   reasons: TaskaraAttentionItem['reason'][];
   severity: TaskaraAttentionItem['severity'];
}

export function ManagerCockpitView() {
   const { orgId } = useParams();
   const workspaceSlug = orgId || 'taskara';
   const [attention, setAttention] = useState<TaskaraAttentionResponse | null>(null);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState<string | null>(null);
   const [pendingId, setPendingId] = useState<string | null>(null);
   const [dismissTarget, setDismissTarget] = useState<ManagerQueueItem | null>(null);
   const [dismissReason, setDismissReason] = useState('');
   const [agendaTarget, setAgendaTarget] = useState<TaskaraAttentionItem | null>(null);
   const [issueTaskKey, setIssueTaskKey] = useState<string | null>(null);
   const [showAllActions, setShowAllActions] = useState(false);
   const loadRequestRef = useRef(0);

   const loadAttention = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
      const requestId = ++loadRequestRef.current;
      if (mode === 'initial') setLoading(true);
      setError(null);

      try {
         const data = await taskaraRequest<TaskaraAttentionResponse>('/attention?limit=100');
         const pendingMutations = await loadPendingTaskSyncMutations();
         if (requestId !== loadRequestRef.current) return;
         setAttention(applyPendingAttentionMutations(data, pendingMutations));
      } catch (loadError) {
         if (requestId === loadRequestRef.current) {
            setError(loadError instanceof Error ? loadError.message : fa.cockpit.loadFailed);
         }
      } finally {
         if (requestId === loadRequestRef.current) {
            setLoading(false);
         }
      }
   }, []);

   useEffect(() => {
      void loadAttention('initial');
   }, [loadAttention]);

   useLiveRefresh(() => loadAttention('refresh'), {
      fireOnMount: false,
      workspaceEventFilter: cockpitRefreshSourceMatches,
   });

   const visibleItems = useMemo(() => groupAttentionItems(attention?.items || []), [attention?.items]);
   const nextItem = visibleItems[0] || null;
   const remainingItems = visibleItems.slice(1);
   const displayedRemainingItems = showAllActions ? remainingItems : remainingItems.slice(0, 4);

   const applyLifecycleAction = useCallback(
      async (item: ManagerQueueItem, action: 'snooze' | 'resolve') => {
         setPendingId(item.id);
         const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
         const targetItems = action === 'snooze' ? item.items : [item.primary];
         const optimisticAction: PendingAttentionAction =
            action === 'snooze' ? { type: 'snooze', snoozedUntil } : { type: 'resolve' };
         setAttention((current) =>
            current
               ? targetItems.reduce(
                    (next, attentionItem) => applyPendingAttentionAction(next, attentionItem, optimisticAction),
                    current
                 )
               : current
         );

         try {
            if (action === 'snooze') {
               await Promise.all(
                  targetItems.map((attentionItem) =>
                     sendTaskSyncMutation<TaskaraAttentionItem>(
                        'attention.snooze',
                        { id: attentionItem.id, snoozedUntil },
                        undefined,
                        undefined,
                        { keepPendingOnRetryable: true }
                     )
                  )
               );
            } else {
               await Promise.all(
                  targetItems.map((attentionItem) =>
                     sendTaskSyncMutation<TaskaraAttentionItem>(
                        'attention.resolve',
                        { id: attentionItem.id },
                        undefined,
                        undefined,
                        { keepPendingOnRetryable: true }
                     )
                  )
               );
            }
            void loadAttention('refresh');
         } catch (actionError) {
            if (isRetryableTaskSyncError(actionError)) {
               toast.message(fa.cockpit.actionQueued);
               return;
            }
            toast.error(actionError instanceof Error ? actionError.message : fa.cockpit.actionFailed);
            void loadAttention('refresh');
         } finally {
            setPendingId(null);
         }
      },
      [loadAttention]
   );

   async function submitDismiss(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const reason = dismissReason.trim();
      if (!dismissTarget || reason.length < 3) return;

      setPendingId(dismissTarget.id);
      setAttention((current) =>
         current
            ? applyPendingAttentionAction(current, dismissTarget.primary, { type: 'dismiss', reason })
            : current
      );
      try {
         await sendTaskSyncMutation<TaskaraAttentionItem>(
            'attention.dismiss',
            { id: dismissTarget.primary.id, reason },
            undefined,
            undefined,
            { keepPendingOnRetryable: true }
         );
         setDismissTarget(null);
         setDismissReason('');
         void loadAttention('refresh');
      } catch (actionError) {
         if (isRetryableTaskSyncError(actionError)) {
            toast.message(fa.cockpit.actionQueued);
            setDismissTarget(null);
            setDismissReason('');
            return;
         }
         toast.error(actionError instanceof Error ? actionError.message : fa.cockpit.actionFailed);
         void loadAttention('refresh');
      } finally {
         setPendingId(null);
      }
   }

   const itemActions = (item: ManagerQueueItem) => ({
      disabled: pendingId === item.id,
      onDismiss: () => {
         setDismissTarget(item);
         setDismissReason('');
      },
      onOpenAgenda: item.primary.payload.oneOnOne ? () => setAgendaTarget(item.primary) : undefined,
      onOpenIssue: attentionIssueTaskKey(item.primary)
         ? () => setIssueTaskKey(attentionIssueTaskKey(item.primary))
         : undefined,
      onResolve: () => void applyLifecycleAction(item, 'resolve'),
      onSnooze: () => void applyLifecycleAction(item, 'snooze'),
      orgId: workspaceSlug,
   });

   return (
      <div className="flex h-full flex-col bg-background dark:bg-[#101011]" data-testid="manager-cockpit-screen">
         <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6 sm:py-7">
            <main className="mx-auto max-w-[1160px]">
               {error ? (
                  <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
                     {error}
                  </p>
               ) : null}

               {loading && !attention ? (
                  <LinearEmptyState>{fa.app.loading}</LinearEmptyState>
               ) : error && !nextItem ? null : nextItem ? (
                  <>
                     <section aria-labelledby="next-manager-action">
                        <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
                           <h2 id="next-manager-action" className="text-xs text-muted-foreground">
                              {fa.cockpit.nextAction}
                           </h2>
                           <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                              {fa.cockpit.itemProgress(1, visibleItems.length)}
                           </span>
                        </div>
                        <NextAttentionCard item={nextItem} {...itemActions(nextItem)} />
                     </section>

                     {remainingItems.length ? (
                        <section className="mt-6" aria-labelledby="remaining-manager-actions">
                           <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
                              <h2 id="remaining-manager-actions" className="text-xs text-muted-foreground">
                                 {fa.cockpit.remainingActions}
                              </h2>
                              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                                 {numberFormatter.format(remainingItems.length)}
                              </span>
                           </div>
                           <ol className="grid gap-2.5">
                              {displayedRemainingItems.map((item, index) => (
                                 <li key={item.id}>
                                    <AttentionQueueRow
                                       item={item}
                                       position={index + 2}
                                       total={visibleItems.length}
                                       {...itemActions(item)}
                                    />
                                 </li>
                              ))}
                           </ol>
                           {remainingItems.length > 4 ? (
                              <button
                                 className="mt-2 inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-white/[0.05] dark:hover:text-zinc-200"
                                 type="button"
                                 onClick={() => setShowAllActions((current) => !current)}
                              >
                                 {showAllActions
                                    ? fa.cockpit.showFewerActions
                                    : fa.cockpit.showAllActions(remainingItems.length)}
                              </button>
                           ) : null}
                        </section>
                     ) : null}
                  </>
               ) : (
                  <AllClearState />
               )}
            </main>
         </div>

         <Dialog open={Boolean(dismissTarget)} onOpenChange={(open) => !open && setDismissTarget(null)}>
            <DialogContent className="max-w-md [direction:rtl]">
               <form onSubmit={submitDismiss}>
                  <DialogHeader>
                     <DialogTitle>{fa.cockpit.dismissTitle}</DialogTitle>
                     <DialogDescription>{fa.cockpit.dismissDescription}</DialogDescription>
                  </DialogHeader>
                  <Textarea
                     autoFocus
                     className="mt-4 min-h-24 resize-none"
                     placeholder={fa.cockpit.dismissReasonPlaceholder}
                     value={dismissReason}
                     onChange={(event) => setDismissReason(event.target.value)}
                  />
                  <DialogFooter className="mt-4">
                     <button
                        className="h-8 rounded-md border border-white/10 px-3 text-xs text-zinc-300 hover:bg-white/[0.05]"
                        type="button"
                        onClick={() => setDismissTarget(null)}
                     >
                        {fa.app.cancel}
                     </button>
                     <button
                        className="h-8 rounded-md bg-zinc-100 px-3 text-xs font-medium text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={dismissReason.trim().length < 3 || Boolean(pendingId)}
                        type="submit"
                     >
                        {fa.cockpit.dismissConfirm}
                     </button>
                  </DialogFooter>
               </form>
            </DialogContent>
         </Dialog>

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

         <OneOnOneAgendaDialog
            item={agendaTarget}
            onClose={() => setAgendaTarget(null)}
            orgId={workspaceSlug}
         />
      </div>
   );
}

interface AttentionCardActions {
   disabled: boolean;
   onDismiss: () => void;
   onOpenAgenda?: () => void;
   onOpenIssue?: () => void;
   onResolve: () => void;
   onSnooze: () => void;
   orgId: string;
}

function NextAttentionCard({ item, ...actions }: { item: ManagerQueueItem } & AttentionCardActions) {
   const primary = item.primary;
   const payload = primary.payload || {};
   const title = payload.title || primary.reason;
   const description = payload.description || primary.reason;
   const [hasTaskDraft, setHasTaskDraft] = useState(false);

   return (
      <article className={cn('relative overflow-hidden rounded-3xl border bg-card/65 p-5 sm:p-6', severityBorderClasses[item.severity])}>
         <div className={cn('absolute inset-y-4 right-0 w-0.5 rounded-full', severityRailClasses[item.severity])} />
         <div className="flex min-w-0 items-start gap-3 sm:gap-4">
            <AttentionEntityMark item={primary} featured />
            <div className="min-w-0 flex-1">
               <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', severityBadgeClasses[item.severity])}>
                     {severityLabels[item.severity]}
                  </span>
                  <AttentionReasonLabels reasons={item.reasons} />
               </div>
               <h3 className="mt-3 text-lg leading-8 text-foreground sm:text-xl">
                  {title}
               </h3>
               <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
                  {description}
               </p>
               <AttentionContext item={primary} className="mt-3" />
               {payload.task ? <ManagerTaskQuickEdit item={primary} className="mt-4" onDirtyChange={setHasTaskDraft} /> : null}
            </div>
         </div>
         <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-4 dark:border-white/7">
            <AttentionOpenControl
               item={primary}
               onOpenAgenda={actions.onOpenAgenda}
               onOpenIssue={actions.onOpenIssue}
               orgId={actions.orgId}
               featured
            />
            <div className="flex flex-wrap items-center gap-2">
               <LifecycleControls {...actions} disabled={actions.disabled || hasTaskDraft} featured />
            </div>
         </div>
      </article>
   );
}

function AttentionQueueRow({
   item,
   position,
   total,
   ...actions
}: {
   item: ManagerQueueItem;
   position: number;
   total: number;
} & AttentionCardActions) {
   const primary = item.primary;
   const payload = primary.payload || {};
   const [hasTaskDraft, setHasTaskDraft] = useState(false);

   return (
      <article className="grid gap-3 rounded-2xl border border-border/65 bg-card/45 p-4 transition hover:border-indigo-400/25 hover:bg-card/65 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center">
         <AttentionEntityMark item={primary} />
         <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
               <span className="truncate text-sm text-foreground">
                  {payload.title || primary.reason}
               </span>
               <AttentionReasonLabels compact reasons={item.reasons} />
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
               {payload.description || primary.reason}
            </p>
            <AttentionContext item={primary} className="mt-1.5" />
            {payload.task ? <ManagerTaskQuickEdit compact item={primary} className="mt-2.5" onDirtyChange={setHasTaskDraft} /> : null}
         </div>
         <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-transparent md:justify-end">
            <span className="me-1 hidden text-[10px] text-zinc-600 lg:inline">
               {fa.cockpit.itemProgress(position, total)}
            </span>
            <AttentionOpenControl
               item={primary}
               onOpenAgenda={actions.onOpenAgenda}
               onOpenIssue={actions.onOpenIssue}
               orgId={actions.orgId}
            />
            <LifecycleControls {...actions} disabled={actions.disabled || hasTaskDraft} />
         </div>
      </article>
   );
}

function AttentionEntityMark({ item, featured = false }: { item: TaskaraAttentionItem; featured?: boolean }) {
   const payload = item.payload || {};
   const className = featured ? 'size-11 shrink-0' : 'size-9 shrink-0';

   if (payload.task) {
      return (
         <span className={cn('inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 dark:border-white/8 dark:bg-white/[0.035]', className)}>
            <StatusIcon status={payload.task.status} className={featured ? 'size-5' : 'size-4'} />
         </span>
      );
   }
   if (payload.project) {
      return <ProjectGlyph name={payload.project.name} className={cn('rounded-xl', className)} iconClassName={featured ? 'size-5' : 'size-4'} />;
   }
   if (payload.user) {
      return <LinearAvatar name={payload.user.name} src={payload.user.avatarUrl} className={className} />;
   }
   if (payload.oneOnOne) {
      return <IconMark icon={CalendarDays} className={className} />;
   }
   if (payload.actionItem) {
      return <IconMark icon={MessagesSquare} className={className} />;
   }
   return <IconMark icon={CircleDot} className={className} />;
}

function IconMark({ icon: Icon, className }: { icon: typeof CircleDot; className: string }) {
   return (
      <span className={cn('inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-white/8 dark:bg-white/[0.035]', className)}>
         <Icon className="size-4" />
      </span>
   );
}

function AttentionContext({ item, className }: { item: TaskaraAttentionItem; className?: string }) {
   const payload = item.payload || {};
   const taskKey = payload.task?.key;
   const context = [
      taskKey && !payload.title?.includes(taskKey) ? taskKey : null,
      payload.project?.teamName,
      payload.oneOnOne?.participantName,
      payload.actionItem?.meetingTitle,
      !payload.task && payload.signal?.dueAt ? formatJalaliDate(payload.signal.dueAt) : null,
      typeof payload.signal?.ageHours === 'number' ? fa.cockpit.hourCount(payload.signal.ageHours) : null,
   ].filter((value): value is string => Boolean(value));

   if (!context.length) return null;

   return (
      <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500', className)}>
         {context.map((value, index) => (
            <span className={cn('min-w-0 truncate', index === 0 && payload.task?.key && 'ltr font-medium')} key={`${value}-${index}`}>
               {value}
            </span>
         ))}
      </div>
   );
}

type ManagerTaskQuickEditField = 'assignee' | 'dueAt' | 'priority' | 'project' | 'status';

function ManagerTaskQuickEdit({
   className,
   compact = false,
   item,
   onDirtyChange,
}: {
   className?: string;
   compact?: boolean;
   item: TaskaraAttentionItem;
   onDirtyChange?: (dirty: boolean) => void;
}) {
   const { projects, tasks, updateTask, users } = useWorkspaceTaskSync();
   const payloadTask = item.payload.task;
   const sourceTask = useMemo<TaskaraTask | null>(() => {
      if (!payloadTask) return null;

      const syncedTask = tasks.find((task) => task.id === payloadTask.id || task.key === payloadTask.key);
      if (syncedTask) return syncedTask;

      const project = projects.find((candidate) => candidate.id === payloadTask.projectId) || null;
      const assignee = users.find((candidate) => candidate.id === payloadTask.assigneeId) || null;
      return {
         id: payloadTask.id,
         key: payloadTask.key,
         title: payloadTask.title,
         status: payloadTask.status,
         priority: payloadTask.priority,
         dueAt: payloadTask.dueAt,
         project,
         assignee,
      };
   }, [payloadTask, projects, tasks, users]);
   const [stagedPatch, setStagedPatch] = useState<TaskUpdatePatch>({});
   const [openField, setOpenField] = useState<ManagerTaskQuickEditField | null>(null);
   const [saving, setSaving] = useState(false);
   const draftTask = useMemo(
      () => sourceTask ? applyManagerTaskQuickEditPatch(sourceTask, stagedPatch, projects, users) : null,
      [projects, sourceTask, stagedPatch, users]
   );
   const draftPatch = useMemo(
      () => sourceTask && draftTask ? buildManagerTaskQuickEditPatch(sourceTask, draftTask) : {},
      [draftTask, sourceTask]
   );
   const hasChanges = Object.keys(draftPatch).length > 0;

   useEffect(() => {
      if (!saving && !hasChanges && Object.keys(stagedPatch).length) setStagedPatch({});
   }, [hasChanges, saving, stagedPatch]);

   useEffect(() => {
      onDirtyChange?.(hasChanges || saving);
      return () => onDirtyChange?.(false);
   }, [hasChanges, onDirtyChange, saving]);

   if (!draftTask || !payloadTask) return null;

   const selectedProject = projects.find((project) => project.id === draftTask.project?.id) || null;
   const selectedAssignee = users.find((user) => user.id === draftTask.assignee?.id) || draftTask.assignee || null;
   const disabled = saving;
   const currentUserId = getAuthSession()?.user.id || null;
   const pillClassName = cn(
      'border-border/70 bg-muted/70 text-foreground shadow-none hover:bg-muted dark:border-white/8 dark:bg-white/[0.055] dark:text-zinc-300 dark:hover:bg-white/[0.08]',
      compact ? 'h-6 max-w-[136px]' : 'h-7 max-w-[168px]'
   );

   const setFieldOpen = (field: ManagerTaskQuickEditField, open: boolean) => {
      setOpenField(open ? field : null);
   };

   const stagePatch = (patch: TaskUpdatePatch) => {
      if (saving || !sourceTask) return;
      setStagedPatch((current) => {
         const nextDraft = applyManagerTaskQuickEditPatch(sourceTask, { ...current, ...patch }, projects, users);
         return buildManagerTaskQuickEditPatch(sourceTask, nextDraft);
      });
   };

   const saveDraft = async () => {
      if (saving || !sourceTask || !Object.keys(draftPatch).length) return;
      setSaving(true);
      try {
         await updateTask(sourceTask, draftPatch);
         setStagedPatch({});
         toast.success('تغییرات کار ذخیره شد.');
      } catch (updateError) {
         toast.error(updateError instanceof Error ? updateError.message : fa.issue.updateFailed);
      } finally {
         setSaving(false);
      }
   };

   return (
      <div
         aria-label={`${fa.issue.properties}: ${draftTask.key}`}
         className={cn(
            'flex flex-wrap items-center gap-1.5 rounded-xl border border-border/60 bg-background/55 p-2 dark:border-white/7 dark:bg-black/15',
            className
         )}
         data-testid={`manager-task-quick-edit-${draftTask.id}`}
      >
         <ComposerStatusPill
            className={pillClassName}
            disabled={disabled}
            open={openField === 'status'}
            status={draftTask.status}
            onAfterChange={() => undefined}
            onChange={(status) => stagePatch({ status })}
            onOpenChange={(open) => setFieldOpen('status', open)}
         />
         <ComposerPriorityPill
            className={pillClassName}
            disabled={disabled}
            open={openField === 'priority'}
            priority={draftTask.priority}
            onAfterChange={() => undefined}
            onChange={(priority) => stagePatch({ priority })}
            onOpenChange={(open) => setFieldOpen('priority', open)}
         />
         <ComposerAssigneePill
            assignee={selectedAssignee}
            className={pillClassName}
            currentUserId={currentUserId}
            disabled={disabled}
            open={openField === 'assignee'}
            users={users}
            onAfterChange={() => undefined}
            onChange={(assigneeId) => stagePatch({ assigneeId: assigneeId || null })}
            onOpenChange={(open) => setFieldOpen('assignee', open)}
         />
         <ComposerProjectPill
            className={pillClassName}
            disabled={disabled}
            open={openField === 'project'}
            project={selectedProject}
            projects={projects}
            onAfterChange={() => undefined}
            onChange={(projectId) =>
               stagePatch({
                  projectId,
                  ...(projectId === draftTask.project?.id ? {} : { milestoneId: null }),
               })
            }
            onOpenChange={(open) => setFieldOpen('project', open)}
         />
         <TaskDueDateControl
            className={cn(pillClassName, compact ? 'w-[118px]' : 'w-36')}
            disabled={disabled}
            dueAt={draftTask.dueAt}
            iconClassName="text-zinc-500"
            open={openField === 'dueAt'}
            onAfterChange={() => undefined}
            onChange={(dueAt) => stagePatch({ dueAt })}
            onOpenChange={(open) => setFieldOpen('dueAt', open)}
         />
         <button
            aria-hidden={!hasChanges && !saving}
            aria-label="ذخیره تغییرات"
            className={cn(
               'inline-flex w-28 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-indigo-500 px-2 text-[11px] text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-60',
               compact ? 'h-7' : 'h-8',
               !hasChanges && !saving && 'invisible pointer-events-none'
            )}
            disabled={saving || !hasChanges}
            tabIndex={hasChanges || saving ? 0 : -1}
            type="button"
            onClick={() => void saveDraft()}
         >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            ذخیره تغییرات
         </button>
      </div>
   );
}

function buildManagerTaskQuickEditPatch(source: TaskaraTask, draft: TaskaraTask): TaskUpdatePatch {
   const patch: TaskUpdatePatch = {};
   if (draft.status !== source.status) patch.status = draft.status;
   if (draft.priority !== source.priority) patch.priority = draft.priority;
   if ((draft.assignee?.id || null) !== (source.assignee?.id || null)) patch.assigneeId = draft.assignee?.id || null;
   if ((draft.project?.id || null) !== (source.project?.id || null)) {
      patch.projectId = draft.project?.id || null;
      patch.milestoneId = null;
   }
   if ((draft.dueAt || null) !== (source.dueAt || null)) patch.dueAt = draft.dueAt || null;
   return patch;
}

function applyManagerTaskQuickEditPatch(
   task: TaskaraTask,
   patch: TaskUpdatePatch,
   projects: ReturnType<typeof useWorkspaceTaskSync>['projects'],
   users: ReturnType<typeof useWorkspaceTaskSync>['users']
): TaskaraTask {
   const has = (key: keyof TaskUpdatePatch) => Object.prototype.hasOwnProperty.call(patch, key);
   const project = has('projectId')
      ? projects.find((candidate) => candidate.id === patch.projectId) || null
      : task.project;
   const assignee = has('assigneeId')
      ? users.find((candidate) => candidate.id === patch.assigneeId) || null
      : task.assignee;

   return {
      ...task,
      status: patch.status ?? task.status,
      priority: patch.priority ?? task.priority,
      dueAt: has('dueAt') ? patch.dueAt ?? null : task.dueAt,
      project,
      assignee,
      milestoneId: has('milestoneId') ? patch.milestoneId ?? null : task.milestoneId,
      milestone: has('milestoneId') && !patch.milestoneId ? null : task.milestone,
   };
}

function AttentionReasonLabels({
   compact = false,
   reasons,
}: {
   compact?: boolean;
   reasons: TaskaraAttentionItem['reason'][];
}) {
   const visibleReasons = reasons.slice(0, 3);
   const hiddenCount = Math.max(reasons.length - visibleReasons.length, 0);

   return (
      <>
         {visibleReasons.map((reason) => (
            <span
               className={cn(
                  'rounded-full border border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-white/8 dark:bg-white/[0.025]',
                  compact ? 'px-2 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'
               )}
               data-attention-reason={reason}
               key={reason}
            >
               {attentionReasonLabel(reason)}
            </span>
         ))}
         {hiddenCount ? (
            <span className="text-[10px] text-zinc-600">+{numberFormatter.format(hiddenCount)}</span>
         ) : null}
      </>
   );
}

function AttentionOpenControl({
   featured = false,
   item,
   onOpenAgenda,
   onOpenIssue,
   orgId,
}: {
   featured?: boolean;
   item: TaskaraAttentionItem;
   onOpenAgenda?: () => void;
   onOpenIssue?: () => void;
   orgId: string;
}) {
   const label = item.payload.actionLabel || fa.cockpit.openFocus;
   const className = featured
      ? 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white'
      : 'inline-flex h-8 items-center gap-1 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-white/8 dark:text-zinc-300 dark:hover:bg-white/[0.05]';

   if (item.payload.oneOnOne && onOpenAgenda) {
      return (
         <button className={className} type="button" onClick={onOpenAgenda}>
            {label}
            <ArrowUpRight className="size-3.5" />
         </button>
      );
   }

   if (item.payload.task?.key && onOpenIssue) {
      return (
         <button className={className} type="button" onClick={onOpenIssue}>
            {fa.cockpit.openFocus}
            <ArrowUpRight className="size-3.5" />
         </button>
      );
   }

   return (
      <Link className={className} to={attentionHref(item, orgId)}>
         {label}
         <ArrowUpRight className="size-3.5" />
      </Link>
   );
}

function LifecycleControls({
   disabled,
   featured = false,
   onDismiss,
   onResolve,
   onSnooze,
}: Omit<AttentionCardActions, 'onOpenAgenda' | 'onOpenIssue' | 'orgId'> & { featured?: boolean }) {
   const buttonClassName = featured
      ? 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:border-white/8 dark:text-zinc-400 dark:hover:bg-white/[0.05]'
      : 'inline-flex size-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-white/[0.05]';

   return (
      <>
         <button
            aria-label={fa.cockpit.snoozeDay}
            className={buttonClassName}
            disabled={disabled}
            title={fa.cockpit.snoozeDay}
            type="button"
            onClick={onSnooze}
         >
            <TimerReset className="size-3.5" />
            {featured ? fa.cockpit.snooze : null}
         </button>
         <button
            aria-label={fa.cockpit.resolve}
            className={cn(buttonClassName, featured && 'text-emerald-700 dark:text-emerald-300')}
            disabled={disabled}
            title={fa.cockpit.resolve}
            type="button"
            onClick={onResolve}
         >
            <CheckCircle2 className="size-3.5" />
            {featured ? fa.cockpit.resolve : null}
         </button>
         <button
            aria-label={fa.cockpit.dismiss}
            className={buttonClassName}
            disabled={disabled}
            title={fa.cockpit.dismiss}
            type="button"
            onClick={onDismiss}
         >
            <EyeOff className="size-3.5" />
            {featured ? fa.cockpit.dismiss : null}
         </button>
      </>
   );
}

function AllClearState() {
   return (
      <section className="rounded-2xl border border-emerald-300/50 bg-emerald-50 px-5 py-12 text-center dark:border-emerald-400/15 dark:bg-emerald-400/[0.06]">
         <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300">
            <CheckCircle2 className="size-5" />
         </span>
         <h2 className="mt-4 text-base font-semibold text-zinc-900 dark:text-zinc-100">{fa.cockpit.allClearTitle}</h2>
         <p className="mx-auto mt-1.5 max-w-lg text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            {fa.cockpit.allClearDescription}
         </p>
      </section>
   );
}

function OneOnOneAgendaDialog({
   item,
   onClose,
   orgId,
}: {
   item: TaskaraAttentionItem | null;
   onClose: () => void;
   orgId: string;
}) {
   const [agenda, setAgenda] = useState<TaskaraOneOnOneAgendaResponse | null>(null);
   const [actionItems, setActionItems] = useState<TaskaraMeetingActionItem[]>([]);
   const [loading, setLoading] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [persistingKey, setPersistingKey] = useState<string | null>(null);
   const [actionItemPendingId, setActionItemPendingId] = useState<string | null>(null);
   const oneOnOne = item?.payload.oneOnOne;

   useEffect(() => {
      if (!item || !oneOnOne) {
         setAgenda(null);
         setActionItems([]);
         setError(null);
         return;
      }

      let cancelled = false;
      const load = async () => {
         setLoading(true);
         setError(null);
         try {
            const [result, actionItemResult] = await Promise.all([
               taskaraRequest<TaskaraOneOnOneAgendaResponse>(`/one-on-ones/${encodeURIComponent(oneOnOne.id)}/agenda`),
               taskaraRequest<TaskaraMeetingActionItemListResponse>(
                  `/meeting-action-items?assigneeId=${encodeURIComponent(oneOnOne.participantId)}&status=OPEN&limit=12`
               ).catch(() => ({ items: [], total: 0, limit: 12, offset: 0 })),
            ]);
            const pendingMutations = await loadPendingTaskSyncMutations();
            if (cancelled) return;
            const pendingActionItems = applyPendingMeetingActionItemMutations(actionItemResult.items, pendingMutations);
            setAgenda(
               applyPendingCarryForwardAgendaMutations(
                  applyPendingAgendaItemMutations(result, pendingMutations),
                  pendingActionItems,
                  pendingMutations
               )
            );
            setActionItems(pendingActionItems);
         } catch (loadError) {
            if (!cancelled) {
               setError(loadError instanceof Error ? loadError.message : fa.cockpit.syncActionFailed);
            }
         } finally {
            if (!cancelled) setLoading(false);
         }
      };
      void load();

      return () => {
         cancelled = true;
      };
   }, [item, oneOnOne]);

   async function updateActionItem(actionItem: TaskaraMeetingActionItem, action: 'complete' | 'carry' | 'task') {
      if (!agenda) return;
      setActionItemPendingId(`${action}:${actionItem.id}`);
      try {
         if (action === 'complete') {
            setActionItems((current) => current.filter((candidate) => candidate.id !== actionItem.id));
            const { entity: updated } = await sendTaskSyncMutation<TaskaraMeetingActionItem>(
               'meeting_action_item.complete',
               { id: actionItem.id },
               undefined,
               undefined,
               { keepPendingOnRetryable: true }
            );
            if (!updated) throw new Error(fa.cockpit.syncActionFailed);
            toast.success(fa.cockpit.actionItemCompleted);
            return;
         }

         if (action === 'carry') {
            const { entity: result } = await sendTaskSyncMutation<{
               actionItem: TaskaraMeetingActionItem;
               agendaItem: TaskaraOneOnOneAgendaResponse['items'][number];
            }>(
               'meeting_action_item.carry_forward',
               { id: actionItem.id, carry: { seriesId: agenda.series.id } },
               undefined,
               undefined,
               { keepPendingOnRetryable: true }
            );
            if (!result) throw new Error(fa.cockpit.syncActionFailed);
            setAgenda((current) =>
               !current || current.items.some((candidate) => candidate.id === result.agendaItem.id)
                  ? current
                  : { ...current, items: [...current.items, result.agendaItem] }
            );
            toast.success(fa.cockpit.actionItemCarried);
            return;
         }

         const { entity: result } = await sendTaskSyncMutation<{
            actionItem: TaskaraMeetingActionItem;
            task: TaskaraTask;
         }>(
            'meeting_action_item.create_task',
            { id: actionItem.id, task: {} },
            undefined,
            undefined,
            { keepPendingOnRetryable: true }
         );
         if (!result) throw new Error(fa.cockpit.syncActionFailed);
         setActionItems((current) => current.filter((candidate) => candidate.id !== result.actionItem.id));
         toast.success(fa.cockpit.actionItemTaskCreated(result.task.key));
      } catch (actionError) {
         if (isRetryableTaskSyncError(actionError)) {
            if (action === 'carry') {
               setAgenda((current) =>
                  current
                     ? applyPendingCarryForwardAgendaMutations(
                          current,
                          [actionItem],
                          [{
                             name: 'meeting_action_item.carry_forward',
                             args: { id: actionItem.id, carry: { seriesId: current.series.id } },
                             createdAt: new Date().toISOString(),
                          }]
                       )
                     : current
               );
            }
            toast.message(fa.cockpit.actionQueued);
            return;
         }
         if (action === 'complete') {
            setActionItems((current) => current.some((candidate) => candidate.id === actionItem.id) ? current : [actionItem, ...current]);
         }
         toast.error(actionError instanceof Error ? actionError.message : fa.cockpit.syncActionFailed);
      } finally {
         setActionItemPendingId(null);
      }
   }

   async function persistGeneratedItem(generated: TaskaraOneOnOneAgendaResponse['generated'][number]) {
      if (!agenda) return;
      const key = `${generated.sourceType}:${generated.sourceId}`;
      setPersistingKey(key);
      try {
         const { entity: created } = await sendTaskSyncMutation<TaskaraOneOnOneAgendaResponse['items'][number]>(
            'one_on_one_agenda_item.create',
            {
               seriesId: agenda.series.id,
               item: {
                  title: generated.title,
                  notes: generated.notes || undefined,
                  sourceType: generated.sourceType,
                  sourceId: generated.sourceId,
               },
            },
            undefined,
            undefined,
            { keepPendingOnRetryable: true }
         );
         if (!created) throw new Error(fa.cockpit.syncActionFailed);
         setAgenda((current) =>
            current
               ? {
                    ...current,
                    items: [...current.items, created],
                    generated: current.generated.filter((candidate) => `${candidate.sourceType}:${candidate.sourceId}` !== key),
                 }
               : current
         );
      } catch (actionError) {
         if (isRetryableTaskSyncError(actionError)) {
            toast.message(fa.cockpit.actionQueued);
            setAgenda((current) =>
               current
                  ? { ...current, generated: current.generated.filter((candidate) => `${candidate.sourceType}:${candidate.sourceId}` !== key) }
                  : current
            );
            return;
         }
         toast.error(actionError instanceof Error ? actionError.message : fa.cockpit.syncActionFailed);
      } finally {
         setPersistingKey(null);
      }
   }

   return (
      <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
         <DialogContent className="max-w-2xl [direction:rtl]">
            <DialogHeader>
               <DialogTitle>{oneOnOne ? fa.cockpit.oneOnOneWith(oneOnOne.participantName) : fa.cockpit.syncs}</DialogTitle>
               <DialogDescription>{fa.cockpit.agendaDescription}</DialogDescription>
            </DialogHeader>
            {loading ? <LinearEmptyState>{fa.app.loading}</LinearEmptyState> : null}
            {error ? (
               <p className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>
            ) : null}
            {agenda && !loading ? (
               <div className="mt-3 grid max-h-[60vh] gap-4 overflow-y-auto pe-1">
                  {agenda.items.length ? (
                     <div className="rounded-lg border border-white/8">
                        {agenda.items.map((agendaItem) => (
                           <div key={agendaItem.id} className="border-b border-white/7 px-3 py-2 last:border-b-0">
                              <div className="text-sm font-medium text-zinc-100">{agendaItem.title}</div>
                              {agendaItem.notes ? <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-500">{agendaItem.notes}</div> : null}
                           </div>
                        ))}
                     </div>
                  ) : null}

                  <AgendaSection title={fa.cockpit.openActionItems}>
                     {actionItems.length ? (
                        <div className="rounded-lg border border-white/8">
                           {actionItems.map((actionItem) => {
                              const itemPending = actionItemPendingId?.endsWith(`:${actionItem.id}`) ?? false;
                              return (
                                 <div key={actionItem.id} className="border-b border-white/7 px-3 py-2.5 last:border-b-0">
                                    <div className="flex min-w-0 flex-wrap items-start gap-3">
                                       <div className="min-w-0 flex-1">
                                          <div className="truncate text-sm font-medium text-zinc-100">{actionItem.title}</div>
                                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                                             <span>{actionItem.meeting?.title || fa.meeting.title}</span>
                                             {actionItem.dueAt ? <span>{formatJalaliDate(actionItem.dueAt)}</span> : null}
                                             {actionItem.task ? (
                                                <Link className="ltr text-zinc-300 hover:text-zinc-100" to={`/${orgId}/issue/${encodeURIComponent(actionItem.task.key)}`}>
                                                   {actionItem.task.key}
                                                </Link>
                                             ) : null}
                                          </div>
                                       </div>
                                       <div className="flex flex-wrap gap-1.5">
                                          <AgendaActionButton
                                             disabled={itemPending}
                                             icon={CheckCircle2}
                                             label={fa.cockpit.completeActionItem}
                                             loading={actionItemPendingId === `complete:${actionItem.id}`}
                                             onClick={() => void updateActionItem(actionItem, 'complete')}
                                          />
                                          <AgendaActionButton
                                             disabled={itemPending}
                                             icon={ListChecks}
                                             label={fa.cockpit.carryForwardActionItem}
                                             loading={actionItemPendingId === `carry:${actionItem.id}`}
                                             onClick={() => void updateActionItem(actionItem, 'carry')}
                                          />
                                          {!actionItem.task ? (
                                             <AgendaActionButton
                                                disabled={itemPending}
                                                icon={CircleDot}
                                                label={fa.cockpit.createLinkedTask}
                                                loading={actionItemPendingId === `task:${actionItem.id}`}
                                                onClick={() => void updateActionItem(actionItem, 'task')}
                                             />
                                          ) : null}
                                       </div>
                                    </div>
                                 </div>
                              );
                           })}
                        </div>
                     ) : (
                        <LinearEmptyState>{fa.cockpit.noOpenActionItems}</LinearEmptyState>
                     )}
                  </AgendaSection>

                  <AgendaSection title={fa.cockpit.generatedAgenda}>
                     {agenda.generated.length ? (
                        <div className="grid gap-2">
                           {agenda.generated.map((generated) => {
                              const key = `${generated.sourceType}:${generated.sourceId}`;
                              return (
                                 <div key={key} className="rounded-lg border border-white/8 bg-white/[0.025] p-3">
                                    <div className="flex min-w-0 items-start gap-2">
                                       <span className={cn('mt-1.5 size-2 rounded-full', severityRailClasses[generated.severity])} />
                                       <div className="min-w-0 flex-1">
                                          <div className="text-sm font-medium text-zinc-100">{generated.title}</div>
                                          {generated.notes ? <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-500">{generated.notes}</div> : null}
                                       </div>
                                       <AgendaActionButton
                                          disabled={persistingKey === key}
                                          icon={CheckCircle2}
                                          label={fa.cockpit.addToAgenda}
                                          loading={persistingKey === key}
                                          onClick={() => void persistGeneratedItem(generated)}
                                       />
                                    </div>
                                 </div>
                              );
                           })}
                        </div>
                     ) : (
                        <LinearEmptyState>{fa.cockpit.noGeneratedAgenda}</LinearEmptyState>
                     )}
                  </AgendaSection>
               </div>
            ) : null}
         </DialogContent>
      </Dialog>
   );
}

function AgendaSection({ children, title }: { children: ReactNode; title: string }) {
   return (
      <section className="grid gap-2">
         <h3 className="text-xs font-medium text-zinc-500">{title}</h3>
         {children}
      </section>
   );
}

function AgendaActionButton({
   disabled,
   icon: Icon,
   label,
   loading,
   onClick,
}: {
   disabled: boolean;
   icon: typeof CircleDot;
   label: string;
   loading: boolean;
   onClick: () => void;
}) {
   return (
      <button
         className="inline-flex h-7 items-center gap-1 rounded-md border border-white/8 px-2 text-xs text-zinc-300 hover:bg-white/[0.05] disabled:opacity-45"
         disabled={disabled}
         type="button"
         onClick={onClick}
      >
         {loading ? <RefreshCw className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
         {label}
      </button>
   );
}

function groupAttentionItems(items: TaskaraAttentionItem[]): ManagerQueueItem[] {
   const grouped = new Map<string, ManagerQueueItem>();

   for (const item of items) {
      const id = managerAttentionGroupKey(item);
      const current = grouped.get(id);
      if (!current) {
         grouped.set(id, {
            id,
            items: [item],
            primary: item,
            reasons: [item.reason],
            severity: item.severity,
         });
         continue;
      }

      current.items.push(item);
      if (!current.reasons.includes(item.reason)) current.reasons.push(item.reason);
      if (severityRank[item.severity] > severityRank[current.severity]) {
         current.primary = item;
         current.severity = item.severity;
      }
   }

   return [...grouped.values()].sort((left, right) => {
      const severityDifference = severityRank[right.severity] - severityRank[left.severity];
      if (severityDifference) return severityDifference;
      return Date.parse(right.primary.lastSeenAt) - Date.parse(left.primary.lastSeenAt);
   });
}

function attentionHref(item: TaskaraAttentionItem, orgId: string) {
   const payload = item.payload || {};
   if (item.reason === 'backlog_triage') return `/${orgId}/queues`;
   if (payload.task?.key) return `/${orgId}/issue/${encodeURIComponent(payload.task.key)}`;
   if (payload.project) return `/${orgId}/projects`;
   if (payload.actionItem) return `/${orgId}/meetings/${encodeURIComponent(payload.actionItem.meetingId)}`;
   if (payload.user) return `/${orgId}/people?person=${encodeURIComponent(payload.user.id)}`;
   return `/${orgId}/members`;
}

function attentionIssueTaskKey(item: TaskaraAttentionItem): string | null {
   if (item.reason === 'backlog_triage') return null;
   return item.payload.task?.key || null;
}

function attentionReasonLabel(reason: TaskaraAttentionItem['reason']) {
   return reasonLabels[reason] || fa.cockpit.attention;
}

const reasonLabels: Record<string, string> = {
   overdue_task: fa.cockpit.overdue,
   blocked_task: fa.cockpit.blocked,
   review_waiting: fa.cockpit.reviews,
   backlog_triage: fa.decisionQueues.backlogQueue,
   stale_task: fa.cockpit.stale,
   unassigned_due_soon: fa.cockpit.unassignedTasks,
   overloaded_person: fa.cockpit.overloaded,
   person_without_active_work: fa.cockpit.idle,
   project_at_risk: fa.cockpit.focusProjects,
   project_update_due: fa.cockpit.projectHealth,
   missing_check_in: fa.peopleWorkload.missingCheckIn,
   one_on_one_due: fa.peopleWorkload.oneOnOneDue,
   stale_meeting_action_item: fa.cockpit.openActionItems,
};

const severityLabels = {
   LOW: 'کم',
   MEDIUM: 'متوسط',
   HIGH: 'زیاد',
   URGENT: 'فوری',
};

const severityRank = {
   LOW: 0,
   MEDIUM: 1,
   HIGH: 2,
   URGENT: 3,
};

const severityBadgeClasses = {
   LOW: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-400',
   MEDIUM: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200',
   HIGH: 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-400/20 dark:bg-orange-400/10 dark:text-orange-200',
   URGENT: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200',
};

const severityBorderClasses = {
   LOW: 'border-zinc-200 dark:border-white/8',
   MEDIUM: 'border-amber-300/70 dark:border-amber-400/20',
   HIGH: 'border-orange-300/70 dark:border-orange-400/20',
   URGENT: 'border-rose-300/70 dark:border-rose-400/25',
};

const severityRailClasses = {
   LOW: 'bg-zinc-500',
   MEDIUM: 'bg-amber-400',
   HIGH: 'bg-orange-400',
   URGENT: 'bg-rose-400',
};

function cockpitRefreshSourceMatches(detail: WorkspaceRefreshDetail) {
   return (
      workspaceRefreshSourceMatches(detail, 'attention') ||
      workspaceRefreshSourceMatches(detail, 'check-in') ||
      workspaceRefreshSourceMatches(detail, 'meeting') ||
      workspaceRefreshSourceMatches(detail, 'project') ||
      workspaceRefreshSourceMatches(detail, 'task') ||
      workspaceRefreshSourceMatches(detail, 'task-sync-mutation') ||
      workspaceRefreshSourceMatches(detail, 'team') ||
      workspaceRefreshSourceMatches(detail, 'workspace')
   );
}
