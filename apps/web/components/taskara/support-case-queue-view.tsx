import { useCallback, useEffect, useRef, useState } from 'react';
import { Input, TextField } from '@heroui/react';
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, Clock3, Inbox, Loader2, Plus, RefreshCw, Search, SlidersHorizontal, UserRoundCheck, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { SupportButton, SupportSelect } from './support-ui';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportAttentionLabels, supportDueLabel, supportPriorityLabels, supportPriorityTone, supportQueueLabels, supportStatusLabels, supportStatusTone } from '@/lib/support-presenters';
import type { SupportCase, SupportCasePriority, SupportCaseStatus, SupportDepartmentMember, SupportQueueKind } from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { useWorkspaceNavigationRuntime, useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { workspaceCreateAction } from '@/lib/workspace-navigation';
import { cn } from '@/lib/utils';

const queueCopy: Record<SupportQueueKind, { description: string; empty: string; hint: string }> = {
   TRIAGE: { description: 'درخواست‌های تازه را بررسی کنید و به دپارتمان مناسب بسپارید.', empty: 'پرونده‌ی بدون دپارتمان ندارید', hint: 'درخواست‌های تازه پس از دریافت اینجا دیده می‌شوند.' },
   DEPARTMENT_INBOX: { description: 'پرونده‌های آماده واگذاری به کارشناسان دپارتمان.', empty: 'صف دپارتمان خالی است', hint: 'پرونده‌های دپارتمان که هنوز مسئول ندارند اینجا می‌آیند.' },
   MY_CASES: { description: 'پرونده‌هایی که مسئول پیگیری آن‌ها هستید.', empty: 'پرونده‌ی بازی به شما سپرده نشده است', hint: 'واگذاری‌ها فقط برای خودتان نمایش داده می‌شوند؛ پرونده‌های سایر اعضا قابل مشاهده نیست.' },
   NEEDS_ATTENTION: { description: 'پرونده‌هایی که برای ادامه رسیدگی به توجه شما نیاز دارند.', empty: 'همه‌چیز در مسیر است', hint: 'در حال حاضر پرونده‌ای نیازمند پیگیری نیست.' },
};

export function SupportCaseQueueView({ queue }: { queue: SupportQueueKind }) {
   // Remount on queue changes so drafts, pagination and pending requests cannot bleed across queues.
   return <CaseQueue key={queue} queue={queue} />;
}

function CaseQueue({ queue }: { queue: SupportQueueKind }) {
   const support = useSupportWorkspace();
   const navigation = useWorkspaceNavigationRuntime();
   const createAction = workspaceCreateAction(navigation);
   const [params, setParams] = useSearchParams();
   const submittedQuery = params.get('q') || '';
   const status = validFilter(params.get('status'), supportStatusLabels);
   const priority = validFilter(params.get('priority'), supportPriorityLabels);
   const [query, setQuery] = useState(submittedQuery);
   const [filtersOpen, setFiltersOpen] = useState(Boolean(status || priority));
   const [nextCursor, setNextCursor] = useState<string | null>(null);
   const [total, setTotal] = useState<number>();
   const [loading, setLoading] = useState(true);
   const [loadingMore, setLoadingMore] = useState(false);
   const [error, setError] = useState('');
   const requestId = useRef(0);
   const cases = support.casesForQueue(queue);
   const filtered = Boolean(submittedQuery || status || priority);
   const filterCount = Number(Boolean(status)) + Number(Boolean(priority));

   function updateFilter(key: string, value: string) {
      setParams((current) => {
         const next = new URLSearchParams(current);
         if (value) next.set(key, value); else next.delete(key);
         return next;
      }, { replace: true });
   }

   useEffect(() => { setQuery(submittedQuery); }, [submittedQuery]);
   useEffect(() => {
      if (query.trim() === submittedQuery) return;
      const timer = window.setTimeout(() => {
         setParams((current) => {
            const next = new URLSearchParams(current);
            if (query.trim()) next.set('q', query.trim()); else next.delete('q');
            return next;
         }, { replace: true });
      }, 300);
      return () => window.clearTimeout(timer);
   }, [query, submittedQuery, setParams]);

   const load = useCallback(async () => {
      const id = ++requestId.current;
      setLoading(true);
      setLoadingMore(false);
      setError('');
      setNextCursor(null);
      try {
         const page = await support.loadCases({ queue, q: submittedQuery || undefined, status: status || undefined, priority: priority || undefined, limit: 50 });
         if (id !== requestId.current) return;
         setNextCursor(page.nextCursor || null);
         setTotal(page.total);
      } catch (caught) {
         if (id === requestId.current) setError(caught instanceof Error ? caught.message : 'بارگذاری صف ناموفق بود.');
      } finally {
         if (id === requestId.current) setLoading(false);
      }
   }, [priority, queue, status, submittedQuery, support.loadCases, support.state.syncRevision]);

   useEffect(() => { void load(); return () => { requestId.current++; }; }, [load]);
   useEffect(() => {
      if (queue !== 'DEPARTMENT_INBOX') return;
      const ids = [...new Set(cases.flatMap((item) => item.departmentId ? [item.departmentId] : []))];
      for (const id of ids) if (!support.state.membersByDepartmentId[id]) void support.loadDepartmentMembers(id).catch(() => undefined);
   }, [cases, queue, support.loadDepartmentMembers, support.state.membersByDepartmentId]);

   async function loadMore() {
      if (!nextCursor || loadingMore || loading) return;
      const id = requestId.current;
      setLoadingMore(true);
      setError('');
      try {
         const page = await support.loadCases({ queue, q: submittedQuery || undefined, status: status || undefined, priority: priority || undefined, cursor: nextCursor, limit: 50 });
         if (id !== requestId.current) return;
         setNextCursor(page.nextCursor || null);
         setTotal(page.total);
      } catch (caught) {
         if (id === requestId.current) setError(caught instanceof Error ? caught.message : 'بارگذاری ادامه صف ناموفق بود.');
      } finally { if (id === requestId.current) setLoadingMore(false); }
   }

   function resetFilters() {
      setQuery('');
      setParams({}, { replace: true });
   }

   return (
      <main dir="rtl" className="support-queue flex h-full min-h-0 flex-col bg-background text-foreground" data-testid={`support-queue-${queue.toLowerCase()}`}>
         <header className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-7">
            <SidebarTrigger aria-label="باز و بسته کردن منوی کناری" className="shrink-0 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">پشتیبانی</span>
            <ChevronLeft className="size-3.5 text-muted-foreground/60" />
            <span className="truncate text-sm font-medium">{supportQueueLabels[queue]}</span>
         </header>
         <div className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-8 sm:py-8">
               <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
                  <div>
                     <div className="flex items-center gap-3">
                        <h1 className="text-2xl font-bold tracking-tight">{supportQueueLabels[queue]}</h1>
                        {typeof total === 'number' ? <span className="rounded-md bg-secondary px-2 py-0.5 text-xs tabular-nums text-muted-foreground" aria-label={`${total} پرونده`}>{total.toLocaleString('fa-IR')}</span> : null}
                     </div>
                     <p className="mt-2 text-sm leading-6 text-muted-foreground">{queueCopy[queue].description}</p>
                  </div>
                  {createAction ? <SupportButton className="lg:hidden" onPress={() => window.dispatchEvent(new CustomEvent(createAction.eventName))}><Plus className="size-4" />پرونده جدید</SupportButton> : null}
               </div>
               <div className="mb-4 flex items-center gap-2">
                  <TextField aria-label="جستجو در پرونده‌ها" className="support-ui relative min-w-0 flex-1 sm:max-w-sm" value={query} onChange={setQuery}>
                     <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                     <Input type="search" className="h-10 w-full rounded-lg border border-border bg-background pe-9 ps-9 shadow-none" placeholder="جستجو در پرونده‌ها…" />
                     {query ? <SupportButton aria-label="پاک کردن جستجو" className="absolute end-1 top-1 size-8 min-w-0" isIconOnly size="sm" variant="ghost" onPress={() => { setQuery(''); updateFilter('q', ''); }}><X className="size-3.5" /></SupportButton> : null}
                  </TextField>
                  <SupportButton aria-expanded={filtersOpen} aria-controls="queue-filters" variant={filterCount ? 'secondary' : 'tertiary'} className="h-10" onPress={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal className="size-4" /><span>فیلتر</span>{filterCount ? <span className="text-xs">{filterCount.toLocaleString('fa-IR')}</span> : null}</SupportButton>
                  <SupportButton aria-label="تازه‌سازی صف" isIconOnly isDisabled={loading} variant="ghost" className="ms-auto size-10 shrink-0 text-muted-foreground" onPress={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></SupportButton>
               </div>
               {filtersOpen ? <div id="queue-filters" className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-secondary/40 p-3">
                  <SupportSelect className="w-full sm:w-44" label="فیلتر وضعیت" placeholder="همه وضعیت‌ها" value={status} onChange={(value) => updateFilter('status', value)} options={[{ value: '', label: 'همه وضعیت‌ها' }, ...Object.entries(supportStatusLabels).map(([value, label]) => ({ value, label }))]} />
                  <SupportSelect className="w-full sm:w-40" label="فیلتر اولویت" placeholder="همه اولویت‌ها" value={priority} onChange={(value) => updateFilter('priority', value)} options={[{ value: '', label: 'همه اولویت‌ها' }, ...Object.entries(supportPriorityLabels).map(([value, label]) => ({ value, label }))]} />
                  {filtered ? <SupportButton size="sm" variant="ghost" onPress={resetFilters}>پاک کردن فیلترها<X className="size-3.5" /></SupportButton> : null}
               </div> : null}
               {error ? <div role="alert" className="mb-4 flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"><AlertTriangle className="size-4 shrink-0" /><span className="flex-1">{error}</span><SupportButton size="sm" variant="tertiary" onPress={() => void load()}>تلاش دوباره</SupportButton></div> : null}
               <section aria-label={supportQueueLabels[queue]} aria-busy={loading} className="overflow-hidden rounded-xl border border-border bg-background">
                  <div className="support-queue-grid hidden border-b border-border bg-secondary/45 px-4 py-3 text-xs font-medium text-muted-foreground lg:grid">
                     <span>پرونده</span><span>وضعیت</span><span>مسئول</span><span>{queue === 'TRIAGE' ? 'ارجاع به دپارتمان' : queue === 'DEPARTMENT_INBOX' ? 'واگذاری' : 'پیگیری بعدی'}</span>
                  </div>
                  {loading ? <div role="status" className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />در حال بارگذاری پرونده‌ها…</div>
                     : cases.length ? <div className="divide-y divide-border">{cases.map((item) => <SupportCaseRow key={item.id} item={item} queue={queue} members={item.departmentId ? support.state.membersByDepartmentId[item.departmentId] || [] : []} onChanged={load} />)}</div>
                     : !error ? filtered ? <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"><Search className="size-6 text-muted-foreground" /><h2 className="font-semibold">پرونده‌ای با این مشخصات پیدا نشد</h2><p className="text-sm text-muted-foreground">عبارت جستجو یا فیلترها را تغییر دهید.</p><SupportButton variant="tertiary" onPress={resetFilters}>پاک کردن جستجو و فیلترها</SupportButton></div> : <SupportQueueEmptyState queue={queue} /> : null}
               </section>
               <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground" aria-live="polite">
                  <span>{!loading && !error ? `${cases.length.toLocaleString('fa-IR')} پرونده${typeof total === 'number' ? ` از ${total.toLocaleString('fa-IR')}` : ''}` : ''}</span>
                  {nextCursor ? <SupportButton size="sm" variant="tertiary" isDisabled={loadingMore || loading} onPress={() => void loadMore()}>{loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}نمایش پرونده‌های بیشتر</SupportButton> : <span className="hidden sm:inline">برای مشاهده و پیگیری، پرونده را باز کنید.</span>}
               </div>
            </div>
         </div>
      </main>
   );
}

function validFilter<T extends string>(value: string | null, labels: Record<T, string>): T | '' {
   return value && Object.prototype.hasOwnProperty.call(labels, value) ? value as T : '';
}

export function SupportQueueEmptyState({ queue }: { queue: SupportQueueKind }) {
   return <div dir="rtl" className="flex min-h-[320px] items-center justify-center p-4 text-center sm:min-h-[360px] sm:p-6" data-testid="support-queue-empty"><div className="max-w-sm"><span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">{queue === 'NEEDS_ATTENTION' ? <Check className="size-6" /> : <Inbox className="size-6" />}</span><h2 className="mt-4 text-base font-semibold">{queueCopy[queue].empty}</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">{queueCopy[queue].hint}</p></div></div>;
}

function SupportCaseRow({ item, members, onChanged, queue }: { item: SupportCase; members: readonly SupportDepartmentMember[]; onChanged: () => Promise<void>; queue: SupportQueueKind }) {
   const runtime = useWorkspaceRuntime();
   const dueAt = item.nextSlaDueAt && item.nextActionAt ? (new Date(item.nextSlaDueAt) < new Date(item.nextActionAt) ? item.nextSlaDueAt : item.nextActionAt) : item.nextSlaDueAt || item.nextActionAt;
   const isLate = Boolean(dueAt && new Date(dueAt).getTime() < Date.now());
   const customer = item.contact?.name || item.contact?.phone || item.contact?.email;
   const assignee = item.assignee || item.assigneeMembership;
   const reasons = queue === 'NEEDS_ATTENTION' ? item.attentionReasons || [] : [];
   return (
      <article className="support-queue-grid group grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-3.5 transition-colors hover:bg-secondary/35 lg:items-center lg:gap-5" data-testid={`support-case-${item.key}`}>
         <Link className="col-span-3 min-w-0 rounded-md lg:col-span-1" to={`/${runtime.workspaceSlug}/support/cases/${encodeURIComponent(item.key)}`}>
            <div className="flex items-start gap-2.5">
               <bdi dir="ltr" className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{item.key}</bdi>
               <h2 className="line-clamp-2 text-sm font-medium leading-6 group-hover:text-primary">{item.title}</h2>
               <ArrowLeft aria-hidden="true" className="ms-auto mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
            </div>
            {customer || reasons.length ? <div className="mt-1.5 flex min-w-0 items-center gap-2 text-xs leading-5">
               {customer ? <bdi className="max-w-44 truncate text-muted-foreground" dir={item.contact?.name ? 'auto' : 'ltr'}>{customer}</bdi> : null}
               {customer && reasons.length ? <span aria-hidden="true" className="text-muted-foreground/40">·</span> : null}
               {reasons.length ? <p className="min-w-0 truncate text-amber-700 dark:text-amber-400" title={reasons.map((reason) => supportAttentionLabels[reason]).join('، ')}><span aria-hidden="true" className="me-1.5 inline-block size-1.5 rounded-full bg-current" />{supportAttentionLabels[reasons[0]]}{reasons.length > 1 ? <span className="ms-1.5 text-muted-foreground">+{(reasons.length - 1).toLocaleString('fa-IR')}</span> : null}</p> : null}
            </div> : null}
         </Link>
         <div className="flex items-center gap-2 lg:flex-col lg:items-start"><span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs', supportStatusTone(item.status))}><span className="size-1.5 rounded-full bg-current" />{supportStatusLabels[item.status]}</span>{item.priority !== 'NORMAL' ? <span className={cn('text-xs', supportPriorityTone(item.priority))}>{supportPriorityLabels[item.priority]}</span> : null}</div>
         <div className={cn('min-w-0 text-xs text-muted-foreground', !assignee?.user?.name && !item.departmentId && 'hidden lg:block')}><span className="block truncate" title={assignee?.user?.name || item.department?.name}>{assignee?.user?.name || item.department?.name || (item.departmentId ? 'صف دپارتمان' : '—')}</span></div>
         <div className={cn('min-w-0', queue === 'TRIAGE' || queue === 'DEPARTMENT_INBOX' ? 'col-span-3 lg:col-span-1' : dueAt ? 'col-start-3 lg:col-start-auto' : 'hidden lg:block')}>
            {queue === 'TRIAGE' ? <TriageAction item={item} onChanged={onChanged} /> : queue === 'DEPARTMENT_INBOX' ? <DepartmentAssignAction item={item} members={members} onChanged={onChanged} /> : <span className={cn('inline-flex items-center gap-1.5 text-xs', isLate ? 'text-destructive' : 'text-muted-foreground')} title={dueAt ? formatJalaliDateTime(dueAt) : undefined}>{dueAt ? <Clock3 className="size-3.5 shrink-0" /> : null}{dueAt ? supportDueLabel(dueAt) : '—'}</span>}
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
            <SupportSelect label={`دپارتمان مقصد ${item.key}`} className="min-w-0 flex-1" value={departmentId} onChange={setDepartmentId} placeholder="انتخاب دپارتمان" options={support.departments.filter((department) => department.active).map((department) => ({ value: department.id, label: department.name }))} />
            <SupportButton aria-label={`ارجاع ${item.key}`} className="size-9 shrink-0" variant="secondary" isDisabled={!departmentId || submitting} isIconOnly size="sm" type="button" onClick={() => void route()}>
               {submitting ? <Loader2 className="size-4 animate-spin" /> : <UserRoundCheck className="size-4" />}
            </SupportButton>
         </div>
         {error ? <p role="alert" className="text-[11px] leading-5 text-destructive">{error}</p> : null}
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
            <SupportSelect label={`مسئول پرونده ${item.key}`} className="min-w-0 flex-1" value={membershipId} onChange={setMembershipId} placeholder="انتخاب مسئول" options={members.filter((member) => member.active).map((member) => ({ value: member.id, label: member.user?.name || member.userId }))} />
            <SupportButton aria-label={`واگذاری ${item.key}`} className="size-9 shrink-0" variant="secondary" isDisabled={!membershipId || submitting} isIconOnly size="sm" type="button" onClick={() => void assign()}>
               {submitting ? <Loader2 className="size-4 animate-spin" /> : <UserRoundCheck className="size-4" />}
            </SupportButton>
         </div>
         {error ? <p role="alert" className="text-[11px] leading-5 text-destructive">{error}</p> : null}
      </div>
   );
}
