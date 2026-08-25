import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
   Bookmark,
   ChevronLeft,
   CircleOff,
   Loader2,
   LockKeyhole,
   PencilLine,
   Plus,
   RefreshCw,
   Save,
   Share2,
   Trash2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportCollaborationClient } from '@/lib/support-collaboration-client';
import type {
   CreateSupportSavedQueueInput,
   SupportSavedQueue,
   SupportSavedQueueFilters,
   SupportSavedQueueVisibility,
} from '@/lib/support-collaboration-types';
import {
   supportAttentionLabels,
   supportPriorityLabels,
   supportPriorityTone,
   supportSourceLabels,
   supportStatusLabels,
   supportStatusTone,
} from '@/lib/support-presenters';
import {
   supportAttentionReasons,
   supportCasePriorities,
   supportCaseSources,
   supportCaseStatuses,
   supportQueueKinds,
   type SupportAttentionReason,
   type SupportCase,
   type SupportCasePriority,
   type SupportCaseSource,
   type SupportCaseStatus,
   type SupportDepartment,
   type SupportQueueKind,
} from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { cn } from '@/lib/utils';

export function SupportSavedQueuesView() {
   const support = useSupportWorkspace();
   const runtime = useWorkspaceRuntime();
   const [queues, setQueues] = useState<SupportSavedQueue[]>([]);
   const [selected, setSelected] = useState<SupportSavedQueue>();
   const [items, setItems] = useState<SupportCase[]>([]);
   const [total, setTotal] = useState(0);
   const [nextCursor, setNextCursor] = useState<string | null>(null);
   const [loading, setLoading] = useState(true);
   const [casesLoading, setCasesLoading] = useState(false);
   const [error, setError] = useState('');
   const [dialogOpen, setDialogOpen] = useState(false);
   const [editing, setEditing] = useState<SupportSavedQueue>();
   const [deletingId, setDeletingId] = useState('');

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const loaded = await supportCollaborationClient.listSavedQueues();
         setQueues(loaded);
         setSelected((current) => current ? loaded.find((item) => item.id === current.id) : undefined);
      } catch (caught) {
         setError(message(caught, 'بارگذاری صف‌های ذخیره‌شده ناموفق بود.'));
      } finally {
         setLoading(false);
      }
   }, []);

   useEffect(() => {
      void load();
   }, [load]);

   async function openQueue(queue: SupportSavedQueue) {
      setSelected(queue);
      setItems([]);
      setCasesLoading(true);
      setError('');
      try {
         const page = await supportCollaborationClient.useSavedQueue(queue.id);
         setSelected(page.savedView);
         setItems(page.items);
         setTotal(page.total);
         setNextCursor(page.nextCursor);
      } catch (caught) {
         setError(message(caught, 'اجرای صف ذخیره‌شده ناموفق بود. شاید محدوده دسترسی شما تغییر کرده باشد.'));
      } finally {
         setCasesLoading(false);
      }
   }

   async function loadMore() {
      if (!selected || !nextCursor || casesLoading) return;
      setCasesLoading(true);
      setError('');
      try {
         const page = await supportCollaborationClient.useSavedQueue(selected.id, nextCursor);
         setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
         setTotal(page.total);
         setNextCursor(page.nextCursor);
      } catch (caught) {
         setError(message(caught, 'بارگذاری ادامه صف ناموفق بود.'));
      } finally {
         setCasesLoading(false);
      }
   }

   async function remove(queue: SupportSavedQueue) {
      if (deletingId || !window.confirm(`صف «${queue.name}» حذف شود؟`)) return;
      setDeletingId(queue.id);
      setError('');
      try {
         await supportCollaborationClient.deleteSavedQueue(queue.id, queue.version);
         setQueues((current) => current.filter((item) => item.id !== queue.id));
         if (selected?.id === queue.id) {
            setSelected(undefined);
            setItems([]);
         }
      } catch (caught) {
         setError(message(caught, 'حذف صف ذخیره‌شده ناموفق بود.'));
      } finally {
         setDeletingId('');
      }
   }

   function upsert(queue: SupportSavedQueue) {
      setQueues((current) => [queue, ...current.filter((item) => item.id !== queue.id)]);
      if (selected?.id === queue.id) {
         setSelected(queue);
         setItems([]);
         setNextCursor(null);
      }
   }

   return (
      <main dir="rtl" className="h-full min-h-0 overflow-y-auto bg-[#101011] p-4 text-zinc-100 sm:p-5" data-testid="support-saved-queues-screen">
         <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
            <Card className="min-w-0 border-white/8 bg-[#171719] text-zinc-100">
               <CardHeader className="border-b border-white/7">
                  <div className="flex items-start justify-between gap-3">
                     <div><CardTitle className="flex items-center gap-2 text-base"><Bookmark className="size-4 text-indigo-300" /> صف‌های ذخیره‌شده</CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-500">فیلترهای امن و محدوده‌دار؛ بدون ذخیره محتوای پرونده در مرورگر</CardDescription></div>
                     <div className="flex gap-1"><Button aria-label="تازه‌سازی صف‌های ذخیره‌شده" className="text-zinc-500" size="icon" type="button" variant="ghost" onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button><Button aria-label="ساخت صف ذخیره‌شده" className="bg-zinc-100 text-zinc-950 hover:bg-white" size="icon" type="button" onClick={() => { setEditing(undefined); setDialogOpen(true); }}><Plus className="size-4" /></Button></div>
                  </div>
               </CardHeader>
               <CardContent className="space-y-2 p-3">
                  {loading && !queues.length ? <Loading text="در حال بارگذاری صف‌ها…" /> : null}
                  {!loading && !queues.length ? <Empty text="هنوز صفی ذخیره نکرده‌اید." /> : null}
                  {queues.map((queue) => {
                     const owner = queue.ownerId === runtime.me.user.id;
                     return (
                        <article key={queue.id} className={cn('rounded-lg border p-3', selected?.id === queue.id ? 'border-indigo-400/25 bg-indigo-400/[0.05]' : 'border-white/7 bg-black/10')} data-testid={`support-saved-queue-${queue.id}`}>
                           <button className="w-full text-start" type="button" onClick={() => void openQueue(queue)}>
                              <div className="flex items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{queue.name}</h2><VisibilityBadge visibility={queue.visibility} /></div>
                              <p className="mt-2 line-clamp-2 text-xs leading-6 text-zinc-600">{savedQueueSummary(queue, support.departments)}</p>
                           </button>
                           {owner ? <div className="mt-2 flex justify-end gap-1 border-t border-white/6 pt-2"><Button aria-label={`ویرایش ${queue.name}`} className="h-7 text-xs text-zinc-500" type="button" variant="ghost" onClick={() => { setEditing(queue); setDialogOpen(true); }}><PencilLine className="size-3.5" /> ویرایش</Button><Button aria-label={`حذف ${queue.name}`} className="h-7 text-xs text-zinc-600 hover:text-red-300" disabled={deletingId === queue.id} type="button" variant="ghost" onClick={() => void remove(queue)}>{deletingId === queue.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} حذف</Button></div> : null}
                        </article>
                     );
                  })}
               </CardContent>
            </Card>

            <section className="min-w-0 space-y-3">
               {error ? <InlineError text={error} /> : null}
               {!selected ? (
                  <Card className="border-dashed border-white/10 bg-[#171719] text-zinc-100"><CardContent className="flex min-h-80 flex-col items-center justify-center p-6 text-center"><Bookmark className="size-8 text-zinc-700" /><h2 className="mt-4 text-sm font-medium text-zinc-300">یک صف را انتخاب کنید</h2><p className="mt-2 max-w-md text-xs leading-7 text-zinc-600">نتیجه هر بار از سرور و با دسترسی فعلی شما خوانده می‌شود؛ تغییر یا لغو دسترسی فوراً اعمال می‌شود.</p></CardContent></Card>
               ) : (
                  <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-saved-queue-results">
                     <CardHeader className="border-b border-white/7"><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-base">{selected.name}<VisibilityBadge visibility={selected.visibility} /></CardTitle><CardDescription className="mt-1.5 leading-6 text-zinc-500">{savedQueueSummary(selected, support.departments)} · {total.toLocaleString('fa-IR')} پرونده در محدوده فعلی</CardDescription></div><Button className="border border-white/10 bg-white/5 text-zinc-300" disabled={casesLoading} size="sm" type="button" variant="secondary" onClick={() => void openQueue(selected)}><RefreshCw className={cn('size-4', casesLoading && 'animate-spin')} /> اجرای دوباره</Button></div></CardHeader>
                     <CardContent className="space-y-3 p-4">
                        {casesLoading && !items.length ? <Loading text="در حال اجرای صف…" /> : null}
                        {!casesLoading && !items.length ? <Empty text="پرونده‌ای با این فیلترها و دسترسی فعلی پیدا نشد." /> : null}
                        {items.map((item) => <SavedQueueCase key={item.id} item={item} workspaceSlug={runtime.workspaceSlug} />)}
                        {nextCursor ? <Button className="w-full border border-white/10 bg-white/5 text-zinc-300" disabled={casesLoading} type="button" variant="secondary" onClick={() => void loadMore()}>{casesLoading ? <Loader2 className="size-4 animate-spin" /> : null} نمایش پرونده‌های بیشتر</Button> : null}
                     </CardContent>
                  </Card>
               )}
            </section>
         </div>

         <SavedQueueDialog
            departments={support.departments.filter((department) => department.active)}
            open={dialogOpen}
            source={editing}
            onOpenChange={setDialogOpen}
            onSaved={upsert}
         />
      </main>
   );
}

function SavedQueueCase({ item, workspaceSlug }: { item: SupportCase; workspaceSlug: string }) {
   return (
      <article className="rounded-lg border border-white/7 bg-black/10 p-3" data-testid={`support-saved-queue-case-${item.key}`}>
         <Link className="group flex min-w-0 items-start gap-3" to={`/${workspaceSlug}/support/cases/${encodeURIComponent(item.key)}`}>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><bdi dir="ltr" className="font-mono text-xs text-zinc-600">{item.key}</bdi><Badge variant="outline" className={cn('border text-[10px]', supportStatusTone(item.status))}>{supportStatusLabels[item.status]}</Badge><span className={cn('text-xs', supportPriorityTone(item.priority))}>{supportPriorityLabels[item.priority]}</span></div><h3 className="mt-1.5 break-words text-sm font-medium leading-6 text-zinc-200 group-hover:text-white">{item.title}</h3><p className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-600"><span>{item.department?.name || 'بدون دپارتمان'}</span><span>{supportSourceLabels[item.sourceChannel]}</span><span>{formatJalaliDateTime(item.receivedAt)}</span></p></div><ChevronLeft className="mt-2 size-4 shrink-0 text-zinc-700 group-hover:text-zinc-300" />
         </Link>
      </article>
   );
}

function SavedQueueDialog({ departments, onOpenChange, onSaved, open, source }: {
   departments: SupportDepartment[];
   onOpenChange: (open: boolean) => void;
   onSaved: (queue: SupportSavedQueue) => void;
   open: boolean;
   source?: SupportSavedQueue;
}) {
   const support = useSupportWorkspace();
   const [name, setName] = useState('');
   const [visibility, setVisibility] = useState<SupportSavedQueueVisibility>('PRIVATE');
   const [departmentId, setDepartmentId] = useState('');
   const [filters, setFilters] = useState<SupportSavedQueueFilters>(emptyFilters());
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');
   const managedDepartmentIds = support.access?.managedDepartmentIds || [];
   const shareableDepartments = departments.filter((department) => support.access?.workspaceWide || managedDepartmentIds.includes(department.id));
   const canWorkspaceShare = Boolean(support.access?.workspaceWide);
   const queueOptions = supportQueueKinds.filter((queue) => queueAllowed(queue, support));

   useEffect(() => {
      if (!open) return;
      setName(source?.name || '');
      setVisibility(source?.visibility || 'PRIVATE');
      setDepartmentId(source?.departmentId || '');
      setFilters(source ? normalizeFilters(source.filters) : emptyFilters());
      setError('');
   }, [open, source]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!name.trim() || submitting) return;
      const input: CreateSupportSavedQueueInput = {
         name: name.trim(),
         visibility,
         ...(visibility === 'DEPARTMENT' ? { departmentId } : {}),
         filters: {
            ...filters,
            typeKey: filters.typeKey?.trim().toLowerCase() || undefined,
            receivedWithinHours: filters.receivedWithinHours || undefined,
         },
      };
      if (visibility === 'DEPARTMENT' && !departmentId) {
         setError('برای صف مشترک دپارتمان، دپارتمان را انتخاب کنید.');
         return;
      }
      setSubmitting(true);
      setError('');
      try {
         const saved = source
            ? await supportCollaborationClient.updateSavedQueue(source.id, { ...input, departmentId: visibility === 'DEPARTMENT' ? departmentId : null, baseVersion: source.version })
            : await supportCollaborationClient.createSavedQueue(input);
         onSaved(saved);
         onOpenChange(false);
      } catch (caught) {
         setError(message(caught, 'ذخیره صف ناموفق بود.'));
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent dir="rtl" className="max-h-[90vh] max-w-3xl overflow-y-auto border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader><DialogTitle>{source ? 'ویرایش صف ذخیره‌شده' : 'ساخت صف ذخیره‌شده'}</DialogTitle><DialogDescription className="leading-6 text-zinc-500">فقط فیلترها ذخیره می‌شوند. نتایج همیشه با دسترسی همان لحظه از سرور دریافت می‌شوند.</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={submit}>
               {error ? <InlineError text={error} /> : null}
               <div className="grid gap-3 sm:grid-cols-2"><Field label="نام صف"><Input autoFocus className={inputClass} maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="اشتراک"><select className={selectClass} value={visibility} onChange={(event) => { const next = event.target.value as SupportSavedQueueVisibility; setVisibility(next); if (next !== 'DEPARTMENT') setDepartmentId(''); }}><option value="PRIVATE">خصوصی — فقط من</option>{shareableDepartments.length ? <option value="DEPARTMENT">دپارتمان</option> : null}{canWorkspaceShare ? <option value="WORKSPACE">کل پشتیبانی</option> : null}</select></Field></div>
               {visibility === 'DEPARTMENT' ? <Field label="دپارتمان اشتراک"><select className={selectClass} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">انتخاب دپارتمان</option>{shareableDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></Field> : null}
               <div className="rounded-xl border border-white/8 bg-black/10 p-4">
                  <h3 className="text-sm font-medium text-zinc-200">فیلترهای پرونده</h3>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                     <Field label="صف مبنا"><select className={selectClass} value={filters.queue || ''} onChange={(event) => setFilters({ ...filters, queue: (event.target.value || undefined) as SupportQueueKind | undefined })}><option value="">همه پرونده‌های قابل مشاهده</option>{queueOptions.map((queue) => <option key={queue} value={queue}>{queueLabel(queue)}</option>)}</select></Field>
                     <Field label="دپارتمان"><select className={selectClass} value={filters.departmentId || ''} onChange={(event) => setFilters({ ...filters, departmentId: event.target.value || undefined })}><option value="">همه دپارتمان‌های قابل مشاهده</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></Field>
                     <Field label="وضعیت"><ChipChecks options={supportCaseStatuses.map((value) => ({ value, label: supportStatusLabels[value] }))} values={filters.statuses} onChange={(values) => setFilters({ ...filters, statuses: values as SupportCaseStatus[] })} /></Field>
                     <Field label="اولویت"><ChipChecks options={supportCasePriorities.map((value) => ({ value, label: supportPriorityLabels[value] }))} values={filters.priorities} onChange={(values) => setFilters({ ...filters, priorities: values as SupportCasePriority[] })} /></Field>
                     <Field label="کانال"><ChipChecks options={supportCaseSources.map((value) => ({ value, label: supportSourceLabels[value] }))} values={filters.sourceChannels} onChange={(values) => setFilters({ ...filters, sourceChannels: values as SupportCaseSource[] })} /></Field>
                     <Field label="دلیل نیاز به توجه"><select className={selectClass} value={filters.attentionReason || ''} onChange={(event) => setFilters({ ...filters, attentionReason: (event.target.value || undefined) as SupportAttentionReason | undefined })}><option value="">همه</option>{supportAttentionReasons.map((reason) => <option key={reason} value={reason}>{supportAttentionLabels[reason]}</option>)}</select></Field>
                     <Field label="نوع پرونده"><Input dir="ltr" className={cn(inputClass, 'text-left')} placeholder="billing" value={filters.typeKey || ''} onChange={(event) => setFilters({ ...filters, typeKey: event.target.value })} /></Field>
                     <Field label="دریافت‌شده در چند ساعت اخیر"><Input className={inputClass} inputMode="numeric" min={1} max={8784} placeholder="مثلاً ۲۴" type="number" value={filters.receivedWithinHours || ''} onChange={(event) => setFilters({ ...filters, receivedWithinHours: event.target.value ? Number(event.target.value) : undefined })} /></Field>
                  </div>
               </div>
               <p className="rounded-lg border border-sky-400/10 bg-sky-400/[0.035] px-3 py-2.5 text-xs leading-6 text-sky-100/70"><LockKeyhole className="me-1 inline size-3.5" />صف نمی‌تواند دسترسی تازه‌ای بسازد یا فیلتر همکار خارج از محدوده را ذخیره کند.</p>
               <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!name.trim() || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} ذخیره صف</Button><Button disabled={submitting} type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function VisibilityBadge({ visibility }: { visibility: SupportSavedQueueVisibility }) {
   const Icon = visibility === 'PRIVATE' ? LockKeyhole : Share2;
   return <Badge variant="outline" className="shrink-0 border-white/10 text-[10px] text-zinc-500"><Icon className="me-1 size-3" />{visibility === 'PRIVATE' ? 'خصوصی' : visibility === 'DEPARTMENT' ? 'دپارتمان' : 'پشتیبانی'}</Badge>;
}

export function savedQueueSummary(queue: SupportSavedQueue, departments: SupportDepartment[]): string {
   const filters = queue.filters;
   const parts: string[] = [];
   if (filters.queue) parts.push(queueLabel(filters.queue));
   if (filters.departmentId) parts.push(departments.find((item) => item.id === filters.departmentId)?.name || 'دپارتمان محدود');
   if (filters.statuses.length) parts.push(`${filters.statuses.length.toLocaleString('fa-IR')} وضعیت`);
   if (filters.priorities.length) parts.push(`${filters.priorities.length.toLocaleString('fa-IR')} اولویت`);
   if (filters.sourceChannels.length) parts.push(`${filters.sourceChannels.length.toLocaleString('fa-IR')} کانال`);
   if (filters.typeKey) parts.push(`نوع ${filters.typeKey}`);
   if (filters.attentionReason) parts.push(supportAttentionLabels[filters.attentionReason]);
   if (filters.receivedWithinHours) parts.push(`${filters.receivedWithinHours.toLocaleString('fa-IR')} ساعت اخیر`);
   return parts.length ? parts.join(' · ') : 'همه پرونده‌های قابل مشاهده';
}

function queueAllowed(queue: SupportQueueKind, support: ReturnType<typeof useSupportWorkspace>) {
   if (queue === 'TRIAGE') return Boolean(support.access?.triager || support.access?.workspaceWide);
   if (queue === 'DEPARTMENT_INBOX') return Boolean(support.access?.workspaceWide || support.access?.managedDepartmentIds.length);
   if (queue === 'MY_CASES') return Boolean(support.access?.memberMembershipIds.length);
   return true;
}

function queueLabel(queue: SupportQueueKind) {
   return ({ TRIAGE: 'تریاژ', DEPARTMENT_INBOX: 'صف دپارتمان', MY_CASES: 'پرونده‌های من', NEEDS_ATTENTION: 'نیازمند توجه' } as const)[queue];
}

function emptyFilters(): SupportSavedQueueFilters {
   return { schemaVersion: 1, statuses: [], priorities: [], sourceChannels: [] };
}

function normalizeFilters(filters: SupportSavedQueueFilters): SupportSavedQueueFilters {
   return { ...emptyFilters(), ...filters, statuses: [...(filters.statuses || [])], priorities: [...(filters.priorities || [])], sourceChannels: [...(filters.sourceChannels || [])] };
}

function ChipChecks({ onChange, options, values }: { onChange: (values: string[]) => void; options: Array<{ label: string; value: string }>; values: readonly string[] }) {
   return <div className="flex min-h-9 flex-wrap gap-1.5 rounded-md border border-white/10 bg-[#0c0c0e] p-1.5">{options.map((option) => { const checked = values.includes(option.value); return <label key={option.value} className={cn('cursor-pointer rounded px-2 py-1 text-[11px]', checked ? 'bg-indigo-400/15 text-indigo-100' : 'text-zinc-600 hover:bg-white/5')}><input className="sr-only" checked={checked} type="checkbox" onChange={() => onChange(checked ? values.filter((value) => value !== option.value) : [...values, option.value])} />{option.label}</label>; })}</div>;
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
   return <label className="grid gap-1.5 text-xs text-zinc-500"><span>{label}</span>{children}</label>;
}

function InlineError({ text }: { text: string }) {
   return <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm text-red-200">{text}</p>;
}

function Loading({ text }: { text: string }) {
   return <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-600"><Loader2 className="size-4 animate-spin" /> {text}</div>;
}

function Empty({ text }: { text: string }) {
   return <div className="rounded-lg border border-dashed border-white/10 px-4 py-8 text-center text-sm leading-7 text-zinc-600"><CircleOff className="mx-auto mb-3 size-5" />{text}</div>;
}

function message(error: unknown, fallback: string) {
   return error instanceof Error && error.message ? error.message : fallback;
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
