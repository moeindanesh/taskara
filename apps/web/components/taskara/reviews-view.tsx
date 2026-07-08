'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
   ArrowUpRight,
   CheckCircle2,
   CircleDot,
   GitPullRequest,
   MessageSquareWarning,
   RefreshCw,
   Timer,
   XCircle,
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
import { Textarea } from '@/components/ui/textarea';
import {
   LinearAvatar,
   ProjectGlyph,
   StatusIcon,
   linearPriorityMeta,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { IssueTitleTooltip } from '@/components/taskara/issue-title-tooltip';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate, formatJalaliDateTime } from '@/lib/jalali';
import { dispatchWorkspaceRefresh } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraTaskReview } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type ReviewFilter = 'REQUESTED' | 'ALL';
type ReviewDecision = 'approve' | 'request-changes' | 'cancel';

const numberFormatter = new Intl.NumberFormat('fa-IR');
const reviewListLimit = 80;

export function ReviewsView() {
   const { orgId = 'taskara' } = useParams();
   const [filter, setFilter] = useState<ReviewFilter>('REQUESTED');
   const [reviews, setReviews] = useState<TaskaraTaskReview[]>([]);
   const [total, setTotal] = useState(0);
   const [loading, setLoading] = useState(true);
   const [refreshing, setRefreshing] = useState(false);
   const [error, setError] = useState('');
   const [decision, setDecision] = useState<{ review: TaskaraTaskReview; action: ReviewDecision } | null>(null);
   const [decisionComment, setDecisionComment] = useState('');
   const [decidingId, setDecidingId] = useState<string | null>(null);
   const requestRef = useRef(0);

   const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial', nextFilter = filter) => {
      const requestId = ++requestRef.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      setError('');

      try {
         const query = new URLSearchParams({ limit: String(reviewListLimit) });
         if (nextFilter === 'REQUESTED') query.set('status', 'REQUESTED');
         const result = await taskaraRequest<{
            items: TaskaraTaskReview[];
            total: number;
            limit: number;
            offset: number;
         }>(`/reviews/mine?${query.toString()}`);
         if (requestId !== requestRef.current) return;
         setReviews(result.items);
         setTotal(result.total);
      } catch (loadError) {
         if (requestId === requestRef.current) {
            setError(loadError instanceof Error ? loadError.message : fa.reviews.loadFailed);
         }
      } finally {
         if (requestId === requestRef.current) {
            setLoading(false);
            setRefreshing(false);
         }
      }
   }, [filter]);

   useEffect(() => {
      void load('initial', filter);
   }, [filter, load]);

   const metrics = useMemo(() => reviewMetrics(reviews), [reviews]);

   async function submitDecision(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!decision || decidingId) return;
      await runDecision(decision.review, decision.action, decisionComment.trim() || undefined);
   }

   async function runDecision(review: TaskaraTaskReview, action: ReviewDecision, comment?: string) {
      setDecidingId(review.id);
      try {
         const updated = await taskaraRequest<TaskaraTaskReview>(`/reviews/${encodeURIComponent(review.id)}/${action}`, {
            method: 'POST',
            body: JSON.stringify({ comment }),
         });
         setReviews((current) => {
            if (filter === 'REQUESTED' && updated.status !== 'REQUESTED') {
               return current.filter((item) => item.id !== updated.id);
            }
            return current.map((item) => (item.id === updated.id ? updated : item));
         });
         setDecision(null);
         setDecisionComment('');
         dispatchWorkspaceRefresh({ source: `review:${action}` });
         toast.success(reviewDecisionSuccess(action));
      } catch (decisionError) {
         toast.error(decisionError instanceof Error ? decisionError.message : fa.reviews.decisionFailed);
      } finally {
         setDecidingId(null);
      }
   }

   return (
      <div className="flex min-h-full flex-col bg-background text-zinc-900 dark:bg-[#101011] dark:text-zinc-100" data-testid="reviews-screen">
         <div className="sticky top-0 z-10 border-b border-zinc-200 bg-background/95 px-4 py-3 backdrop-blur dark:border-white/8 dark:bg-[#101011]/95 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
               <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                     <span>{fa.reviews.description}</span>
                     <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/8">
                        {fa.reviews.visibleCount(total)}
                     </span>
                  </div>
               </div>
               <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-100 p-0.5 dark:border-white/8 dark:bg-white/5">
                     <button
                        className={filterButtonClassName(filter === 'REQUESTED')}
                        type="button"
                        onClick={() => setFilter('REQUESTED')}
                     >
                        {fa.reviews.requested}
                     </button>
                     <button
                        className={filterButtonClassName(filter === 'ALL')}
                        type="button"
                        onClick={() => setFilter('ALL')}
                     >
                        {fa.reviews.all}
                     </button>
                  </div>
                  <Button size="xs" variant="outline" className="h-8 gap-1.5" onClick={() => void load('refresh')} disabled={refreshing}>
                     <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                     {fa.reviews.refresh}
                  </Button>
               </div>
            </div>
         </div>

         <main className="space-y-4 p-4 sm:p-6">
            {error ? (
               <div className="rounded-md border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
                  {error}
               </div>
            ) : null}

            <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
               <MetricTile icon={GitPullRequest} label={fa.reviews.pendingMetric} value={metrics.pending} tone={metrics.pending ? 'warning' : 'default'} />
               <MetricTile icon={Timer} label={fa.reviews.overdueMetric} value={metrics.overdue} tone={metrics.overdue ? 'danger' : 'default'} />
               <MetricTile icon={MessageSquareWarning} label={fa.reviews.changesMetric} value={metrics.changesRequested} tone={metrics.changesRequested ? 'warning' : 'default'} />
               <MetricTile icon={CheckCircle2} label={fa.reviews.doneMetric} value={metrics.done} tone="default" />
            </section>

            <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-white/8 dark:bg-[#161618]">
               <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-white/7">
                  <div className="min-w-0">
                     <h2 className="flex items-center gap-2 text-sm font-semibold">
                        <GitPullRequest className="size-4 text-zinc-500" />
                        {filter === 'REQUESTED' ? fa.reviews.requestedTitle : fa.reviews.allTitle}
                     </h2>
                     <p className="mt-1 text-xs leading-5 text-zinc-500">
                        {filter === 'REQUESTED' ? fa.reviews.requestedDescription : fa.reviews.allDescription}
                     </p>
                  </div>
               </header>
               <div className="p-4">
                  {loading ? (
                     <ReviewsSkeleton />
                  ) : reviews.length ? (
                     <div className="divide-y divide-zinc-200 dark:divide-white/7">
                        {reviews.map((review) => (
                           <ReviewRow
                              deciding={decidingId === review.id}
                              key={review.id}
                              orgId={orgId}
                              review={review}
                              onApprove={(item) => void runDecision(item, 'approve')}
                              onOpenDecision={(item, action) => {
                                 setDecision({ review: item, action });
                                 setDecisionComment('');
                              }}
                           />
                        ))}
                     </div>
                  ) : (
                     <EmptyReviews />
                  )}
               </div>
            </section>
         </main>

         <Dialog open={Boolean(decision)} onOpenChange={(open) => !open && setDecision(null)}>
            <DialogContent className="max-w-lg [direction:rtl]">
               <form onSubmit={submitDecision}>
                  <DialogHeader>
                     <DialogTitle>{decision ? reviewDecisionTitle(decision.action) : fa.reviews.decisionTitle}</DialogTitle>
                     <DialogDescription>{decision ? reviewDecisionDescription(decision.action) : fa.reviews.decisionDescription}</DialogDescription>
                  </DialogHeader>
                  <Textarea
                     autoFocus
                     className="mt-4 min-h-28 resize-none"
                     placeholder={fa.reviews.commentPlaceholder}
                     value={decisionComment}
                     onChange={(event) => setDecisionComment(event.target.value)}
                  />
                  <DialogFooter className="mt-4">
                     <Button type="button" variant="outline" onClick={() => setDecision(null)}>
                        {fa.app.cancel}
                     </Button>
                     <Button disabled={Boolean(decidingId)}>
                        {decision ? reviewDecisionSubmit(decision.action) : fa.app.confirm}
                     </Button>
                  </DialogFooter>
               </form>
            </DialogContent>
         </Dialog>
      </div>
   );
}

function ReviewRow({
   deciding,
   onApprove,
   onOpenDecision,
   orgId,
   review,
}: {
   deciding: boolean;
   onApprove: (review: TaskaraTaskReview) => void;
   onOpenDecision: (review: TaskaraTaskReview, action: Exclude<ReviewDecision, 'approve'>) => void;
   orgId: string;
   review: TaskaraTaskReview;
}) {
   const task = review.task;
   const priorityMeta = task ? linearPriorityMeta[task.priority] : null;
   const PriorityIcon = priorityMeta?.icon || CircleDot;

   return (
      <div className="grid gap-3 py-3 first:pt-0 last:pb-0 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.65fr)_auto] xl:items-center">
         <div className="min-w-0">
            <div className="mb-1 flex min-w-0 items-center gap-2">
               {task ? <StatusIcon status={task.status} className="size-4 shrink-0" /> : <GitPullRequest className="size-4 shrink-0 text-zinc-500" />}
               {task ? (
                  <IssueTitleTooltip title={task.title}>
                     <Link
                        to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}
                        className="min-w-0 truncate text-sm font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-300"
                     >
                        <span className="font-mono text-xs text-zinc-500">{task.key}</span>
                        <span className="px-1.5 text-zinc-400">·</span>
                        {task.title}
                     </Link>
                  </IssueTitleTooltip>
               ) : (
                  <span className="truncate text-sm font-medium">{fa.reviews.missingTask}</span>
               )}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-zinc-500">
               {task?.project ? (
                  <span className="inline-flex max-w-full items-center gap-1 truncate">
                     <ProjectGlyph name={task.project.name} className="size-3.5 shrink-0 rounded-sm" iconClassName="size-2.5" />
                     <span className="truncate">{task.project.name}</span>
                  </span>
               ) : null}
               {task ? (
                  <>
                     <span className="inline-flex items-center gap-1">
                        <PriorityIcon className={cn('size-3.5', priorityMeta?.className || 'text-zinc-500')} />
                        {priorityMeta?.label || task.priority}
                     </span>
                     <span>{linearStatusMeta[task.status]?.label || task.status}</span>
                  </>
               ) : null}
            </div>
         </div>

         <div className="flex min-w-0 flex-wrap gap-1.5 text-xs text-zinc-500">
            <ReviewStatusPill review={review} />
            {review.requester ? (
               <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/8">
                  <LinearAvatar name={review.requester.name} src={review.requester.avatarUrl} className="size-4 shrink-0" />
                  <span className="truncate">{fa.reviews.requester(review.requester.name)}</span>
               </span>
            ) : null}
            <span className="rounded-full border border-zinc-200 px-2 py-0.5 dark:border-white/8">
               {fa.reviews.requestedAt(formatJalaliDate(review.requestedAt))}
            </span>
            {review.dueAt ? (
               <span className={cn('rounded-full border px-2 py-0.5', reviewDueClassName(review.dueAt))}>
                  {fa.reviews.dueAt(formatJalaliDate(review.dueAt))}
               </span>
            ) : null}
         </div>

         <div className="flex flex-wrap items-center justify-start gap-1.5 xl:justify-end">
            {task ? (
               <Button asChild size="xs" variant="ghost" className="h-7">
                  <Link to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}>
                     {fa.reviews.openTask}
                     <ArrowUpRight className="size-3.5" />
                  </Link>
               </Button>
            ) : null}
            {review.status === 'REQUESTED' ? (
               <>
                  <Button size="xs" className="h-7 bg-emerald-600 hover:bg-emerald-500" disabled={deciding} onClick={() => onApprove(review)}>
                     <CheckCircle2 className="size-3.5" />
                     {fa.reviews.approve}
                  </Button>
                  <Button size="xs" variant="outline" className="h-7" disabled={deciding} onClick={() => onOpenDecision(review, 'request-changes')}>
                     <MessageSquareWarning className="size-3.5" />
                     {fa.reviews.requestChanges}
                  </Button>
                  <Button size="xs" variant="ghost" className="h-7 text-zinc-500" disabled={deciding} onClick={() => onOpenDecision(review, 'cancel')}>
                     <XCircle className="size-3.5" />
                     {fa.reviews.cancelReview}
                  </Button>
               </>
            ) : null}
         </div>
      </div>
   );
}

function ReviewStatusPill({ review }: { review: TaskaraTaskReview }) {
   const label = reviewStatusLabel(review.status);
   return (
      <span className={cn('rounded-full border px-2 py-0.5', reviewStatusClassName(review.status))}>
         {label}
      </span>
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

function EmptyReviews() {
   return (
      <div className="rounded-md border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-white/10">
         <CheckCircle2 className="mx-auto mb-2 size-5 text-emerald-500" />
         <div className="text-sm font-medium">{fa.reviews.emptyTitle}</div>
         <div className="mx-auto mt-1 max-w-md text-xs leading-5 text-zinc-500">{fa.reviews.emptyDescription}</div>
      </div>
   );
}

function ReviewsSkeleton() {
   return (
      <div className="space-y-3">
         {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-20 animate-pulse rounded-lg bg-zinc-100 dark:bg-white/5" />
         ))}
      </div>
   );
}

function reviewMetrics(reviews: TaskaraTaskReview[]) {
   const now = Date.now();
   return {
      pending: reviews.filter((review) => review.status === 'REQUESTED').length,
      overdue: reviews.filter((review) => review.status === 'REQUESTED' && review.dueAt && Date.parse(review.dueAt) < now).length,
      changesRequested: reviews.filter((review) => review.status === 'CHANGES_REQUESTED').length,
      done: reviews.filter((review) => review.status === 'APPROVED' || review.status === 'CANCELED').length,
   };
}

function filterButtonClassName(active: boolean) {
   return cn(
      'h-7 rounded px-2.5 text-xs font-medium transition-colors',
      active ? 'bg-white text-zinc-950 shadow-sm dark:bg-white/12 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
   );
}

function reviewDueClassName(value: string) {
   if (Date.parse(value) < Date.now()) return 'border-rose-300/60 bg-rose-300/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-200';
   return 'border-zinc-200 dark:border-white/8';
}

function metricToneClassName(tone: 'default' | 'warning' | 'danger') {
   if (tone === 'danger') return 'border-rose-300/70 bg-rose-300/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-200';
   if (tone === 'warning') return 'border-amber-300/70 bg-amber-300/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-200';
   return 'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-white/8 dark:bg-white/5 dark:text-zinc-300';
}

function reviewStatusClassName(status: TaskaraTaskReview['status']) {
   switch (status) {
      case 'REQUESTED':
         return 'border-amber-300/60 bg-amber-300/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-200';
      case 'CHANGES_REQUESTED':
         return 'border-sky-300/60 bg-sky-300/10 text-sky-700 dark:border-sky-400/20 dark:text-sky-200';
      case 'APPROVED':
         return 'border-emerald-300/60 bg-emerald-300/10 text-emerald-700 dark:border-emerald-400/20 dark:text-emerald-200';
      case 'CANCELED':
         return 'border-zinc-200 text-zinc-500 dark:border-white/8';
   }
}

function reviewStatusLabel(status: TaskaraTaskReview['status']) {
   switch (status) {
      case 'REQUESTED':
         return fa.reviews.statusRequested;
      case 'CHANGES_REQUESTED':
         return fa.reviews.statusChangesRequested;
      case 'APPROVED':
         return fa.reviews.statusApproved;
      case 'CANCELED':
         return fa.reviews.statusCanceled;
   }
}

function reviewDecisionTitle(action: ReviewDecision) {
   if (action === 'approve') return fa.reviews.approveTitle;
   if (action === 'request-changes') return fa.reviews.requestChangesTitle;
   return fa.reviews.cancelTitle;
}

function reviewDecisionDescription(action: ReviewDecision) {
   if (action === 'approve') return fa.reviews.approveDescription;
   if (action === 'request-changes') return fa.reviews.requestChangesDescription;
   return fa.reviews.cancelDescription;
}

function reviewDecisionSubmit(action: ReviewDecision) {
   if (action === 'approve') return fa.reviews.approve;
   if (action === 'request-changes') return fa.reviews.requestChanges;
   return fa.reviews.cancelReview;
}

function reviewDecisionSuccess(action: ReviewDecision) {
   if (action === 'approve') return fa.reviews.approvedToast;
   if (action === 'request-changes') return fa.reviews.changesRequestedToast;
   return fa.reviews.canceledToast;
}
