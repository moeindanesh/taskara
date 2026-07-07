'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
   AlertTriangle,
   ArrowUpRight,
   Blocks,
   Check,
   CheckCircle2,
   CircleDot,
   ClipboardList,
   Copy,
   GitPullRequest,
   Inbox,
   Loader2,
   ListPlus,
   MessageSquareWarning,
   RefreshCw,
   Clock3,
   Timer,
   UserRound,
   Users,
   X,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
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
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
   LinearAvatar,
   ProjectGlyph,
   StatusIcon,
   linearPriorityMeta,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate, formatJalaliDateTime } from '@/lib/jalali';
import { dispatchWorkspaceRefresh, useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraTask, WorkHealthPerson, WorkHealthSummary } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

const numberFormatter = new Intl.NumberFormat('fa-IR');
const triagePriorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

type TriageQueueAction = 'accept' | 'request-info' | 'duplicate' | 'split' | 'snooze' | 'decline';
type TriageSplitDraft = {
   description: string;
   title: string;
};

export function DecisionQueuesView() {
   const { orgId = 'taskara' } = useParams();
   const [summary, setSummary] = useState<WorkHealthSummary | null>(null);
   const [loading, setLoading] = useState(true);
   const [refreshing, setRefreshing] = useState(false);
   const [error, setError] = useState('');
   const [triageDialog, setTriageDialog] = useState<{ action: TriageQueueAction; task: TaskaraTask } | null>(null);
   const [triageNote, setTriageNote] = useState('');
   const [triagePriority, setTriagePriority] = useState('MEDIUM');
   const [triageDuplicateKey, setTriageDuplicateKey] = useState('');
   const [triageSnoozedUntil, setTriageSnoozedUntil] = useState(() => defaultTriageSnoozeLocalValue());
   const [triageSplitItems, setTriageSplitItems] = useState<TriageSplitDraft[]>(() => defaultTriageSplitItems());
   const [triageSubmitting, setTriageSubmitting] = useState(false);
   const requestRef = useRef(0);

   const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
      const requestId = ++requestRef.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      setError('');

      try {
         const result = await taskaraRequest<WorkHealthSummary>('/work-health/summary');
         if (requestId !== requestRef.current) return;
         setSummary(result);
      } catch (loadError) {
         if (requestId === requestRef.current) {
            setError(loadError instanceof Error ? loadError.message : fa.decisionQueues.loadFailed);
         }
      } finally {
         if (requestId === requestRef.current) {
            setLoading(false);
            setRefreshing(false);
         }
      }
   }, []);

   useEffect(() => {
      void load();
   }, [load]);

   useLiveRefresh(() => load('refresh'), {
      fireOnMount: false,
      workspaceEventFilter: decisionQueuesRefreshSourceMatches,
   });

   const peopleById = useMemo(() => {
      const map = new Map<string, WorkHealthPerson>();
      for (const person of summary?.people || []) map.set(person.user.id, person);
      return map;
   }, [summary?.people]);

   const overloadedPeople = useMemo(
      () =>
         (summary?.people || [])
            .filter((person) => person.status === 'overloaded' || person.blockedCount > 0 || person.overdueCount > 0 || person.reviewCount > 0)
            .sort(comparePeopleRisk)
            .slice(0, 18),
      [summary?.people]
   );

   const openTriageDialog = useCallback((task: TaskaraTask, action: TriageQueueAction) => {
      setTriageDialog({ action, task });
      setTriageNote('');
      setTriageDuplicateKey('');
      setTriageSnoozedUntil(defaultTriageSnoozeLocalValue());
      setTriageSplitItems(defaultTriageSplitItems());
      setTriagePriority(task.priority === 'NO_PRIORITY' ? 'MEDIUM' : task.priority);
   }, []);

   const closeTriageDialog = useCallback(() => {
      if (triageSubmitting) return;
      setTriageDialog(null);
      setTriageNote('');
      setTriageDuplicateKey('');
      setTriageSnoozedUntil(defaultTriageSnoozeLocalValue());
      setTriageSplitItems(defaultTriageSplitItems());
   }, [triageSubmitting]);

   const applyTriageResult = useCallback((task: TaskaraTask) => {
      setSummary((current) => {
         if (!current) return current;
         const backlog = isActionableBacklogTask(task)
            ? current.queues.backlog.map((item) => (item.id === task.id ? task : item))
            : current.queues.backlog.filter((item) => item.id !== task.id);
         return {
            ...current,
            queues: {
               ...current.queues,
               backlog,
            },
         };
      });
   }, []);

   const submitTriageDialog = useCallback(async () => {
      if (!triageDialog || triageSubmitting) return;
      const note = triageNote.trim();
      const duplicateKey = triageDuplicateKey.trim();
      const { action, task } = triageDialog;
      const noteRequired = action !== 'accept' || !task.assignee;
      const snoozedUntil = action === 'snooze' ? new Date(triageSnoozedUntil) : null;
      const splitItems = triageSplitItems
         .map((item) => ({ title: item.title.trim(), description: item.description.trim() }))
         .filter((item) => item.title);

      if (action === 'split' && splitItems.length < 2) {
         toast.error(fa.decisionQueues.triageSplitRequired);
         return;
      }
      if (action !== 'split' && noteRequired && note.length < 3) {
         toast.error(fa.decisionQueues.triageNoteRequired);
         return;
      }
      if (action === 'duplicate' && !duplicateKey) {
         toast.error(fa.decisionQueues.triageDuplicateRequired);
         return;
      }
      if (action === 'accept' && (!triagePriority || triagePriority === 'NO_PRIORITY')) {
         toast.error(fa.issue.triagePriorityRequired);
         return;
      }
      if (action === 'snooze' && (!snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil.getTime() <= Date.now())) {
         toast.error(fa.decisionQueues.triageSnoozeRequired);
         return;
      }

      const body =
         action === 'accept'
            ? {
                 assigneeId: task.assignee?.id || undefined,
                 priority: triagePriority,
                 weight: task.weight ?? undefined,
                 dueAt: task.dueAt ?? undefined,
                 unassignedReason: task.assignee ? undefined : note,
                 comment: task.assignee && note ? note : undefined,
              }
            : action === 'request-info'
              ? { comment: note }
              : action === 'duplicate'
                ? { canonicalTaskIdOrKey: duplicateKey, reason: note || undefined }
                : action === 'split'
                  ? {
                       items: splitItems.map((item) => ({
                          title: item.title,
                          description: item.description || undefined,
                       })),
                       reason: note || undefined,
                    }
                : action === 'snooze'
                  ? { snoozedUntil: snoozedUntil?.toISOString(), reason: note }
                  : { reason: note };

      setTriageSubmitting(true);
      try {
         const result = await taskaraRequest<TaskaraTask | { task: TaskaraTask; items: TaskaraTask[] }>(
            `/triage/tasks/${encodeURIComponent(task.key)}/${action}`,
            {
               method: 'POST',
               body: JSON.stringify(body),
            }
         );
         const updated = action === 'split' ? (result as { task: TaskaraTask }).task : (result as TaskaraTask);
         applyTriageResult(updated);
         dispatchWorkspaceRefresh({ source: 'task:triage' });
         toast.success(triageSuccessMessage(action));
         setTriageDialog(null);
         setTriageNote('');
         setTriageDuplicateKey('');
         setTriageSnoozedUntil(defaultTriageSnoozeLocalValue());
         setTriageSplitItems(defaultTriageSplitItems());
      } catch (submitError) {
         toast.error(submitError instanceof Error ? submitError.message : fa.issue.triageActionFailed);
      } finally {
         setTriageSubmitting(false);
      }
   }, [applyTriageResult, triageDialog, triageDuplicateKey, triageNote, triagePriority, triageSnoozedUntil, triageSplitItems, triageSubmitting]);

   return (
      <div className="flex min-h-full flex-col bg-background text-zinc-900 dark:bg-[#101011] dark:text-zinc-100" data-testid="decision-queues-screen">
         <div className="sticky top-0 z-10 border-b border-zinc-200 bg-background/95 px-4 py-3 backdrop-blur dark:border-white/8 dark:bg-[#101011]/95 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
               <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                     {summary?.generatedAt ? (
                        <span>{fa.decisionQueues.generatedAt}: {formatJalaliDateTime(summary.generatedAt)}</span>
                     ) : (
                        <span>{fa.decisionQueues.description}</span>
                     )}
                     {summary?.overview.truncated ? (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-amber-700 dark:text-amber-200">
                           {fa.decisionQueues.truncated}
                        </span>
                     ) : null}
                  </div>
               </div>
               <Button size="xs" variant="outline" className="h-8 gap-1.5" onClick={() => void load('refresh')} disabled={refreshing}>
                  <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                  {fa.decisionQueues.refresh}
               </Button>
            </div>
         </div>

         <main className="space-y-4 p-4 sm:p-6">
            {error ? (
               <div className="rounded-md border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
                  {error}
               </div>
            ) : null}

            {loading && !summary ? (
               <DecisionQueuesSkeleton />
            ) : summary ? (
               <>
                  <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                     <MetricTile icon={GitPullRequest} label={fa.decisionQueues.reviewQueue} value={summary.overview.reviewTasks} tone={summary.overview.reviewTasks ? 'warning' : 'default'} />
                     <MetricTile icon={Inbox} label={fa.decisionQueues.backlogQueue} value={summary.overview.backlogTasks} tone={summary.overview.backlogTasks ? 'warning' : 'default'} />
                     <MetricTile icon={UserRound} label={fa.decisionQueues.unassignedQueue} value={summary.overview.unassignedActiveTasks} tone={summary.overview.unassignedActiveTasks ? 'warning' : 'default'} />
                     <MetricTile icon={Blocks} label={fa.decisionQueues.blockedQueue} value={summary.overview.blockedTasks} tone={summary.overview.blockedTasks ? 'danger' : 'default'} />
                     <MetricTile icon={Users} label={fa.decisionQueues.peopleQueue} value={overloadedPeople.length} tone={overloadedPeople.length ? 'danger' : 'default'} />
                  </section>

                  <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
                     <div className="space-y-4">
                        <QueuePanel
                           actionLabel={fa.decisionQueues.reviewAction}
                           description={fa.decisionQueues.reviewDescription}
                           empty={fa.decisionQueues.noReviews}
                           icon={GitPullRequest}
                           orgId={orgId}
                           peopleById={peopleById}
                           tasks={summary.queues.review}
                           title={fa.decisionQueues.reviewTitle}
                           variant="review"
                        />
                        <QueuePanel
                           actionLabel={fa.decisionQueues.triageAction}
                           description={fa.decisionQueues.triageDescription}
                           empty={fa.decisionQueues.noTriage}
                           icon={Inbox}
                           orgId={orgId}
                           peopleById={peopleById}
                           tasks={summary.queues.backlog}
                           title={fa.decisionQueues.triageTitle}
                           variant="triage"
                           onOpenTriage={openTriageDialog}
                        />
                     </div>
                     <div className="space-y-4">
                        <QueuePanel
                           actionLabel={fa.decisionQueues.assignAction}
                           description={fa.decisionQueues.unassignedDescription}
                           empty={fa.decisionQueues.noUnassigned}
                           icon={UserRound}
                           orgId={orgId}
                           peopleById={peopleById}
                           tasks={summary.queues.unassigned}
                           title={fa.decisionQueues.unassignedTitle}
                           variant="assign"
                        />
                        <PeopleFollowUpPanel orgId={orgId} people={overloadedPeople} />
                     </div>
                  </section>

                  <section className="grid gap-4 xl:grid-cols-2">
                     <QueuePanel
                        actionLabel={fa.decisionQueues.unblockAction}
                        description={fa.decisionQueues.blockedDescription}
                        empty={fa.decisionQueues.noBlocked}
                        icon={AlertTriangle}
                        orgId={orgId}
                        peopleById={peopleById}
                        tasks={[...summary.queues.blocked, ...summary.queues.overdue].slice(0, 24)}
                        title={fa.decisionQueues.blockedTitle}
                        variant="risk"
                     />
                     <QueuePanel
                        actionLabel={fa.decisionQueues.staleAction}
                        description={fa.decisionQueues.staleDescription}
                        empty={fa.decisionQueues.noStale}
                        icon={Timer}
                        orgId={orgId}
                        peopleById={peopleById}
                        tasks={summary.queues.stale}
                        title={fa.decisionQueues.staleTitle}
                        variant="risk"
                     />
                  </section>
               </>
            ) : (
               <EmptyState title={fa.decisionQueues.emptyTitle} description={fa.decisionQueues.emptyDescription} />
            )}
         </main>
         <TriageDecisionDialog
            action={triageDialog?.action || null}
            duplicateKey={triageDuplicateKey}
            note={triageNote}
            open={Boolean(triageDialog)}
            priority={triagePriority}
            snoozedUntil={triageSnoozedUntil}
            splitItems={triageSplitItems}
            submitting={triageSubmitting}
            task={triageDialog?.task || null}
            onDuplicateKeyChange={setTriageDuplicateKey}
            onNoteChange={setTriageNote}
            onOpenChange={(open) => {
               if (!open) closeTriageDialog();
            }}
            onPriorityChange={setTriagePriority}
            onSnoozedUntilChange={setTriageSnoozedUntil}
            onSplitItemsChange={setTriageSplitItems}
            onSubmit={submitTriageDialog}
         />
      </div>
   );
}

function QueuePanel({
   actionLabel,
   description,
   empty,
   icon: Icon,
   orgId,
   peopleById,
   tasks,
   title,
   onOpenTriage,
   variant,
}: {
   actionLabel: string;
   description: string;
   empty: string;
   icon: typeof CircleDot;
   orgId: string;
   peopleById: Map<string, WorkHealthPerson>;
   tasks: TaskaraTask[];
   title: string;
   onOpenTriage?: (task: TaskaraTask, action: TriageQueueAction) => void;
   variant: 'review' | 'triage' | 'assign' | 'risk';
}) {
   return (
      <Panel icon={Icon} title={title} description={description} count={tasks.length}>
         {tasks.length ? (
            <div className="divide-y divide-zinc-200 dark:divide-white/7">
               {tasks.slice(0, 12).map((task) => (
                  <DecisionTaskRow
                     key={`${variant}-${task.id}`}
                     actionLabel={actionLabel}
                     orgId={orgId}
                     peopleById={peopleById}
                     task={task}
                     variant={variant}
                     onOpenTriage={onOpenTriage}
                  />
               ))}
            </div>
         ) : (
            <EmptyState title={empty} compact />
         )}
      </Panel>
   );
}

function DecisionTaskRow({
   actionLabel,
   orgId,
   peopleById,
   task,
   onOpenTriage,
   variant,
}: {
   actionLabel: string;
   orgId: string;
   peopleById: Map<string, WorkHealthPerson>;
   task: TaskaraTask;
   onOpenTriage?: (task: TaskaraTask, action: TriageQueueAction) => void;
   variant: 'review' | 'triage' | 'assign' | 'risk';
}) {
   const reviewer = task.activeReviewRequest?.reviewerId ? peopleById.get(task.activeReviewRequest.reviewerId)?.user : null;
   const statusMeta = linearStatusMeta[task.status];
   const PriorityIcon = linearPriorityMeta[task.priority]?.icon || CircleDot;

   return (
      <div className="grid gap-3 py-3 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.65fr)_auto] md:items-center">
         <div className="min-w-0">
            <div className="mb-1 flex min-w-0 items-center gap-2">
               <StatusIcon status={task.status} className="size-4 shrink-0" />
               <Link
                  to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}
                  className="min-w-0 truncate text-sm font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-300"
               >
                  <span className="font-mono text-xs text-zinc-500">{task.key}</span>
                  <span className="px-1.5 text-zinc-400">·</span>
                  {task.title}
               </Link>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-zinc-500">
               {task.project ? (
                  <span className="inline-flex max-w-full items-center gap-1 truncate">
                     <ProjectGlyph name={task.project.name} className="size-3.5 shrink-0" />
                     <span className="truncate">{task.project.name}</span>
                  </span>
               ) : null}
               <span className="inline-flex items-center gap-1">
                  <PriorityIcon className={cn('size-3.5', linearPriorityMeta[task.priority]?.className || 'text-zinc-500')} />
                  {linearPriorityMeta[task.priority]?.label || task.priority}
               </span>
               <span>{statusMeta?.label || task.status}</span>
            </div>
         </div>

         <div className="flex min-w-0 flex-wrap gap-1.5 text-xs text-zinc-500">
            {task.assignee ? (
               <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/8">
                  <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-4 shrink-0" />
                  <span className="truncate">{task.assignee.name}</span>
               </span>
            ) : (
               <span className="rounded-full border border-amber-300/60 bg-amber-300/10 px-2 py-0.5 text-amber-700 dark:border-amber-400/20 dark:text-amber-200">
                  {fa.decisionQueues.noAssignee}
               </span>
            )}
            {variant === 'review' && task.activeReviewRequest ? (
               <>
                  <span className="rounded-full border border-sky-300/60 bg-sky-300/10 px-2 py-0.5 text-sky-700 dark:border-sky-400/20 dark:text-sky-200">
                     {reviewer ? fa.decisionQueues.reviewer(reviewer.name) : fa.decisionQueues.reviewerUnknown}
                  </span>
                  <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/8">
                     {fa.decisionQueues.waitingSince(formatJalaliDate(task.activeReviewRequest.requestedAt))}
                  </span>
               </>
            ) : null}
            {task.dueAt ? (
               <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/8">
                  {fa.decisionQueues.dueAt(formatJalaliDate(task.dueAt))}
               </span>
            ) : null}
         </div>

         {variant === 'triage' && onOpenTriage ? (
            <TriageActionStrip onOpen={(action) => onOpenTriage(task, action)} orgId={orgId} task={task} />
         ) : (
            <Button asChild size="xs" variant="outline" className="h-7 shrink-0 justify-self-start md:justify-self-end">
               <Link to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}>
                  {actionLabel}
                  <ArrowUpRight className="size-3.5" />
               </Link>
            </Button>
         )}
      </div>
   );
}

function TriageActionStrip({
   onOpen,
   orgId,
   task,
}: {
   onOpen: (action: TriageQueueAction) => void;
   orgId: string;
   task: TaskaraTask;
}) {
   return (
      <div className="flex flex-wrap items-center gap-1.5 justify-self-start md:max-w-56 md:justify-self-end">
         <Button size="xs" className="h-7 gap-1.5" onClick={() => onOpen('accept')}>
            <Check className="size-3.5" />
            {fa.decisionQueues.triageAccept}
         </Button>
         <Button size="xs" variant="outline" className="h-7 gap-1.5" onClick={() => onOpen('request-info')}>
            <MessageSquareWarning className="size-3.5" />
            {fa.decisionQueues.triageRequestInfo}
         </Button>
         <Button size="xs" variant="outline" className="h-7 gap-1.5" onClick={() => onOpen('duplicate')}>
            <Copy className="size-3.5" />
            {fa.decisionQueues.triageDuplicate}
         </Button>
         <Button size="xs" variant="outline" className="h-7 gap-1.5" onClick={() => onOpen('split')}>
            <ListPlus className="size-3.5" />
            {fa.decisionQueues.triageSplit}
         </Button>
         <Button size="xs" variant="outline" className="h-7 gap-1.5" onClick={() => onOpen('snooze')}>
            <Clock3 className="size-3.5" />
            {fa.decisionQueues.triageSnooze}
         </Button>
         <Button size="xs" variant="ghost" className="h-7 gap-1.5 text-zinc-500" onClick={() => onOpen('decline')}>
            <X className="size-3.5" />
            {fa.decisionQueues.triageDecline}
         </Button>
         <Button asChild size="xs" variant="ghost" className="h-7 gap-1.5 text-zinc-500">
            <Link to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}>
               {fa.decisionQueues.triageMore}
               <ArrowUpRight className="size-3.5" />
            </Link>
         </Button>
      </div>
   );
}

function TriageDecisionDialog({
   action,
   duplicateKey,
   note,
   open,
   priority,
   snoozedUntil,
   splitItems,
   submitting,
   task,
   onDuplicateKeyChange,
   onNoteChange,
   onOpenChange,
   onPriorityChange,
   onSnoozedUntilChange,
   onSplitItemsChange,
   onSubmit,
}: {
   action: TriageQueueAction | null;
   duplicateKey: string;
   note: string;
   open: boolean;
   priority: string;
   snoozedUntil: string;
   splitItems: TriageSplitDraft[];
   submitting: boolean;
   task: TaskaraTask | null;
   onDuplicateKeyChange: (value: string) => void;
   onNoteChange: (value: string) => void;
   onOpenChange: (open: boolean) => void;
   onPriorityChange: (value: string) => void;
   onSnoozedUntilChange: (value: string) => void;
   onSplitItemsChange: (value: TriageSplitDraft[]) => void;
   onSubmit: () => void;
}) {
   if (!action || !task) {
      return <Dialog open={open} onOpenChange={onOpenChange} />;
   }

   const noteRequired = action !== 'accept' || !task.assignee;
   const noteReady = note.trim().length >= 3;
   const submitDisabled =
      submitting ||
      (action !== 'split' && noteRequired && !noteReady) ||
      (action === 'duplicate' && !duplicateKey.trim()) ||
      (action === 'split' && splitItems.filter((item) => item.title.trim()).length < 2) ||
      (action === 'snooze' && !snoozedUntil) ||
      (action === 'accept' && (!priority || priority === 'NO_PRIORITY'));

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="max-w-[520px] [direction:rtl]">
            <DialogHeader>
               <DialogTitle>{triageDialogTitle(action)}</DialogTitle>
               <DialogDescription>
                  <span className="font-mono text-xs">{task.key}</span>
                  <span className="px-1.5">·</span>
                  {task.title}
               </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
               {action === 'accept' ? (
                  <label className="block">
                     <span className="mb-1 block text-xs font-medium text-zinc-500">{fa.decisionQueues.triagePriority}</span>
                     <Select value={priority} onValueChange={onPriorityChange}>
                        <SelectTrigger className="h-9">
                           <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                           {triagePriorities.map((item) => (
                              <SelectItem key={item} value={item}>
                                 {linearPriorityMeta[item]?.label || item}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  </label>
               ) : null}
               {action === 'duplicate' ? (
                  <label className="block">
                     <span className="mb-1 block text-xs font-medium text-zinc-500">{fa.decisionQueues.triageCanonicalTask}</span>
                     <Input
                        className="ltr text-left"
                        maxLength={120}
                        value={duplicateKey}
                        onChange={(event) => onDuplicateKeyChange(event.target.value)}
                        placeholder="CORE-123"
                     />
                  </label>
               ) : null}
               {action === 'snooze' ? (
                  <label className="block">
                     <span className="mb-1 block text-xs font-medium text-zinc-500">{fa.decisionQueues.triageSnoozedUntil}</span>
                     <Input
                        type="datetime-local"
                        value={snoozedUntil}
                        onChange={(event) => onSnoozedUntilChange(event.target.value)}
                     />
                  </label>
               ) : null}
               {action === 'split' ? (
                  <TriageSplitFields items={splitItems} onChange={onSplitItemsChange} />
               ) : null}
               <label className="block">
                  <span className="mb-1 block text-xs font-medium text-zinc-500">
                     {noteRequired && action !== 'split' ? fa.decisionQueues.triageRequiredNote : fa.decisionQueues.triageOptionalNote}
                  </span>
                  <Textarea
                     className="min-h-24 resize-none text-sm leading-6"
                     maxLength={5000}
                     value={note}
                     onChange={(event) => onNoteChange(event.target.value)}
                     placeholder={triageNotePlaceholder(action, Boolean(task.assignee))}
                  />
               </label>
            </div>
            <DialogFooter className="gap-2 sm:justify-start">
               <Button disabled={submitDisabled} className="h-8 gap-1.5" size="xs" onClick={onSubmit}>
                  {submitting ? <Loader2 className="size-3.5 animate-spin" /> : triageDialogIcon(action)}
                  {triageDialogConfirm(action)}
               </Button>
               <Button disabled={submitting} size="xs" variant="outline" className="h-8" onClick={() => onOpenChange(false)}>
                  {fa.app.cancel}
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}

function TriageSplitFields({
   items,
   onChange,
}: {
   items: TriageSplitDraft[];
   onChange: (items: TriageSplitDraft[]) => void;
}) {
   const updateItem = (index: number, patch: Partial<TriageSplitDraft>) => {
      onChange(items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
   };

   return (
      <div className="space-y-2">
         <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-zinc-500">{fa.decisionQueues.triageSplitItems}</span>
            <Button
               disabled={items.length >= 12}
               size="xs"
               type="button"
               variant="outline"
               className="h-7 gap-1.5"
               onClick={() => onChange([...items, { title: '', description: '' }])}
            >
               <ListPlus className="size-3.5" />
               {fa.decisionQueues.triageSplitAdd}
            </Button>
         </div>
         <div className="space-y-2">
            {items.map((item, index) => (
               <div key={index} className="grid gap-2 rounded-md border border-zinc-200 p-2 dark:border-white/8">
                  <div className="flex items-center gap-2">
                     <Input
                        value={item.title}
                        maxLength={300}
                        onChange={(event) => updateItem(index, { title: event.target.value })}
                        placeholder={fa.decisionQueues.triageSplitTitle(index + 1)}
                     />
                     <Button
                        aria-label={fa.decisionQueues.triageSplitRemove}
                        disabled={items.length <= 2}
                        size="icon"
                        type="button"
                        variant="ghost"
                        className="size-8 shrink-0 text-zinc-500"
                        onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
                     >
                        <X className="size-3.5" />
                     </Button>
                  </div>
                  <Textarea
                     value={item.description}
                     maxLength={15000}
                     className="min-h-16 resize-none text-xs leading-5"
                     onChange={(event) => updateItem(index, { description: event.target.value })}
                     placeholder={fa.decisionQueues.triageSplitDescription}
                  />
               </div>
            ))}
         </div>
      </div>
   );
}

function PeopleFollowUpPanel({ orgId, people }: { orgId: string; people: WorkHealthPerson[] }) {
   return (
      <Panel icon={Users} title={fa.decisionQueues.peopleTitle} description={fa.decisionQueues.peopleDescription} count={people.length}>
         {people.length ? (
            <div className="divide-y divide-zinc-200 dark:divide-white/7">
               {people.map((person) => (
                  <PersonRow key={person.user.id} orgId={orgId} person={person} />
               ))}
            </div>
         ) : (
            <EmptyState title={fa.decisionQueues.noPeople} compact />
         )}
      </Panel>
   );
}

function PersonRow({ orgId, person }: { orgId: string; person: WorkHealthPerson }) {
   const loadPercent = person.capacity > 0 ? Math.round(person.loadRatio * 100) : person.activeWeight > 0 ? 100 : 0;

   return (
      <Link className="grid gap-3 py-3 first:pt-0 last:pb-0 hover:bg-zinc-50 dark:hover:bg-white/[0.025] md:grid-cols-[minmax(0,1fr)_minmax(180px,0.65fr)] md:items-center" to={`/${orgId}/people?person=${encodeURIComponent(person.user.id)}`}>
         <div className="min-w-0">
            <div className="mb-1 flex min-w-0 items-center gap-2">
               <LinearAvatar name={person.user.name} src={person.user.avatarUrl} className="size-7 shrink-0" />
               <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{person.user.name}</div>
                  <div className="truncate text-xs text-zinc-500">{person.user.email}</div>
               </div>
            </div>
            <div className="flex flex-wrap gap-1.5 text-xs">
               <DiagnosticPill label={fa.decisionQueues.active} value={person.activeCount} />
               <DiagnosticPill label={fa.decisionQueues.review} value={person.reviewCount} tone={person.reviewCount ? 'warning' : 'default'} />
               <DiagnosticPill label={fa.decisionQueues.blocked} value={person.blockedCount} tone={person.blockedCount ? 'danger' : 'default'} />
               <DiagnosticPill label={fa.decisionQueues.overdue} value={person.overdueCount} tone={person.overdueCount ? 'danger' : 'default'} />
            </div>
         </div>
         <div className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-zinc-500">
               <span>{fa.decisionQueues.capacity}</span>
               <span>{fa.decisionQueues.load(person.activeWeight, person.capacity)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/8">
               <div
                  className={cn('h-full rounded-full', loadPercent >= 100 ? 'bg-rose-500' : loadPercent >= 75 ? 'bg-amber-500' : 'bg-emerald-500')}
                  style={{ width: `${Math.min(100, Math.max(3, loadPercent))}%` }}
               />
            </div>
         </div>
      </Link>
   );
}

function Panel({
   children,
   count,
   description,
   icon: Icon,
   title,
}: {
   children: ReactNode;
   count?: number;
   description: string;
   icon: typeof CircleDot;
   title: string;
}) {
   return (
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-white/8 dark:bg-[#161618]">
         <header className="border-b border-zinc-200 px-4 py-3 dark:border-white/7">
            <div className="flex items-start justify-between gap-3">
               <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                     <Icon className="size-4 shrink-0 text-zinc-500" />
                     <h2 className="truncate text-sm font-semibold">{title}</h2>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p>
               </div>
               {typeof count === 'number' ? (
                  <span className="shrink-0 rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500 dark:border-white/8">
                     {numberFormatter.format(count)}
                  </span>
               ) : null}
            </div>
         </header>
         <div className="p-4">{children}</div>
      </section>
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
   tone: 'default' | 'warning' | 'danger';
   value: number;
}) {
   return (
      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-3 shadow-sm dark:border-white/8 dark:bg-[#161618]">
         <div className="flex items-center justify-between gap-3">
            <span className={cn('inline-flex size-8 items-center justify-center rounded-md border', metricToneClassName(tone))}>
               <Icon className="size-4" />
            </span>
            <span className="text-xl font-semibold">{numberFormatter.format(value)}</span>
         </div>
         <div className="mt-2 truncate text-xs text-zinc-500">{label}</div>
      </div>
   );
}

function DiagnosticPill({
   label,
   tone = 'default',
   value,
}: {
   label: string;
   tone?: 'default' | 'warning' | 'danger';
   value: number;
}) {
   return (
      <span className={cn('rounded-full border px-2 py-0.5', pillToneClassName(tone))}>
         {label}: {numberFormatter.format(value)}
      </span>
   );
}

function EmptyState({
   compact = false,
   description,
   title,
}: {
   compact?: boolean;
   description?: string;
   title: string;
}) {
   return (
      <div className={cn('rounded-md border border-dashed border-zinc-200 text-center dark:border-white/10', compact ? 'px-3 py-5' : 'px-4 py-10')}>
         <CheckCircle2 className="mx-auto mb-2 size-5 text-emerald-500" />
         <div className="text-sm font-medium">{title}</div>
         {description ? <div className="mx-auto mt-1 max-w-md text-xs leading-5 text-zinc-500">{description}</div> : null}
      </div>
   );
}

function DecisionQueuesSkeleton() {
   return (
      <div className="space-y-4">
         <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
               <div key={index} className="h-24 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
            ))}
         </div>
         <div className="grid gap-4 xl:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
               <div key={index} className="h-72 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
            ))}
         </div>
      </div>
   );
}

function comparePeopleRisk(left: WorkHealthPerson, right: WorkHealthPerson): number {
   const leftScore = personRiskScore(left);
   const rightScore = personRiskScore(right);
   if (leftScore !== rightScore) return rightScore - leftScore;
   return right.activeWeight - left.activeWeight;
}

function personRiskScore(person: WorkHealthPerson): number {
   return (
      (person.status === 'overloaded' ? 100 : 0) +
      person.overdueCount * 12 +
      person.blockedCount * 10 +
      person.reviewCount * 5 +
      person.staleCount * 3
   );
}

function metricToneClassName(tone: 'default' | 'warning' | 'danger') {
   if (tone === 'danger') return 'border-rose-300/70 bg-rose-300/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-200';
   if (tone === 'warning') return 'border-amber-300/70 bg-amber-300/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-200';
   return 'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-white/8 dark:bg-white/5 dark:text-zinc-300';
}

function pillToneClassName(tone: 'default' | 'warning' | 'danger') {
   if (tone === 'danger') return 'border-rose-300/60 bg-rose-300/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-200';
   if (tone === 'warning') return 'border-amber-300/60 bg-amber-300/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-200';
   return 'border-zinc-200 text-zinc-500 dark:border-white/8';
}

function triageDialogTitle(action: TriageQueueAction): string {
   if (action === 'accept') return fa.decisionQueues.triageAcceptTitle;
   if (action === 'request-info') return fa.decisionQueues.triageRequestInfoTitle;
   if (action === 'duplicate') return fa.decisionQueues.triageDuplicateTitle;
   if (action === 'split') return fa.decisionQueues.triageSplitTitleDialog;
   if (action === 'snooze') return fa.decisionQueues.triageSnoozeTitle;
   return fa.decisionQueues.triageDeclineTitle;
}

function triageDialogConfirm(action: TriageQueueAction): string {
   if (action === 'accept') return fa.decisionQueues.triageAcceptConfirm;
   if (action === 'request-info') return fa.decisionQueues.triageRequestInfoConfirm;
   if (action === 'duplicate') return fa.decisionQueues.triageDuplicateConfirm;
   if (action === 'split') return fa.decisionQueues.triageSplitConfirm;
   if (action === 'snooze') return fa.decisionQueues.triageSnoozeConfirm;
   return fa.decisionQueues.triageDeclineConfirm;
}

function triageNotePlaceholder(action: TriageQueueAction, hasAssignee: boolean): string {
   if (action === 'accept' && !hasAssignee) return fa.decisionQueues.triageUnassignedReasonPlaceholder;
   if (action === 'accept') return fa.decisionQueues.triageCommentPlaceholder;
   if (action === 'request-info') return fa.decisionQueues.triageRequestInfoPlaceholder;
   if (action === 'duplicate') return fa.decisionQueues.triageDuplicatePlaceholder;
   if (action === 'split') return fa.decisionQueues.triageSplitReasonPlaceholder;
   if (action === 'snooze') return fa.decisionQueues.triageSnoozePlaceholder;
   return fa.decisionQueues.triageDeclinePlaceholder;
}

function triageSuccessMessage(action: TriageQueueAction): string {
   if (action === 'accept') return fa.issue.triageAccepted;
   if (action === 'request-info') return fa.issue.triageInfoRequested;
   if (action === 'duplicate') return fa.decisionQueues.triageDuplicated;
   if (action === 'split') return fa.decisionQueues.triageSplitSaved;
   if (action === 'snooze') return fa.decisionQueues.triageSnoozed;
   return fa.issue.triageDeclined;
}

function triageDialogIcon(action: TriageQueueAction) {
   if (action === 'accept') return <Check className="size-3.5" />;
   if (action === 'request-info') return <MessageSquareWarning className="size-3.5" />;
   if (action === 'duplicate') return <Copy className="size-3.5" />;
   if (action === 'split') return <ListPlus className="size-3.5" />;
   if (action === 'snooze') return <Clock3 className="size-3.5" />;
   return <X className="size-3.5" />;
}

function isActionableBacklogTask(task: TaskaraTask): boolean {
   if (task.status !== 'BACKLOG') return false;
   if (!task.triageState || task.triageState.status === 'OPEN') return true;
   if (task.triageState.status !== 'SNOOZED') return false;
   if (!task.triageState.snoozedUntil) return false;
   return Date.parse(task.triageState.snoozedUntil) <= Date.now();
}

function defaultTriageSnoozeLocalValue(): string {
   const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
   const offsetMs = date.getTimezoneOffset() * 60 * 1000;
   return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function defaultTriageSplitItems(): TriageSplitDraft[] {
   return [
      { title: '', description: '' },
      { title: '', description: '' },
   ];
}

function decisionQueuesRefreshSourceMatches(detail: WorkspaceRefreshDetail) {
   return (
      workspaceRefreshSourceMatches(detail, 'task') ||
      workspaceRefreshSourceMatches(detail, 'review') ||
      workspaceRefreshSourceMatches(detail, 'attention') ||
      workspaceRefreshSourceMatches(detail, 'project_health_update') ||
      workspaceRefreshSourceMatches(detail, 'meeting_action_item') ||
      workspaceRefreshSourceMatches(detail, 'task-sync-mutation')
   );
}
