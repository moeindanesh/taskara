import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw, Search, UserRoundCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatJalaliDateTime } from '@/lib/jalali';
import {
   supportAttentionLabels,
   supportDueLabel,
   supportPriorityLabels,
   supportPriorityTone,
   supportSourceLabels,
   supportStatusLabels,
   supportStatusTone,
} from '@/lib/support-presenters';
import type {
   SupportCase,
   SupportCasePriority,
   SupportCaseStatus,
   SupportDepartmentMember,
   SupportQueueKind,
} from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { cn } from '@/lib/utils';

const queueCopy: Record<SupportQueueKind, { empty: string; hint: string }> = {
   TRIAGE: {
      empty: 'پرونده‌ی بدون دپارتمان ندارید',
      hint: 'درخواست‌های تازه از API، تماس و ثبت دستی پس از دریافت اینجا دیده می‌شوند.',
   },
   DEPARTMENT_INBOX: {
      empty: 'صف دپارتمان خالی است',
      hint: 'پرونده‌هایی که به دپارتمان شما رسیده‌اند ولی هنوز مسئول ندارند اینجا می‌آیند.',
   },
   MY_CASES: {
      empty: 'پرونده‌ی بازی به شما سپرده نشده است',
      hint: 'واگذاری‌ها فقط برای خودتان نمایش داده می‌شوند؛ پرونده‌های سایر اعضا قابل مشاهده نیست.',
   },
   NEEDS_ATTENTION: {
      empty: 'مورد عقب‌افتاده‌ای پیدا نشد',
      hint: 'پرونده‌های بی‌پیگیری، دارای موعد گذشته، دوباره‌باز یا حل‌نشده اینجا جمع می‌شوند.',
   },
};

export function SupportCaseQueueView({ queue }: { queue: SupportQueueKind }) {
   const support = useSupportWorkspace();
   const [query, setQuery] = useState('');
   const [submittedQuery, setSubmittedQuery] = useState('');
   const [status, setStatus] = useState<SupportCaseStatus | ''>('');
   const [priority, setPriority] = useState<SupportCasePriority | ''>('');
   const [nextCursor, setNextCursor] = useState<string | null>(null);
   const [total, setTotal] = useState<number | undefined>();
   const [loading, setLoading] = useState(true);
   const [loadingMore, setLoadingMore] = useState(false);
   const [error, setError] = useState('');
   const cases = support.casesForQueue(queue);

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const page = await support.loadCases({
            queue,
            q: submittedQuery || undefined,
            status: status || undefined,
            priority: priority || undefined,
            limit: 50,
         });
         setNextCursor(page.nextCursor || null);
         setTotal(page.total);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری صف ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [priority, queue, status, submittedQuery, support.loadCases, support.state.syncRevision]);

   useEffect(() => {
      void load();
   }, [load]);

   useEffect(() => {
      if (queue !== 'DEPARTMENT_INBOX') return;
      const departmentIds = [...new Set(cases.flatMap((item) => item.departmentId ? [item.departmentId] : []))];
      for (const departmentId of departmentIds) {
         if (!support.state.membersByDepartmentId[departmentId]) {
            void support.loadDepartmentMembers(departmentId).catch(() => undefined);
         }
      }
   }, [cases, queue, support.loadDepartmentMembers, support.state.membersByDepartmentId]);

   async function loadMore() {
      if (!nextCursor || loadingMore) return;
      setLoadingMore(true);
      setError('');
      try {
         const page = await support.loadCases({
            queue,
            q: submittedQuery || undefined,
            status: status || undefined,
            priority: priority || undefined,
            cursor: nextCursor,
            limit: 50,
         });
         setNextCursor(page.nextCursor || null);
         setTotal(page.total);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری ادامه صف ناموفق بود.');
      } finally {
         setLoadingMore(false);
      }
   }

   function submitSearch(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setSubmittedQuery(query.trim());
   }

   const visibleCases = useMemo(() => cases, [cases]);

   return (
      <main dir="rtl" className="flex h-full min-h-0 flex-col bg-[#101011] text-zinc-200" data-testid={`support-queue-${queue.toLowerCase()}`}>
         <div className="flex flex-col gap-3 border-b border-white/7 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
            <form className="flex w-full max-w-xl items-center gap-2" role="search" onSubmit={submitSearch}>
               <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-zinc-600" />
                  <Input
                     aria-label="جستجو در پرونده‌ها"
                     className="h-9 border-white/10 bg-[#0a0a0b] pe-3 ps-9 text-sm text-zinc-100 placeholder:text-zinc-600"
                     placeholder="جستجو با عنوان، شماره یا مشتری…"
                     value={query}
                     onChange={(event) => setQuery(event.target.value)}
                  />
               </div>
               <Button className="border border-white/10 bg-white/8 text-zinc-200 hover:bg-white/12" type="submit" variant="secondary">
                  جستجو
               </Button>
            </form>
            <div className="flex shrink-0 items-center gap-2 overflow-x-auto pb-1 xl:pb-0">
               {typeof total === 'number' ? <span className="shrink-0 text-xs text-zinc-600">{total.toLocaleString('fa-IR')} پرونده</span> : null}
               <select aria-label="فیلتر وضعیت" className={filterClass} value={status} onChange={(event) => setStatus(event.target.value as SupportCaseStatus | '')}>
                  <option value="">همه وضعیت‌ها</option>
                  {Object.entries(supportStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
               </select>
               <select aria-label="فیلتر اولویت" className={filterClass} value={priority} onChange={(event) => setPriority(event.target.value as SupportCasePriority | '')}>
                  <option value="">همه اولویت‌ها</option>
                  {Object.entries(supportPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
               </select>
               <Button aria-label="تازه‌سازی صف" className="text-zinc-500 hover:bg-white/6 hover:text-zinc-200" size="icon" type="button" variant="ghost" onClick={() => void load()}>
                  <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
               </Button>
            </div>
         </div>

         {error ? (
            <div role="alert" className="m-4 flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200">
               <AlertTriangle className="mt-0.5 size-4 shrink-0" />
               <span>{error}</span>
            </div>
         ) : null}

         <div className="min-h-0 flex-1 overflow-auto">
            {loading && !visibleCases.length ? (
               <div className="flex h-56 items-center justify-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="size-4 animate-spin" /> در حال بارگذاری پرونده‌ها…
               </div>
            ) : visibleCases.length ? (
               <>
                  <div className="divide-y divide-white/6">
                     {visibleCases.map((item) => (
                        <SupportCaseRow
                           key={item.id}
                           item={item}
                           queue={queue}
                           members={item.departmentId ? support.state.membersByDepartmentId[item.departmentId] || [] : []}
                           onChanged={load}
                        />
                     ))}
                  </div>
                  {nextCursor ? (
                     <div className="flex justify-center border-t border-white/6 p-4">
                        <Button className="border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" disabled={loadingMore} type="button" variant="secondary" onClick={() => void loadMore()}>
                           {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
                           نمایش پرونده‌های بیشتر
                        </Button>
                     </div>
                  ) : null}
               </>
            ) : (
               <SupportQueueEmptyState queue={queue} />
            )}
         </div>
      </main>
   );
}

export function SupportQueueEmptyState({ queue }: { queue: SupportQueueKind }) {
   return (
      <div dir="rtl" className="flex min-h-[320px] items-center justify-center p-4 text-center sm:min-h-[360px] sm:p-6" data-testid="support-queue-empty">
         <div className="max-w-md">
            <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-white/5 text-zinc-500"><Inbox className="size-5" /></span>
            <h2 className="mt-4 text-sm font-semibold text-zinc-300">{queueCopy[queue].empty}</h2>
            <p className="mt-2 text-sm leading-7 text-zinc-600">{queueCopy[queue].hint}</p>
         </div>
      </div>
   );
}

function SupportCaseRow({ item, members, onChanged, queue }: {
   item: SupportCase;
   members: readonly SupportDepartmentMember[];
   onChanged: () => Promise<void>;
   queue: SupportQueueKind;
}) {
   const runtime = useWorkspaceRuntime();
   const dueAt = item.nextSlaDueAt || item.nextActionAt;
   const isLate = Boolean(dueAt && new Date(dueAt).getTime() < Date.now());
   const customer = item.contact?.name || item.contact?.phone || item.contact?.email;
   const assignee = item.assignee || item.assigneeMembership;

   return (
      <article className="group grid min-h-[88px] grid-cols-1 gap-3 px-4 py-3 transition hover:bg-white/[0.025] lg:grid-cols-[minmax(0,1fr)_160px_150px] lg:items-center xl:grid-cols-[minmax(0,1fr)_170px_150px_180px]" data-testid={`support-case-${item.key}`}>
         <Link className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50" to={`/${runtime.workspaceSlug}/support/cases/${encodeURIComponent(item.key)}`}>
            <div className="flex min-w-0 items-center gap-2">
               <bdi dir="ltr" className="shrink-0 font-mono text-xs text-zinc-500">{item.key}</bdi>
               <h2 className="truncate text-sm font-medium text-zinc-200 group-hover:text-white">{item.title}</h2>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-600">
               <span>{supportSourceLabels[item.sourceChannel]}</span>
               {customer ? (
                  <bdi
                     dir={item.contact?.name ? 'auto' : 'ltr'}
                     className={cn('max-w-52 truncate', !item.contact?.name && 'text-left')}
                  >
                     {customer}
                  </bdi>
               ) : null}
               <span>{formatJalaliDateTime(item.receivedAt)}</span>
            </div>
            {queue === 'NEEDS_ATTENTION' && item.attentionReasons?.length ? (
               <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.attentionReasons.slice(0, 3).map((reason) => (
                     <Badge key={reason} variant="outline" className="border-amber-300/15 bg-amber-300/5 text-[10px] text-amber-200/80">
                        {supportAttentionLabels[reason]}
                     </Badge>
                  ))}
               </div>
            ) : null}
         </Link>
         <div className="flex min-w-0 items-center gap-2 lg:block">
            <span className="text-xs text-zinc-600 lg:hidden">مسئول:</span>
            <div className="truncate text-xs text-zinc-400">{assignee?.user?.name || item.department?.name || (item.departmentId ? 'صف دپارتمان' : 'بدون دپارتمان')}</div>
         </div>
         <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn('border px-2 py-0.5 text-[11px]', supportStatusTone(item.status))}>{supportStatusLabels[item.status]}</Badge>
            <span className={cn('text-xs', supportPriorityTone(item.priority))}>{supportPriorityLabels[item.priority]}</span>
            <span className={cn('text-xs xl:hidden', isLate ? 'font-medium text-red-300' : 'text-zinc-500')}>{supportDueLabel(dueAt)}</span>
         </div>
         <div className="flex min-w-0 flex-col gap-2">
            <span className={cn('hidden text-xs xl:block', isLate ? 'font-medium text-red-300' : 'text-zinc-500')}>{supportDueLabel(dueAt)}</span>
            {queue === 'TRIAGE' ? <TriageAction item={item} onChanged={onChanged} /> : null}
            {queue === 'DEPARTMENT_INBOX' ? <DepartmentAssignAction item={item} members={members} onChanged={onChanged} /> : null}
         </div>
      </article>
   );
}

function TriageAction({ item, onChanged }: { item: SupportCase; onChanged: () => Promise<void> }) {
   const support = useSupportWorkspace();
   const [departmentId, setDepartmentId] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   async function route() {
      if (!departmentId || submitting) return;
      setSubmitting(true);
      setError('');
      try {
         await support.routeCase(item, { targetDepartmentId: departmentId, targetAssigneeMembershipId: null });
         await onChanged();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ارجاع پرونده ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <div className="grid min-w-0 gap-1.5" data-testid={`triage-action-${item.key}`}>
         <div className="flex min-w-0 items-center gap-1.5">
            <select aria-label={`دپارتمان مقصد ${item.key}`} className={cn(filterClass, 'min-w-0 flex-1')} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
               <option value="">انتخاب دپارتمان</option>
               {support.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
            <Button aria-label={`ارجاع ${item.key}`} className="size-9 shrink-0 bg-indigo-400/15 text-indigo-200 hover:bg-indigo-400/25" disabled={!departmentId || submitting} size="icon" type="button" onClick={() => void route()}>
               {submitting ? <Loader2 className="size-4 animate-spin" /> : <UserRoundCheck className="size-4" />}
            </Button>
         </div>
         {error ? <p role="alert" className="text-[11px] leading-5 text-red-300">{error}</p> : null}
      </div>
   );
}

function DepartmentAssignAction({ item, members, onChanged }: {
   item: SupportCase;
   members: readonly SupportDepartmentMember[];
   onChanged: () => Promise<void>;
}) {
   const support = useSupportWorkspace();
   const [membershipId, setMembershipId] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   async function assign() {
      if (!item.departmentId || !membershipId || submitting) return;
      setSubmitting(true);
      setError('');
      try {
         await support.routeCase(item, { targetDepartmentId: item.departmentId, targetAssigneeMembershipId: membershipId });
         await onChanged();
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'واگذاری پرونده ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <div className="grid min-w-0 gap-1.5" data-testid={`department-action-${item.key}`}>
         <div className="flex min-w-0 items-center gap-1.5">
            <select aria-label={`مسئول پرونده ${item.key}`} className={cn(filterClass, 'min-w-0 flex-1')} value={membershipId} onChange={(event) => setMembershipId(event.target.value)}>
               <option value="">انتخاب مسئول</option>
               {members.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.user?.name || member.userId}</option>)}
            </select>
            <Button aria-label={`واگذاری ${item.key}`} className="size-9 shrink-0 bg-indigo-400/15 text-indigo-200 hover:bg-indigo-400/25" disabled={!membershipId || submitting} size="icon" type="button" onClick={() => void assign()}>
               {submitting ? <Loader2 className="size-4 animate-spin" /> : <UserRoundCheck className="size-4" />}
            </Button>
         </div>
         {error ? <p role="alert" className="text-[11px] leading-5 text-red-300">{error}</p> : null}
      </div>
   );
}

const filterClass = 'h-9 rounded-md border border-white/10 bg-[#0a0a0b] px-3 text-xs text-zinc-400 outline-none focus:border-indigo-400/40';
