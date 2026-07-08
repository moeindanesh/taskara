'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
   AlertTriangle,
   ArrowUpRight,
   Blocks,
   CalendarPlus,
   CheckCircle2,
   CircleDot,
   Clock3,
   EyeOff,
   Inbox,
   ListChecks,
   RefreshCw,
   ScanEye,
   TimerReset,
   UserRoundCheck,
   Users,
} from 'lucide-react';
import {
   LinearAvatar,
   LinearEmptyState,
   LinearPanel,
   ProjectGlyph,
   StatusIcon,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { IssueTitleTooltip } from '@/components/taskara/issue-title-tooltip';
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
import { formatJalaliDate, formatJalaliDateTime } from '@/lib/jalali';
import { useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { isRetryableTaskSyncError, loadPendingTaskSyncMutations, sendTaskSyncMutation } from '@/lib/task-sync';
import { taskaraRequest } from '@/lib/taskara-client';
import {
   applyPendingAttentionAction,
   applyPendingAttentionMutations,
   applyPendingAgendaItemMutations,
   applyPendingCarryForwardAgendaMutations,
   applyPendingMeetingActionItemMutations,
   applyPendingOneOnOneMutations,
   type PendingAttentionAction,
} from '@/lib/workspace-data/pending';
import type {
   TaskaraAttentionItem,
   TaskaraAttentionResponse,
   TaskaraCheckInMissingResponse,
   TaskaraMeetingActionItem,
   TaskaraMeetingActionItemListResponse,
   TaskaraOneOnOneAgendaResponse,
   TaskaraOneOnOneSeries,
   TaskaraTask,
   WorkHealthPerson,
   WorkHealthProject,
   WorkHealthSummary,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const numberFormatter = new Intl.NumberFormat('fa-IR');

export function ManagerCockpitView() {
   const { orgId } = useParams();
   const workspaceSlug = orgId || 'taskara';
   const [summary, setSummary] = useState<WorkHealthSummary | null>(null);
   const [attention, setAttention] = useState<TaskaraAttentionResponse | null>(null);
   const [missingCheckIns, setMissingCheckIns] = useState<TaskaraCheckInMissingResponse | null>(null);
   const [oneOnOnes, setOneOnOnes] = useState<TaskaraOneOnOneSeries[]>([]);
   const [loading, setLoading] = useState(true);
   const [refreshing, setRefreshing] = useState(false);
   const [error, setError] = useState<string | null>(null);

   const loadSummary = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      setError(null);

      try {
         const [data, attentionData, missingData, oneOnOneData] = await Promise.all([
            taskaraRequest<WorkHealthSummary>('/work-health/summary'),
            taskaraRequest<TaskaraAttentionResponse>('/attention?limit=24'),
            taskaraRequest<TaskaraCheckInMissingResponse>('/check-ins/missing?hours=24').catch(() => null),
            taskaraRequest<{ items: TaskaraOneOnOneSeries[] }>('/one-on-ones?active=true&limit=50').catch(() => ({ items: [] })),
         ]);
         const pendingMutations = await loadPendingTaskSyncMutations();
         const people = [
            ...data.people.map((person) => person.user),
            ...(missingData?.items || []).map((item) => item.user),
         ];
         setSummary(data);
         setAttention(applyPendingAttentionMutations(attentionData, pendingMutations));
         setMissingCheckIns(missingData);
         setOneOnOnes(applyPendingOneOnOneMutations(oneOnOneData.items, pendingMutations, people));
      } catch (loadError) {
         setError(loadError instanceof Error ? loadError.message : fa.cockpit.loadFailed);
      } finally {
         setLoading(false);
         setRefreshing(false);
      }
   }, []);

   useEffect(() => {
      let cancelled = false;
      const run = async () => {
         if (cancelled) return;
         await loadSummary('initial');
      };
      void run();
      return () => {
         cancelled = true;
      };
   }, [loadSummary]);

   useLiveRefresh(() => loadSummary('refresh'), {
      fireOnMount: false,
      workspaceEventFilter: cockpitRefreshSourceMatches,
   });

   const overview = summary?.overview;
   const metrics = useMemo(
      () => [
         { label: fa.cockpit.activeWork, value: overview?.activeTasks || 0, icon: CircleDot, tone: 'indigo' as const },
         { label: fa.cockpit.attention, value: attention?.total || 0, icon: ScanEye, tone: 'amber' as const },
         { label: fa.cockpit.overdue, value: overview?.overdueTasks || 0, icon: AlertTriangle, tone: 'rose' as const },
         { label: fa.cockpit.blocked, value: overview?.blockedTasks || 0, icon: Blocks, tone: 'zinc' as const },
         { label: fa.cockpit.reviews, value: overview?.reviewTasks || 0, icon: UserRoundCheck, tone: 'sky' as const },
         { label: fa.cockpit.overloaded, value: overview?.overloadedPeople || 0, icon: Users, tone: 'rose' as const },
      ],
      [attention?.total, overview]
   );

   return (
      <div className="flex h-full flex-col bg-background dark:bg-[#101011]" data-testid="manager-cockpit-screen">
         <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
            <div className="mx-auto max-w-[1440px]">
               <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                     {summary?.generatedAt ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.025] px-2 py-1">
                           <Clock3 className="size-3.5" />
                           {fa.cockpit.generatedAt}: {formatJalaliDateTime(summary.generatedAt)}
                        </span>
                     ) : null}
                     {summary?.overview.truncated ? (
                        <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-amber-200">
                           {fa.cockpit.truncated}
                        </span>
                     ) : null}
                  </div>
                  <button
                     className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.035] px-2.5 text-xs font-medium text-zinc-300 hover:bg-white/[0.06]"
                     type="button"
                     onClick={() => void loadSummary('refresh')}
                  >
                     <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                     {fa.cockpit.refresh}
                  </button>
               </div>

               {error ? (
                  <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
                     {error}
                  </p>
               ) : null}

               {loading && !summary ? (
                  <LinearEmptyState>{fa.app.loading}</LinearEmptyState>
               ) : summary ? (
                  <>
                     <section className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
                        {metrics.map((metric) => (
                           <MetricTile key={metric.label} {...metric} />
                        ))}
                     </section>

                     <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
                        <AttentionPanel
                           items={attention?.items || []}
                           onApply={(item, action) => {
                              setAttention((current) => current ? applyPendingAttentionAction(current, item, action) : current);
                           }}
                           onRefresh={() => void loadSummary('refresh')}
                           orgId={workspaceSlug}
                        />
                        <PeoplePanel people={summary.people} orgId={workspaceSlug} />
                     </section>

                     <section className="mt-4 grid gap-4 xl:grid-cols-3">
                        <TaskQueuePanel
                           empty={fa.cockpit.noQueueItems}
                           icon={UserRoundCheck}
                           orgId={workspaceSlug}
                           tasks={summary.queues.review}
                           title={fa.cockpit.reviews}
                        />
                        <TaskQueuePanel
                           empty={fa.cockpit.noQueueItems}
                           icon={Blocks}
                           orgId={workspaceSlug}
                           tasks={[...summary.queues.blocked, ...summary.queues.overdue].slice(0, 24)}
                           title={fa.cockpit.blockers}
                        />
                        <TaskQueuePanel
                           empty={fa.cockpit.noQueueItems}
                           icon={Inbox}
                           orgId={workspaceSlug}
                           tasks={[...summary.queues.unassigned, ...summary.queues.backlog].slice(0, 24)}
                           title={fa.cockpit.unassigned}
                        />
                     </section>

                     <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.2fr)]">
                        <SyncPanel
                           orgId={workspaceSlug}
                           missingCheckIns={missingCheckIns}
                           onRefresh={() => void loadSummary('refresh')}
                           oneOnOnes={oneOnOnes}
                        />
                        <ProjectHealthPanel orgId={workspaceSlug} projects={summary.projects} />
                     </section>
                  </>
               ) : null}
            </div>
         </div>
      </div>
   );
}

function MetricTile({
   icon: Icon,
   label,
   tone,
   value,
}: {
   icon: typeof CircleDot;
   label: string;
   tone: 'amber' | 'indigo' | 'rose' | 'sky' | 'zinc';
   value: number;
}) {
   return (
      <div className="rounded-lg border border-white/8 bg-[#19191b] px-3 py-3">
         <div className="flex items-center justify-between gap-2">
            <span className={cn('inline-flex size-7 items-center justify-center rounded-md border', metricToneClasses[tone])}>
               <Icon className="size-3.5" />
            </span>
            <span className="text-xl font-semibold text-zinc-100">{numberFormatter.format(value)}</span>
         </div>
         <div className="mt-2 truncate text-xs text-zinc-500">{label}</div>
      </div>
   );
}

function AttentionPanel({
   items,
   onApply,
   onRefresh,
   orgId,
}: {
   items: TaskaraAttentionItem[];
   onApply: (item: TaskaraAttentionItem, action: PendingAttentionAction) => void;
   onRefresh: () => void;
   orgId: string;
}) {
   const [pendingId, setPendingId] = useState<string | null>(null);
   const [dismissTarget, setDismissTarget] = useState<TaskaraAttentionItem | null>(null);
   const [dismissReason, setDismissReason] = useState('');

   const runAction = useCallback(
      async (item: TaskaraAttentionItem, action: 'snooze' | 'resolve') => {
         setPendingId(item.id);
         const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
         onApply(item, action === 'snooze' ? { type: 'snooze', snoozedUntil } : { type: 'resolve' });
         try {
            if (action === 'snooze') {
               await sendTaskSyncMutation<TaskaraAttentionItem>('attention.snooze', { id: item.id, snoozedUntil }, undefined, undefined, {
                  keepPendingOnRetryable: true,
               });
            } else {
               await sendTaskSyncMutation<TaskaraAttentionItem>('attention.resolve', { id: item.id }, undefined, undefined, {
                  keepPendingOnRetryable: true,
               });
            }
            onRefresh();
         } catch (actionError) {
            if (isRetryableTaskSyncError(actionError)) {
               toast.message(fa.cockpit.actionQueued);
               return;
            }
            toast.error(actionError instanceof Error ? actionError.message : fa.cockpit.actionFailed);
            onRefresh();
         } finally {
            setPendingId(null);
         }
      },
      [onApply, onRefresh]
   );

   async function submitDismiss(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const reason = dismissReason.trim();
      if (!dismissTarget || reason.length < 3) return;
      setPendingId(dismissTarget.id);
      onApply(dismissTarget, { type: 'dismiss', reason });
      try {
         await sendTaskSyncMutation<TaskaraAttentionItem>('attention.dismiss', { id: dismissTarget.id, reason }, undefined, undefined, {
            keepPendingOnRetryable: true,
         });
         setDismissTarget(null);
         setDismissReason('');
         onRefresh();
      } catch (actionError) {
         if (isRetryableTaskSyncError(actionError)) {
            toast.message(fa.cockpit.actionQueued);
            setDismissTarget(null);
            setDismissReason('');
            return;
         }
         toast.error(actionError instanceof Error ? actionError.message : fa.cockpit.actionFailed);
         onRefresh();
      } finally {
         setPendingId(null);
      }
   }

   return (
      <>
         <LinearPanel
            title={<PanelTitle count={items.length} icon={ScanEye} label={fa.cockpit.attention} />}
            className="overflow-hidden"
         >
            {items.length === 0 ? (
               <div className="p-4">
                  <LinearEmptyState>{fa.cockpit.noAttention}</LinearEmptyState>
               </div>
            ) : (
               <div className="divide-y divide-white/7">
                  {items.map((item) => (
                     <AttentionRow
                        disabled={pendingId === item.id}
                        item={item}
                        key={item.id}
                        onDismiss={() => {
                           setDismissTarget(item);
                           setDismissReason('');
                        }}
                        onResolve={() => void runAction(item, 'resolve')}
                        onSnooze={() => void runAction(item, 'snooze')}
                        orgId={orgId}
                     />
                  ))}
               </div>
            )}
         </LinearPanel>
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
      </>
   );
}

function AttentionRow({
   disabled,
   item,
   onDismiss,
   onResolve,
   onSnooze,
   orgId,
}: {
   disabled: boolean;
   item: TaskaraAttentionItem;
   onDismiss: () => void;
   onResolve: () => void;
   onSnooze: () => void;
   orgId: string;
}) {
   const payload = item.payload || {};
   const task = payload.task;
   const project = payload.project;
   const oneOnOne = payload.oneOnOne;
   const actionItem = payload.actionItem;
   const title = payload.title || item.reason;
   const description = payload.description || item.reason;
   const actionLabel = payload.actionLabel || (task ? fa.cockpit.openTask : project ? fa.nav.projects : oneOnOne || actionItem ? fa.nav.meetings : fa.cockpit.openMembers);
   const to = task?.key
      ? `/${orgId}/issue/${encodeURIComponent(task.key)}`
      : project
        ? `/${orgId}/projects`
        : oneOnOne || actionItem
          ? `/${orgId}/meetings`
          : `/${orgId}/members`;

   return (
      <div className="grid gap-2 px-3 py-3 hover:bg-white/[0.025] md:grid-cols-[120px_minmax(0,1fr)_auto]">
         <Link className="flex items-center gap-2" to={to}>
            <span className={cn('size-2 rounded-full', severityDotClasses[item.severity])} />
            <span className="text-xs font-medium text-zinc-400">{severityLabels[item.severity]}</span>
         </Link>
         <Link className="min-w-0" to={to}>
            <div className="flex min-w-0 items-center gap-2">
               {task ? (
                  <StatusIcon status={task.status} className="size-3.5" />
               ) : project ? (
                  <ProjectGlyph name={project.name} className="size-4 rounded-sm" iconClassName="size-3" />
               ) : oneOnOne || actionItem ? (
                  <ListChecks className="size-3.5 text-zinc-500" />
               ) : (
                  <Users className="size-3.5 text-zinc-500" />
               )}
               <span className="truncate text-sm font-medium text-zinc-200">{title}</span>
            </div>
            <div className="mt-1 truncate text-xs text-zinc-500">{description}</div>
         </Link>
         <div className="flex items-center justify-start gap-1 md:justify-end">
            <Link className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200" to={to}>
               {actionLabel}
               <ArrowUpRight className="size-3.5" />
            </Link>
            <button
               className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.05] hover:text-amber-200 disabled:opacity-40"
               disabled={disabled}
               title={fa.cockpit.snoozeDay}
               type="button"
               onClick={onSnooze}
            >
               <TimerReset className="size-3.5" />
            </button>
            <button
               className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.05] hover:text-emerald-200 disabled:opacity-40"
               disabled={disabled}
               title={fa.cockpit.resolve}
               type="button"
               onClick={onResolve}
            >
               <CheckCircle2 className="size-3.5" />
            </button>
            <button
               className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-40"
               disabled={disabled}
               title={fa.cockpit.dismiss}
               type="button"
               onClick={onDismiss}
            >
               <EyeOff className="size-3.5" />
            </button>
         </div>
      </div>
   );
}

function PeoplePanel({ people, orgId }: { people: WorkHealthPerson[]; orgId: string }) {
   return (
      <LinearPanel title={<PanelTitle count={people.length} icon={Users} label={fa.cockpit.workload} />} className="overflow-hidden">
         {people.length === 0 ? (
            <div className="p-4">
               <LinearEmptyState>{fa.app.empty}</LinearEmptyState>
            </div>
         ) : (
            <div className="max-h-[620px] divide-y divide-white/7 overflow-y-auto">
               {people.map((person) => (
                  <PersonRow key={person.user.id} orgId={orgId} person={person} />
               ))}
            </div>
         )}
      </LinearPanel>
   );
}

function PersonRow({ orgId, person }: { orgId: string; person: WorkHealthPerson }) {
   const progress = Math.min(person.loadRatio * 100, 100);

   return (
      <div className="px-3 py-3">
         <Link className="flex min-w-0 items-center gap-2.5" to={`/${orgId}/people?person=${encodeURIComponent(person.user.id)}`}>
            <LinearAvatar name={person.user.name} src={person.user.avatarUrl} className="size-7" />
            <div className="min-w-0 flex-1">
               <div className="truncate text-sm font-medium text-zinc-200">{person.user.name}</div>
               <div className="ltr truncate text-[11px] text-zinc-500">{person.user.email}</div>
            </div>
            <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', workloadBadgeClasses[person.status])}>
               {workloadLabels[person.status]}
            </span>
         </Link>
         <div className="mt-2">
            <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
               <span>{fa.cockpit.weightOfCapacity(person.activeWeight, person.capacity)}</span>
               <span>{fa.cockpit.taskCount(person.activeCount)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/7">
               <div className={cn('h-full rounded-full', workloadBarClasses[person.status])} style={{ width: `${progress}%` }} />
            </div>
         </div>
         {person.tasks.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
               {person.tasks.slice(0, 3).map((task) => (
                  <Link
                     key={task.id}
                     className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.025] px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-200"
                     to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}
                  >
                     <StatusIcon status={task.status} className="size-3" />
                     <IssueTitleTooltip title={task.title}>
                        <span className="truncate">{task.title}</span>
                     </IssueTitleTooltip>
                  </Link>
               ))}
            </div>
         ) : null}
      </div>
   );
}

function TaskQueuePanel({
   empty,
   icon,
   orgId,
   tasks,
   title,
}: {
   empty: string;
   icon: typeof UserRoundCheck;
   orgId: string;
   tasks: TaskaraTask[];
   title: string;
}) {
   return (
      <LinearPanel title={<PanelTitle count={tasks.length} icon={icon} label={title} />} className="overflow-hidden">
         {tasks.length === 0 ? (
            <div className="p-4">
               <LinearEmptyState>{empty}</LinearEmptyState>
            </div>
         ) : (
            <div className="divide-y divide-white/7">
               {tasks.map((task) => (
                  <TaskQueueRow key={task.id} orgId={orgId} task={task} />
               ))}
            </div>
         )}
      </LinearPanel>
   );
}

function TaskQueueRow({ orgId, task }: { orgId: string; task: TaskaraTask }) {
   const statusLabel = linearStatusMeta[task.status]?.label || task.status;

   return (
      <Link className="block px-3 py-2.5 hover:bg-white/[0.025]" to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}>
         <div className="flex min-w-0 items-center gap-2">
            <StatusIcon status={task.status} className="size-3.5" />
            <span className="ltr shrink-0 text-[11px] font-medium text-zinc-500">{task.key}</span>
            <IssueTitleTooltip title={task.title}>
               <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{task.title}</span>
            </IssueTitleTooltip>
         </div>
         <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
            <span>{statusLabel}</span>
            <span>{task.dueAt ? formatJalaliDate(task.dueAt) : fa.app.noDate}</span>
            <span className="flex min-w-0 items-center gap-1">
               <ProjectGlyph name={task.project?.name} className="size-3.5 rounded-sm" iconClassName="size-2.5" />
               <span className="min-w-0 truncate">{task.project?.name || fa.app.unset}</span>
            </span>
         </div>
      </Link>
   );
}

function SyncPanel({
   orgId,
   missingCheckIns,
   oneOnOnes,
   onRefresh,
}: {
   orgId: string;
   missingCheckIns: TaskaraCheckInMissingResponse | null;
   oneOnOnes: TaskaraOneOnOneSeries[];
   onRefresh: () => void;
}) {
   const [pendingUserId, setPendingUserId] = useState<string | null>(null);
   const [agenda, setAgenda] = useState<TaskaraOneOnOneAgendaResponse | null>(null);
   const [actionItems, setActionItems] = useState<TaskaraMeetingActionItem[]>([]);
   const [agendaLoadingId, setAgendaLoadingId] = useState<string | null>(null);
   const [persistingKey, setPersistingKey] = useState<string | null>(null);
   const [actionItemPendingId, setActionItemPendingId] = useState<string | null>(null);
   const missingItems = missingCheckIns?.items || [];
   const missingUserIds = new Set(missingItems.map((item) => item.user.id));
   const dueSeries = oneOnOnes
      .filter((series) => !series.nextScheduledAt || new Date(series.nextScheduledAt).getTime() <= Date.now() + 7 * 24 * 60 * 60 * 1000)
      .filter((series) => !missingUserIds.has(series.participantId))
      .slice(0, 8);

   async function createSeries(userId: string) {
      setPendingUserId(userId);
      try {
         const { entity: created } = await sendTaskSyncMutation<TaskaraOneOnOneSeries>('one_on_one.create', {
            participantId: userId,
            cadenceDays: 14,
         }, undefined, undefined, {
            keepPendingOnRetryable: true,
         });
         if (!created) throw new Error(fa.cockpit.syncActionFailed);
         onRefresh();
         await openAgenda(created);
      } catch (error) {
         if (isRetryableTaskSyncError(error)) {
            toast.message(fa.cockpit.actionQueued);
            return;
         }
         toast.error(error instanceof Error ? error.message : fa.cockpit.syncActionFailed);
      } finally {
         setPendingUserId(null);
      }
   }

   async function openAgenda(series: TaskaraOneOnOneSeries) {
      setAgendaLoadingId(series.id);
      try {
         const [result, actionItemResult] = await Promise.all([
            taskaraRequest<TaskaraOneOnOneAgendaResponse>(`/one-on-ones/${encodeURIComponent(series.id)}/agenda`),
            taskaraRequest<TaskaraMeetingActionItemListResponse>(
               `/meeting-action-items?assigneeId=${encodeURIComponent(series.participantId)}&status=OPEN&limit=12`
            ).catch(() => ({ items: [], total: 0, limit: 12, offset: 0 })),
         ]);
         const pendingMutations = await loadPendingTaskSyncMutations();
         const pendingActionItems = applyPendingMeetingActionItemMutations(actionItemResult.items, pendingMutations);
         setAgenda(applyPendingCarryForwardAgendaMutations(applyPendingAgendaItemMutations(result, pendingMutations), pendingActionItems, pendingMutations));
         setActionItems(pendingActionItems);
      } catch (error) {
         toast.error(error instanceof Error ? error.message : fa.cockpit.syncActionFailed);
      } finally {
         setAgendaLoadingId(null);
      }
   }

   async function updateActionItem(actionItem: TaskaraMeetingActionItem, action: 'complete' | 'carry' | 'task') {
      if (!agenda) return;
      setActionItemPendingId(`${action}:${actionItem.id}`);
      try {
         if (action === 'complete') {
            setActionItems((current) => current.filter((item) => item.id !== actionItem.id));
            const { entity: updated } = await sendTaskSyncMutation<TaskaraMeetingActionItem>('meeting_action_item.complete', {
               id: actionItem.id,
            }, undefined, undefined, {
               keepPendingOnRetryable: true,
            });
            if (!updated) throw new Error(fa.cockpit.syncActionFailed);
            setActionItems((current) => current.filter((item) => item.id !== updated.id));
            toast.success(fa.cockpit.actionItemCompleted);
            return;
         }

         if (action === 'carry') {
            const { entity: result } = await sendTaskSyncMutation<{ actionItem: TaskaraMeetingActionItem; agendaItem: TaskaraOneOnOneAgendaResponse['items'][number] }>(
               'meeting_action_item.carry_forward',
               { id: actionItem.id, carry: { seriesId: agenda.series.id } },
               undefined,
               undefined,
               { keepPendingOnRetryable: true }
            );
            if (!result) throw new Error(fa.cockpit.syncActionFailed);
            setAgenda((current) => {
               if (!current || current.items.some((item) => item.id === result.agendaItem.id)) return current;
               return { ...current, items: [...current.items, result.agendaItem] };
            });
            toast.success(fa.cockpit.actionItemCarried);
            return;
         }

         const { entity: result } = await sendTaskSyncMutation<{ actionItem: TaskaraMeetingActionItem; task: TaskaraTask }>(
            'meeting_action_item.create_task',
            { id: actionItem.id, task: {} },
            undefined,
            undefined,
            { keepPendingOnRetryable: true }
         );
         if (!result) throw new Error(fa.cockpit.syncActionFailed);
         setActionItems((current) => current.filter((item) => item.id !== result.actionItem.id));
         toast.success(fa.cockpit.actionItemTaskCreated(result.task.key));
      } catch (error) {
         if (isRetryableTaskSyncError(error)) {
            if (action === 'carry') {
               setAgenda((current) =>
                  current
                     ? applyPendingCarryForwardAgendaMutations(
                          current,
                          [actionItem],
                          [
                             {
                                name: 'meeting_action_item.carry_forward',
                                args: { id: actionItem.id, carry: { seriesId: current.series.id } },
                                createdAt: new Date().toISOString(),
                             },
                          ]
                       )
                     : current
               );
            }
            toast.message(fa.cockpit.actionQueued);
            return;
         }
         if (action === 'complete') setActionItems((current) => current.some((item) => item.id === actionItem.id) ? current : [actionItem, ...current]);
         toast.error(error instanceof Error ? error.message : fa.cockpit.syncActionFailed);
      } finally {
         setActionItemPendingId(null);
      }
   }

   async function persistGeneratedItem(item: TaskaraOneOnOneAgendaResponse['generated'][number]) {
      if (!agenda) return;
      const key = `${item.sourceType}:${item.sourceId}`;
      setPersistingKey(key);
      try {
         const { entity: created } = await sendTaskSyncMutation<TaskaraOneOnOneAgendaResponse['items'][number]>(
            'one_on_one_agenda_item.create',
            {
               seriesId: agenda.series.id,
               item: {
                  title: item.title,
                  notes: item.notes || undefined,
                  sourceType: item.sourceType,
                  sourceId: item.sourceId,
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
      } catch (error) {
         if (isRetryableTaskSyncError(error)) {
            toast.message(fa.cockpit.actionQueued);
            setAgenda((current) =>
               current
                  ? {
                       ...current,
                       generated: current.generated.filter((candidate) => `${candidate.sourceType}:${candidate.sourceId}` !== key),
                    }
                  : current
            );
            return;
         }
         toast.error(error instanceof Error ? error.message : fa.cockpit.syncActionFailed);
      } finally {
         setPersistingKey(null);
      }
   }

   return (
      <>
         <LinearPanel title={<PanelTitle count={(missingCheckIns?.total || 0) + dueSeries.length} icon={ListChecks} label={fa.cockpit.syncs} />} className="overflow-hidden">
            {!missingItems.length && !dueSeries.length ? (
               <div className="p-4">
                  <LinearEmptyState>{fa.cockpit.noSyncs}</LinearEmptyState>
               </div>
            ) : (
               <div className="divide-y divide-white/7">
                  {missingItems.slice(0, 8).map((item) => {
                     const series = oneOnOnes.find((row) => row.participantId === item.user.id);
                     const seriesPending = isPendingOneOnOneSeries(series);
                     return (
                        <div key={item.user.id} className="grid gap-2 px-3 py-3">
                           <div className="flex min-w-0 items-center gap-2.5">
                              <LinearAvatar name={item.user.name} src={item.user.avatarUrl} className="size-7" />
                              <div className="min-w-0 flex-1">
                                 <div className="truncate text-sm font-medium text-zinc-200">{item.user.name}</div>
                                 <div className="truncate text-xs text-zinc-500">
                                    {item.hoursSinceLastCheckIn === null
                                       ? fa.cockpit.noCheckInYet
                                       : fa.cockpit.checkInAge(item.hoursSinceLastCheckIn)}
                                 </div>
                              </div>
                              <button
                                 className="inline-flex h-7 items-center gap-1 rounded-md border border-white/8 bg-white/[0.035] px-2 text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-45"
                                 disabled={pendingUserId === item.user.id || agendaLoadingId === series?.id || seriesPending}
                                 type="button"
                                 onClick={() => (series ? void openAgenda(series) : void createSeries(item.user.id))}
                              >
                                 {pendingUserId === item.user.id || agendaLoadingId === series?.id || seriesPending ? (
                                    <RefreshCw className="size-3.5 animate-spin" />
                                 ) : (
                                    <CalendarPlus className="size-3.5" />
                                 )}
                                 {seriesPending ? fa.cockpit.queued : series ? fa.cockpit.openAgenda : fa.cockpit.createOneOnOne}
                              </button>
                           </div>
                        </div>
                     );
                  })}
                  {dueSeries.map((series) => {
                     const seriesPending = isPendingOneOnOneSeries(series);
                     return (
                        <button
                           key={series.id}
                           className="flex w-full min-w-0 items-center gap-2.5 px-3 py-3 text-start hover:bg-white/[0.025] disabled:cursor-not-allowed disabled:opacity-60"
                           disabled={agendaLoadingId === series.id || seriesPending}
                           type="button"
                           onClick={() => void openAgenda(series)}
                        >
                           <LinearAvatar name={series.participant?.name} src={series.participant?.avatarUrl} className="size-7" />
                           <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-zinc-200">
                                 {series.title || fa.cockpit.oneOnOneWith(series.participant?.name || fa.app.unknown)}
                              </span>
                              <span className="block truncate text-xs text-zinc-500">
                                 {seriesPending ? fa.cockpit.queued : series.nextScheduledAt ? formatJalaliDateTime(series.nextScheduledAt) : fa.cockpit.noNextOneOnOne}
                              </span>
                           </span>
                           {agendaLoadingId === series.id || seriesPending ? <RefreshCw className="size-3.5 animate-spin text-zinc-500" /> : <ArrowUpRight className="size-3.5 text-zinc-500" />}
                        </button>
                     );
                  })}
               </div>
            )}
         </LinearPanel>
         <Dialog
            open={Boolean(agenda)}
            onOpenChange={(open) => {
               if (open) return;
               setAgenda(null);
               setActionItems([]);
            }}
         >
            <DialogContent className="max-w-2xl [direction:rtl]">
               <DialogHeader>
                  <DialogTitle>{agenda ? fa.cockpit.oneOnOneWith(agenda.series.participant?.name || fa.app.unknown) : fa.cockpit.syncs}</DialogTitle>
                  <DialogDescription>{fa.cockpit.agendaDescription}</DialogDescription>
               </DialogHeader>
               {agenda ? (
                  <div className="mt-3 grid max-h-[60vh] gap-3 overflow-y-auto pe-1">
                     {agenda.items.length ? (
                        <div className="rounded-lg border border-white/8">
                           {agenda.items.map((item) => (
                              <div key={item.id} className="border-b border-white/7 px-3 py-2 last:border-b-0">
                                 <div className="text-sm font-medium text-zinc-100">{item.title}</div>
                                 {item.notes ? <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-500">{item.notes}</div> : null}
                              </div>
                           ))}
                        </div>
                     ) : null}
                     <div className="grid gap-2">
                        <div className="text-xs font-medium text-zinc-500">{fa.cockpit.openActionItems}</div>
                        {actionItems.length ? (
                           <div className="rounded-lg border border-white/8">
                              {actionItems.map((item) => {
                                 const itemPending = actionItemPendingId?.endsWith(`:${item.id}`) ?? false;
                                 return (
                                    <div key={item.id} className="border-b border-white/7 px-3 py-2.5 last:border-b-0">
                                       <div className="flex min-w-0 items-start gap-3">
                                          <div className="min-w-0 flex-1">
                                             <div className="truncate text-sm font-medium text-zinc-100">{item.title}</div>
                                             <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                                                <span className="truncate">{item.meeting?.title || fa.meeting.title}</span>
                                                {item.dueAt ? <span>{formatJalaliDate(item.dueAt)}</span> : null}
                                                {item.task ? (
                                                   <Link className="ltr text-zinc-300 hover:text-zinc-100" to={`/${orgId}/issue/${encodeURIComponent(item.task.key)}`}>
                                                      {item.task.key}
                                                   </Link>
                                                ) : null}
                                             </div>
                                             {item.notes ? <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-zinc-500">{item.notes}</div> : null}
                                          </div>
                                          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                                             <button
                                                className="inline-flex h-7 items-center gap-1 rounded-md border border-white/8 px-2 text-xs text-zinc-300 hover:bg-white/[0.05] disabled:opacity-45"
                                                disabled={itemPending}
                                                type="button"
                                                onClick={() => void updateActionItem(item, 'complete')}
                                             >
                                                {actionItemPendingId === `complete:${item.id}` ? <RefreshCw className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                                                {fa.cockpit.completeActionItem}
                                             </button>
                                             <button
                                                className="inline-flex h-7 items-center gap-1 rounded-md border border-white/8 px-2 text-xs text-zinc-300 hover:bg-white/[0.05] disabled:opacity-45"
                                                disabled={itemPending}
                                                type="button"
                                                onClick={() => void updateActionItem(item, 'carry')}
                                             >
                                                {actionItemPendingId === `carry:${item.id}` ? <RefreshCw className="size-3.5 animate-spin" /> : <ListChecks className="size-3.5" />}
                                                {fa.cockpit.carryForwardActionItem}
                                             </button>
                                             {!item.task ? (
                                                <button
                                                   className="inline-flex h-7 items-center gap-1 rounded-md border border-white/8 px-2 text-xs text-zinc-300 hover:bg-white/[0.05] disabled:opacity-45"
                                                   disabled={itemPending}
                                                   type="button"
                                                   onClick={() => void updateActionItem(item, 'task')}
                                                >
                                                   {actionItemPendingId === `task:${item.id}` ? <RefreshCw className="size-3.5 animate-spin" /> : <CircleDot className="size-3.5" />}
                                                   {fa.cockpit.createLinkedTask}
                                                </button>
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
                     </div>
                     <div className="grid gap-2">
                        <div className="text-xs font-medium text-zinc-500">{fa.cockpit.generatedAgenda}</div>
                        {agenda.generated.length ? (
                           agenda.generated.map((item) => {
                              const key = `${item.sourceType}:${item.sourceId}`;
                              return (
                                 <div key={key} className="rounded-lg border border-white/8 bg-white/[0.025] p-3">
                                    <div className="flex min-w-0 items-start gap-2">
                                       <span className={cn('mt-1 size-2 rounded-full', severityDotClasses[item.severity])} />
                                       <div className="min-w-0 flex-1">
                                          <div className="text-sm font-medium text-zinc-100">{item.title}</div>
                                          {item.notes ? <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-500">{item.notes}</div> : null}
                                       </div>
                                       <button
                                          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/8 px-2 text-xs text-zinc-300 hover:bg-white/[0.05] disabled:opacity-45"
                                          disabled={persistingKey === key}
                                          type="button"
                                          onClick={() => void persistGeneratedItem(item)}
                                       >
                                          {persistingKey === key ? <RefreshCw className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                                          {fa.cockpit.addToAgenda}
                                       </button>
                                    </div>
                                 </div>
                              );
                           })
                        ) : (
                           <LinearEmptyState>{fa.cockpit.noGeneratedAgenda}</LinearEmptyState>
                        )}
                     </div>
                  </div>
               ) : null}
            </DialogContent>
         </Dialog>
      </>
   );
}

function ProjectHealthPanel({ orgId, projects }: { orgId: string; projects: WorkHealthProject[] }) {
   return (
      <LinearPanel title={<PanelTitle count={projects.length} icon={CheckCircle2} label={fa.cockpit.projectHealth} />} className="overflow-hidden">
         {projects.length === 0 ? (
            <div className="p-4">
               <LinearEmptyState>{fa.app.empty}</LinearEmptyState>
            </div>
         ) : (
            <div className="divide-y divide-white/7">
               {projects.map((item) => (
                  <Link key={item.project.id} className="grid gap-3 px-3 py-3 hover:bg-white/[0.025] lg:grid-cols-[minmax(260px,1fr)_repeat(5,minmax(72px,auto))]" to={`/${orgId}/projects`}>
                     <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                           <ProjectGlyph name={item.project.name} className="size-6" iconClassName="size-3.5" />
                           <span className="truncate text-sm font-medium text-zinc-200">{item.project.name}</span>
                           <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', projectHealthClasses[item.health])}>
                              {projectHealthLabels[item.health]}
                           </span>
                        </div>
                        <div className="mt-1 truncate text-xs text-zinc-500">{item.project.team?.name || fa.nav.workspace}</div>
                     </div>
                     <ProjectMetric label={fa.cockpit.activeWork} value={item.activeCount} />
                     <ProjectMetric label={fa.cockpit.overdue} value={item.overdueCount} />
                     <ProjectMetric label={fa.cockpit.blocked} value={item.blockedCount} />
                     <ProjectMetric label={fa.cockpit.reviews} value={item.reviewCount} />
                     <ProjectMetric label={fa.cockpit.unassignedTasks} value={item.unassignedCount} />
                  </Link>
               ))}
            </div>
         )}
      </LinearPanel>
   );
}

function ProjectMetric({ label, value }: { label: string; value: number }) {
   return (
      <div className="min-w-0">
         <div className="text-sm font-semibold text-zinc-200">{numberFormatter.format(value)}</div>
         <div className="truncate text-[11px] text-zinc-500">{label}</div>
      </div>
   );
}

function PanelTitle({
   count,
   icon: Icon,
   label,
}: {
   count: number;
   icon: typeof ScanEye;
   label: string;
}) {
   return (
      <div className="flex items-center justify-between gap-3">
         <span className="flex min-w-0 items-center gap-2">
            <Icon className="size-4 text-zinc-500" />
            <span className="truncate">{label}</span>
         </span>
         <span className="rounded-full border border-white/8 bg-white/[0.035] px-2 py-0.5 text-[11px] text-zinc-400">
            {numberFormatter.format(count)}
         </span>
      </div>
   );
}

const metricToneClasses = {
   amber: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
   indigo: 'border-indigo-400/20 bg-indigo-400/10 text-indigo-200',
   rose: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
   sky: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
   zinc: 'border-zinc-400/15 bg-zinc-400/8 text-zinc-300',
};

const severityLabels = {
   LOW: 'کم',
   MEDIUM: 'متوسط',
   HIGH: 'زیاد',
   URGENT: 'فوری',
};

const severityDotClasses = {
   LOW: 'bg-zinc-500',
   MEDIUM: 'bg-amber-400',
   HIGH: 'bg-orange-400',
   URGENT: 'bg-rose-400',
};

const workloadLabels = {
   idle: fa.cockpit.idle,
   balanced: 'متعادل',
   busy: 'پرکار',
   overloaded: fa.cockpit.overloaded,
};

const workloadBadgeClasses = {
   idle: 'border-zinc-400/15 bg-zinc-400/8 text-zinc-400',
   balanced: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
   busy: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
   overloaded: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
};

const workloadBarClasses = {
   idle: 'bg-zinc-500',
   balanced: 'bg-emerald-400',
   busy: 'bg-amber-400',
   overloaded: 'bg-rose-400',
};

const projectHealthLabels = {
   healthy: 'پایدار',
   needs_attention: 'نیازمند توجه',
   at_risk: 'در ریسک',
};

const projectHealthClasses = {
   healthy: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
   needs_attention: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
   at_risk: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
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

function isPendingOneOnOneSeries(series: TaskaraOneOnOneSeries | null | undefined): boolean {
   return Boolean(series?.id.startsWith('pending-one-on-one-'));
}
