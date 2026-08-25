import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
   AlertTriangle,
   ArrowRight,
   BellOff,
   BellRing,
   Building2,
   CheckCircle2,
   Clock3,
   History,
   Loader2,
   LockKeyhole,
   Mail,
   MessageSquareText,
   PhoneCall,
   RefreshCw,
   RotateCcw,
   Send,
   UserRound,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { formatJalaliDateTime } from '@/lib/jalali';
import {
   supportAttentionLabels,
   supportDueLabel,
   supportPriorityLabels,
   supportPriorityTone,
   supportResolutionLabels,
   supportSourceLabels,
   supportStatusLabels,
   supportStatusTone,
} from '@/lib/support-presenters';
import type {
   SupportCase,
   SupportCaseEvent,
   SupportDepartmentMember,
   SupportInteraction,
   SupportResolutionCode,
} from '@/lib/support-types';
import { supportResolutionCodes } from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { cn } from '@/lib/utils';
import { supportCaseActionAccess } from '@/lib/support-access';
import { SupportCaseHandoffCard } from '@/components/taskara/support-case-handoff-card';
import { SupportCaseRoutingAssistance } from '@/components/taskara/support-case-routing-assistance';
import { SupportCasePresenceNotice, supportPresenceIntentForTarget } from '@/components/taskara/support-case-presence';
import {
   SupportCaseAssistanceCard,
   SupportCaseCsatCard,
   SupportCaseEnablementCard,
   SupportCaseKnowledgeCard,
} from '@/components/taskara/support-case-maturity-containers';
import { TaskaraClientError } from '@/lib/taskara-client';

type ComposerMode = 'NOTE' | 'PUBLIC' | 'CUSTOMER' | 'CALL';

export function SupportCaseDetailView() {
   const { caseKey = '' } = useParams();
   const navigate = useNavigate();
   const support = useSupportWorkspace();
   const [item, setItem] = useState<SupportCase>();
   const [interactions, setInteractions] = useState<SupportInteraction[]>([]);
   const [events, setEvents] = useState<SupportCaseEvent[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [presenceIntent, setPresenceIntent] = useState<'VIEWING' | 'EDITING'>('VIEWING');

   const load = useCallback(async () => {
      if (!caseKey) return;
      setLoading(true);
      setError('');
      try {
         const loaded = await support.loadCase(caseKey);
         setItem(loaded);
         const [loadedInteractions, loadedEvents] = await Promise.all([
            support.loadInteractions(caseKey),
            support.loadEvents(caseKey),
         ]);
         setInteractions(loadedInteractions);
         setEvents(loadedEvents);
      } catch (caught) {
         if (caught instanceof TaskaraClientError && (caught.status === 403 || caught.status === 404)) {
            setItem(undefined);
            setInteractions([]);
            setEvents([]);
         }
         setError(caught instanceof Error ? caught.message : 'بارگذاری پرونده ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [caseKey, support.loadCase, support.loadEvents, support.loadInteractions]);

   useEffect(() => {
      setItem(undefined);
      setInteractions([]);
      setEvents([]);
      void load();
   }, [load]);

   useEffect(() => {
      setPresenceIntent('VIEWING');
   }, [caseKey]);

   useEffect(() => {
      if (!item || !support.state.syncRevision) return;
      const synced = support.caseByIdOrKey(caseKey);
      if (synced) {
         setItem(synced);
      } else {
         setItem(undefined);
         setInteractions([]);
         setEvents([]);
         setError('این پرونده منتقل شده یا دیگر در محدوده دسترسی شما نیست.');
      }
   }, [caseKey, item?.id, support.caseByIdOrKey, support.state.syncRevision]);

   if (loading && !item) {
      return <main dir="rtl" className="flex h-full items-center justify-center gap-2 bg-[#101011] text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" /> در حال بارگذاری پرونده…</main>;
   }

   if (!item) {
      return (
         <main dir="rtl" className="flex h-full items-center justify-center bg-[#101011] p-6 text-zinc-200">
            <div className="max-w-md text-center"><AlertTriangle className="mx-auto size-8 text-amber-300" /><h1 className="mt-4 font-semibold">پرونده در دسترس نیست</h1><p className="mt-2 text-sm leading-7 text-zinc-500">{error || 'ممکن است پرونده منتقل شده باشد یا دیگر در محدوده دسترسی شما نباشد.'}</p><Button className="mt-5" type="button" variant="secondary" onClick={() => navigate(-1)}>بازگشت</Button></div>
         </main>
      );
   }

   const assignee = item.assignee || item.assigneeMembership;

   return (
      <main
         dir="rtl"
         className="h-full min-h-0 overflow-auto bg-[#101011] text-zinc-200"
         data-testid="support-case-detail"
         onFocusCapture={(event) => {
            if (supportPresenceIntentForTarget(event.target)) setPresenceIntent('EDITING');
         }}
      >
         <header className="sticky top-0 z-10 border-b border-white/7 bg-[#101011]/95 px-4 py-3 backdrop-blur sm:px-5">
            <div className="mx-auto flex max-w-7xl items-start gap-3">
               <Button aria-label="بازگشت" className="mt-0.5 size-8 shrink-0 text-zinc-500 hover:bg-white/6 hover:text-zinc-200" size="icon" type="button" variant="ghost" onClick={() => navigate(-1)}><ArrowRight className="size-4" /></Button>
               <SidebarTrigger aria-label="باز و بسته کردن منوی کناری" className="mt-0.5 shrink-0 text-zinc-500 lg:hidden" />
               <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><bdi dir="ltr" className="font-mono text-xs text-zinc-500">{item.key}</bdi><Badge variant="outline" className={cn('border text-[11px]', supportStatusTone(item.status))}>{supportStatusLabels[item.status]}</Badge><span className={cn('text-xs', supportPriorityTone(item.priority))}>{supportPriorityLabels[item.priority]}</span></div>
                  <h1 className="mt-1.5 break-words text-base font-semibold leading-7 text-zinc-100 sm:text-lg">{item.title}</h1>
               </div>
               <Button aria-label="تازه‌سازی پرونده" className="size-8 shrink-0 text-zinc-500 hover:bg-white/6 hover:text-zinc-200" size="icon" type="button" variant="ghost" onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button>
            </div>
         </header>

         <div className="mx-auto grid max-w-7xl gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-4">
               <SupportCasePresenceNotice
                  caseKey={item.key}
                  caseVersion={item.version}
                  intent={presenceIntent}
                  onRefreshRequested={load}
               />
               {error ? <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm text-red-200">{error}</p> : null}
               <CaseContextCard item={item} />
               <div className="xl:hidden"><CaseFactsCard item={item} assignee={assignee} /></div>
               <TimelineCard events={events} interactions={interactions} />
               {item.status !== 'CLOSED' ? (
                  <InteractionComposer
                     item={item}
                     onChanged={async (updated) => {
                        setItem(updated);
                        const [nextInteractions, nextEvents] = await Promise.all([support.loadInteractions(item.key), support.loadEvents(item.key)]);
                        setInteractions(nextInteractions);
                        setEvents(nextEvents);
                     }}
                  />
               ) : null}
               <SupportCaseKnowledgeCard item={item} />
            </div>
            <aside className="min-w-0 space-y-4" aria-label="ویژگی‌ها و اقدام‌های پرونده">
               <div className="hidden xl:block"><CaseFactsCard item={item} assignee={assignee} /></div>
               <SupportCaseRoutingAssistance item={item} onChanged={setItem} />
               <SupportCaseAssistanceCard item={item} onCaseChanged={load} />
               <SupportCaseEnablementCard
                  item={item}
                  onCaseChanged={(updated) => {
                     setItem(updated);
                     void support.loadEvents(updated.key).then(setEvents).catch(() => undefined);
                  }}
               />
               <RoutingCard item={item} onChanged={setItem} />
               <NextActionCard item={item} onChanged={setItem} />
               <AttentionSnoozeCard item={item} onChanged={setItem} />
               <ResolutionCard item={item} onChanged={setItem} />
               <SupportCaseCsatCard item={item} />
               <SupportCaseHandoffCard
                  canMutate={supportCaseActionAccess(item, support.access).canWork}
                  item={item}
                  onCaseChanged={async () => {
                     const updated = await support.loadCase(item.key);
                     setItem(updated);
                  }}
               />
            </aside>
         </div>
      </main>
   );
}

function CaseContextCard({ item }: { item: SupportCase }) {
   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader><CardTitle className="text-sm">زمینه درخواست</CardTitle><CardDescription className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-600"><span>{supportSourceLabels[item.sourceChannel]}</span><bdi dir="ltr" className="font-mono">{item.typeKey}</bdi><span>{formatJalaliDateTime(item.receivedAt)}</span></CardDescription></CardHeader>
         <CardContent className="space-y-4">
            <p className="whitespace-pre-wrap break-words text-sm leading-8 text-zinc-300">{item.description || 'شرح تکمیلی ثبت نشده است.'}</p>
            {item.attentionReasons?.length ? <div className="flex flex-wrap gap-2 border-t border-white/6 pt-4">{item.attentionReasons.map((reason) => <Badge key={reason} variant="outline" className="border-amber-300/15 bg-amber-300/5 text-amber-200/80">{supportAttentionLabels[reason]}</Badge>)}</div> : null}
         </CardContent>
      </Card>
   );
}

function CaseFactsCard({ assignee, item }: { assignee?: SupportDepartmentMember | null; item: SupportCase }) {
   const contactLabel = item.contact?.name || item.contact?.phone || item.contact?.email || 'بدون درخواست‌کننده';
   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader><CardTitle className="text-sm">وضعیت کنونی</CardTitle></CardHeader>
         <CardContent className="grid gap-3 text-sm">
            <Fact icon={UserRound} label="درخواست‌کننده" value={contactLabel} ltr={!item.contact?.name} />
            {item.contact?.phone ? <Fact icon={PhoneCall} label="تلفن" value={item.contact.phone} ltr /> : null}
            {item.contact?.email ? <Fact icon={Mail} label="ایمیل" value={item.contact.email} ltr /> : null}
            <Fact icon={Building2} label="مالک" value={assignee?.user?.name || item.department?.name || 'بدون دپارتمان'} />
            <Fact icon={Clock3} label="اقدام بعدی" value={item.nextActionAt ? `${formatJalaliDateTime(item.nextActionAt)} — ${supportDueLabel(item.nextActionAt)}` : 'تعیین نشده'} />
            {item.nextSlaDueAt ? <Fact icon={Clock3} label="موعد SLA" value={`${formatJalaliDateTime(item.nextSlaDueAt)} — ${supportDueLabel(item.nextSlaDueAt)}`} /> : null}
            {item.snoozedUntil && new Date(item.snoozedUntil).getTime() > Date.now() ? <Fact icon={BellOff} label="توجه به پرونده تعویق شده تا" value={formatJalaliDateTime(item.snoozedUntil)} /> : null}
            <div className="rounded-lg border border-white/7 bg-black/10 px-3 py-2 text-xs leading-6 text-zinc-600"><LockKeyhole className="me-1 inline size-3.5" />این اطلاعات فقط تا زمانی در حافظه مرورگر می‌ماند که دسترسی فعلی معتبر است.</div>
         </CardContent>
      </Card>
   );
}

function RoutingCard({ item, onChanged }: { item: SupportCase; onChanged: (item: SupportCase) => void }) {
   const support = useSupportWorkspace();
   const actionAccess = supportCaseActionAccess(item, support.access);
   const [departmentId, setDepartmentId] = useState(item.departmentId || '');
   const [membershipId, setMembershipId] = useState(item.assigneeMembershipId || '');
   const [reason, setReason] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');
   const crossDepartment = Boolean(item.departmentId && departmentId && item.departmentId !== departmentId);
   const canDispatch = actionAccess.routeMode === 'ANY_DEPARTMENT';
   const canReturnOwn = actionAccess.routeMode === 'RETURN_TO_INBOX';
   const members = departmentId ? support.state.membersByDepartmentId[departmentId] || [] : [];

   useEffect(() => {
      setDepartmentId(item.departmentId || '');
      setMembershipId(item.assigneeMembershipId || '');
   }, [item.assigneeMembershipId, item.departmentId]);

   useEffect(() => {
      if (!departmentId || !canDispatch || support.state.membersByDepartmentId[departmentId]) return;
      void support.loadDepartmentMembers(departmentId).catch(() => undefined);
   }, [canDispatch, departmentId, support.loadDepartmentMembers, support.state.membersByDepartmentId]);

   async function route(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!departmentId || (crossDepartment && !reason.trim())) return;
      setSubmitting(true);
      setError('');
      try {
         onChanged(await support.routeCase(item, {
            targetDepartmentId: departmentId,
            targetAssigneeMembershipId: membershipId || null,
            reason: reason.trim() || undefined,
         }));
         setReason('');
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'تغییر مالکیت ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   async function returnToQueue() {
      if (!item.departmentId) return;
      setSubmitting(true);
      setError('');
      try {
         onChanged(await support.routeCase(item, { targetDepartmentId: item.departmentId, targetAssigneeMembershipId: null }));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بازگرداندن به صف ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   if (!canDispatch && !canReturnOwn) return null;
   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader><CardTitle className="text-sm">مالکیت و واگذاری</CardTitle><CardDescription className="leading-6 text-zinc-600">دپارتمان مالک است؛ مسئول فردی باید عضو فعال همان دپارتمان باشد.</CardDescription></CardHeader>
         <CardContent>
            {error ? <InlineError message={error} /> : null}
            {canDispatch ? (
               <form className="grid gap-3" onSubmit={route}>
                  <Field label="دپارتمان"><select className={selectClass} value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setMembershipId(''); }}><option value="">انتخاب دپارتمان</option>{support.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></Field>
                  <Field label="مسئول فردی"><select className={selectClass} value={membershipId} onChange={(event) => setMembershipId(event.target.value)}><option value="">صف دپارتمان — بدون مسئول</option>{members.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.user?.name || member.userId}</option>)}</select></Field>
                  {crossDepartment ? <Field label="دلیل انتقال"><Textarea className={cn(inputClass, 'min-h-16')} required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field> : null}
                  <Button className="bg-indigo-400/15 text-indigo-100 hover:bg-indigo-400/25" disabled={!departmentId || (crossDepartment && !reason.trim()) || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : null} ثبت واگذاری</Button>
               </form>
            ) : (
               <Button className="w-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" disabled={submitting} type="button" variant="secondary" onClick={() => void returnToQueue()}>{submitting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} بازگرداندن پرونده به صف دپارتمان</Button>
            )}
         </CardContent>
      </Card>
   );
}

function NextActionCard({ item, onChanged }: { item: SupportCase; onChanged: (item: SupportCase) => void }) {
   const support = useSupportWorkspace();
   const actionAccess = supportCaseActionAccess(item, support.access);
   const [status, setStatus] = useState<'WAITING_ON_CUSTOMER' | 'WAITING_ON_INTERNAL'>('WAITING_ON_CUSTOMER');
   const [nextActionAt, setNextActionAt] = useState<string | null>(item.nextActionAt);
   const [reason, setReason] = useState(item.waitingReason || '');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!nextActionAt || (status === 'WAITING_ON_INTERNAL' && !reason.trim())) return;
      setSubmitting(true);
      setError('');
      try {
         onChanged(await support.waitCase(item, { status, nextActionAt, waitingReason: reason.trim() || undefined }));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ثبت اقدام بعدی ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   if (!actionAccess.canWork || item.status === 'RESOLVED' || item.status === 'CLOSED') return null;
   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader><CardTitle className="text-sm">اقدام بعدی</CardTitle><CardDescription className="leading-6 text-zinc-600">انتظار، تعهد پاسخ را پنهان یا متوقف نمی‌کند؛ موعد را روشن ثبت کنید.</CardDescription></CardHeader>
         <CardContent><form className="grid gap-3" onSubmit={submit}>{error ? <InlineError message={error} /> : null}<Field label="منتظر چه کسی؟"><select className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="WAITING_ON_CUSTOMER">منتظر مشتری</option><option value="WAITING_ON_INTERNAL">منتظر پیگیری داخلی</option></select></Field><Field label="موعد پیگیری"><LazyJalaliDatePicker ariaLabel="موعد پیگیری" showTime value={nextActionAt} onChange={setNextActionAt} /></Field>{status === 'WAITING_ON_INTERNAL' ? <Field label="دلیل انتظار"><Input className={inputClass} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field> : null}<Button className="border border-white/10 bg-white/6 text-zinc-200 hover:bg-white/10" disabled={!nextActionAt || (status === 'WAITING_ON_INTERNAL' && !reason.trim()) || submitting} type="submit" variant="secondary">{submitting ? <Loader2 className="size-4 animate-spin" /> : <Clock3 className="size-4" />} ثبت موعد و انتظار</Button></form></CardContent>
      </Card>
   );
}

function AttentionSnoozeCard({ item, onChanged }: { item: SupportCase; onChanged: (item: SupportCase) => void }) {
   const support = useSupportWorkspace();
   const actionAccess = supportCaseActionAccess(item, support.access);
   const activeSnooze = Boolean(item.snoozedUntil && new Date(item.snoozedUntil).getTime() > Date.now());
   const [snoozedUntil, setSnoozedUntil] = useState<string | null>(item.snoozedUntil || null);
   const [reason, setReason] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      setSnoozedUntil(item.snoozedUntil || null);
      setReason('');
   }, [item.snoozedUntil, item.version]);

   async function refreshConflict(caught: unknown): Promise<boolean> {
      if (!(caught instanceof TaskaraClientError) || caught.status !== 409) return false;
      try {
         onChanged(await support.loadCase(item.key));
         setError('پرونده در جای دیگری تغییر کرده بود؛ نسخه تازه بارگذاری شد. دلیل و زمان را دوباره بررسی کنید.');
      } catch {
         setError('پرونده هم‌زمان تغییر کرده است. صفحه را تازه‌سازی کنید و دوباره تلاش کنید.');
      }
      return true;
   }

   async function snooze(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!snoozedUntil || reason.trim().length < 3) return;
      if (new Date(snoozedUntil).getTime() <= Date.now()) {
         setError('زمان تعویق باید در آینده باشد.');
         return;
      }
      setSubmitting(true);
      setError('');
      try {
         onChanged(await support.snoozeCase(item, { snoozedUntil, reason: reason.trim() }));
      } catch (caught) {
         if (!(await refreshConflict(caught))) {
            setError(caught instanceof Error ? caught.message : 'تعویق توجه به پرونده ناموفق بود.');
         }
      } finally {
         setSubmitting(false);
      }
   }

   async function resume(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (reason.trim().length < 3) return;
      setSubmitting(true);
      setError('');
      try {
         onChanged(await support.resumeCase(item, reason.trim()));
      } catch (caught) {
         if (!(await refreshConflict(caught))) {
            setError(caught instanceof Error ? caught.message : 'ازسرگیری توجه به پرونده ناموفق بود.');
         }
      } finally {
         setSubmitting(false);
      }
   }

   if (!actionAccess.canWork || item.status === 'RESOLVED' || item.status === 'CLOSED') return null;
   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-attention-snooze-card">
         <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">{activeSnooze ? <BellOff className="size-4 text-amber-300" /> : <BellRing className="size-4 text-zinc-500" />}{activeSnooze ? 'توجه به پرونده تعویق شده' : 'تعویق توجه'}</CardTitle>
            <CardDescription className="leading-6 text-zinc-600">تعویق فقط پرونده را موقتاً از صف نیازمند توجه کنار می‌گذارد؛ توقف SLA تابع سیاست مستقل آن است.</CardDescription>
         </CardHeader>
         <CardContent>
            {error ? <InlineError message={error} /> : null}
            {activeSnooze ? (
               <form className="grid gap-3" onSubmit={resume}>
                  <p className="rounded-lg border border-amber-300/10 bg-amber-300/[0.03] px-3 py-2.5 text-xs leading-6 text-amber-100/65">تا {formatJalaliDateTime(item.snoozedUntil)} از صف توجه کنار گذاشته شده است.</p>
                  <Field label="دلیل ازسرگیری"><Textarea aria-label="دلیل ازسرگیری توجه" className={cn(inputClass, 'min-h-16')} required minLength={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
                  <Button className="border border-white/10 bg-white/6 text-zinc-200 hover:bg-white/10" disabled={reason.trim().length < 3 || submitting} type="submit" variant="secondary">{submitting ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />}ازسرگیری توجه</Button>
               </form>
            ) : (
               <form className="grid gap-3" onSubmit={snooze}>
                  <Field label="تا چه زمانی؟"><LazyJalaliDatePicker ariaLabel="زمان پایان تعویق توجه" showTime value={snoozedUntil} onChange={setSnoozedUntil} /></Field>
                  <div className="flex flex-wrap gap-1.5"><Button className="h-7 border border-white/8 bg-white/[0.035] px-2 text-xs text-zinc-500 hover:bg-white/8 hover:text-zinc-300" type="button" variant="secondary" onClick={() => setSnoozedUntil(new Date(Date.now() + 60 * 60 * 1000).toISOString())}>یک ساعت</Button><Button className="h-7 border border-white/8 bg-white/[0.035] px-2 text-xs text-zinc-500 hover:bg-white/8 hover:text-zinc-300" type="button" variant="secondary" onClick={() => setSnoozedUntil(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())}>یک روز</Button></div>
                  <Field label="دلیل تعویق"><Textarea aria-label="دلیل تعویق توجه" className={cn(inputClass, 'min-h-16')} required minLength={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
                  <Button className="border border-amber-300/15 bg-amber-300/8 text-amber-100 hover:bg-amber-300/12" disabled={!snoozedUntil || new Date(snoozedUntil).getTime() <= Date.now() || reason.trim().length < 3 || submitting} type="submit" variant="secondary">{submitting ? <Loader2 className="size-4 animate-spin" /> : <BellOff className="size-4" />}تعویق توجه</Button>
               </form>
            )}
         </CardContent>
      </Card>
   );
}

function ResolutionCard({ item, onChanged }: { item: SupportCase; onChanged: (item: SupportCase) => void }) {
   const support = useSupportWorkspace();
   const actionAccess = supportCaseActionAccess(item, support.access);
   const [code, setCode] = useState<SupportResolutionCode>('FIXED');
   const [summary, setSummary] = useState('');
   const [duplicateKey, setDuplicateKey] = useState('');
   const [reason, setReason] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!actionAccess.allowedResolutionCodes.includes(code)) {
         setCode(actionAccess.allowedResolutionCodes[0] || 'REJECTED');
      }
   }, [actionAccess.allowedResolutionCodes, code]);

   async function resolve(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!summary.trim() || (code === 'DUPLICATE' && !duplicateKey.trim())) return;
      setSubmitting(true);
      setError('');
      try {
         const duplicateOfCaseId = code === 'DUPLICATE' ? (await support.loadCase(duplicateKey.trim())).id : undefined;
         onChanged(await support.resolveCase(item, { resolutionCode: code, resolutionSummary: summary.trim(), duplicateOfCaseId }));
         setSummary('');
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'حل پرونده ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   async function close() {
      setSubmitting(true);
      setError('');
      try {
         onChanged(await support.closeCase(item, { confirmation: 'CUSTOMER_CONFIRMED' }));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بستن پرونده ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   async function reopen() {
      if (!reason.trim()) return;
      setSubmitting(true);
      setError('');
      try {
         onChanged(await support.reopenCase(item, reason.trim()));
         setReason('');
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بازگشایی پرونده ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   if (!actionAccess.canWork && item.status !== 'RESOLVED') return null;
   const canChangeTerminalState = actionAccess.canCloseOrReopen;
   const resolutionCodes = actionAccess.allowedResolutionCodes;

   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader><CardTitle className="text-sm">نتیجه و تأیید</CardTitle><CardDescription className="leading-6 text-zinc-600">حل‌شدن با نتیجه ساخت‌یافته ثبت می‌شود؛ بستن مرحله‌ای جدا برای تأیید است.</CardDescription></CardHeader>
         <CardContent>
            {error ? <InlineError message={error} /> : null}
            {item.status === 'RESOLVED' ? <div className="grid gap-3"><div className="rounded-lg border border-lime-400/15 bg-lime-400/[0.04] px-3 py-2.5 text-sm text-lime-100/80"><strong>{item.resolutionCode ? supportResolutionLabels[item.resolutionCode] : 'حل‌شده'}</strong>{item.resolutionSummary ? <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-zinc-400">{item.resolutionSummary}</p> : null}</div>{canChangeTerminalState ? <><Button className="bg-lime-300/15 text-lime-100 hover:bg-lime-300/25" disabled={submitting} type="button" onClick={() => void close()}>{submitting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} تأیید مشتری و بستن</Button><Field label="دلیل بازگشایی"><Input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} /></Field><Button className="border border-white/10" disabled={!reason.trim() || submitting} type="button" variant="secondary" onClick={() => void reopen()}><RotateCcw className="size-4" /> بازگشایی</Button></> : <p className="text-xs leading-6 text-zinc-600">بستن یا بازگشایی فقط برای مدیر دپارتمان یا سرپرست مجاز است.</p>}</div> : item.status === 'CLOSED' ? canChangeTerminalState ? <div className="grid gap-3"><p className="rounded-lg border border-white/7 px-3 py-3 text-sm text-zinc-500">این پرونده بسته است. بازگشایی استثنایی باید دلیل روشن داشته باشد.</p><Field label="دلیل بازگشایی"><Input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} /></Field><Button className="border border-white/10" disabled={!reason.trim() || submitting} type="button" variant="secondary" onClick={() => void reopen()}>{submitting ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} بازگشایی صریح</Button></div> : <p className="text-xs leading-6 text-zinc-600">این پرونده بسته است و مجوز بازگشایی ندارید.</p> : <form className="grid gap-3" onSubmit={resolve}><Field label="نتیجه"><select className={selectClass} value={code} onChange={(event) => setCode(event.target.value as SupportResolutionCode)}>{resolutionCodes.map((value) => <option key={value} value={value}>{supportResolutionLabels[value]}</option>)}</select></Field>{code === 'DUPLICATE' ? <Field label="شماره پرونده مرجع"><Input dir="ltr" className={cn(inputClass, 'text-left')} placeholder="SUP-123" value={duplicateKey} onChange={(event) => setDuplicateKey(event.target.value.toUpperCase())} /></Field> : null}<Field label="خلاصه نتیجه"><Textarea className={cn(inputClass, 'min-h-20')} maxLength={10000} value={summary} onChange={(event) => setSummary(event.target.value)} /></Field><Button className="bg-lime-300/15 text-lime-100 hover:bg-lime-300/25" disabled={!resolutionCodes.length || !summary.trim() || (code === 'DUPLICATE' && !duplicateKey.trim()) || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} ثبت حل پرونده</Button></form>}
         </CardContent>
      </Card>
   );
}

function InteractionComposer({ item, onChanged }: { item: SupportCase; onChanged: (item: SupportCase) => Promise<void> }) {
   const support = useSupportWorkspace();
   const actionAccess = supportCaseActionAccess(item, support.access);
   const [mode, setMode] = useState<ComposerMode>('NOTE');
   const [body, setBody] = useState('');
   const [disposition, setDisposition] = useState<'ANSWERED' | 'MISSED' | 'ABANDONED' | 'VOICEMAIL'>('ANSWERED');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!body.trim()) return;
      setSubmitting(true);
      setError('');
      try {
         const updated = mode === 'CALL' ? await support.createCall({
            caseId: item.id,
            baseVersion: item.version,
            summary: body.trim(),
            call: { direction: 'OUTBOUND', disposition, startedAt: new Date().toISOString(), recordingConsent: 'UNKNOWN', recordingExists: false },
         }) : await support.addInteraction(item, {
            kind: mode === 'NOTE' ? 'NOTE' : 'MESSAGE',
            visibility: mode === 'NOTE' ? 'INTERNAL' : 'PUBLIC',
            channel: 'MANUAL',
            direction: mode === 'NOTE' ? 'INTERNAL' : mode === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND',
            content: { body: body.trim(), format: 'text/plain' },
         });
         setBody('');
         await onChanged(updated);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ثبت تعامل ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   if (!actionAccess.canWork) return null;
   if (!support.interactionContentAvailable) {
      return (
         <Card className="border-amber-400/15 bg-amber-400/[0.035] text-zinc-100">
            <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><LockKeyhole className="size-4 text-amber-200" /> ثبت تعامل موقتاً غیرفعال است</CardTitle><CardDescription className="leading-6 text-zinc-500">محتوای مشتری باید پیش از ذخیره رمزنگاری شود. تا فعال‌شدن سرویس کلید سمت سرور، متن یادداشت، پیام یا تماس در مرورگر یا پایگاه داده نگهداری نمی‌شود.</CardDescription></CardHeader>
         </Card>
      );
   }

   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader><CardTitle className="text-sm">ثبت تعامل</CardTitle><CardDescription className="leading-6 text-zinc-600">این فرم پیام ارسال نمی‌کند؛ فقط تعامل انجام‌شده از کانال دستی یا تلفنی را ثبت می‌کند.</CardDescription></CardHeader>
         <CardContent><form className="grid gap-3" onSubmit={submit}>{error ? <InlineError message={error} /> : null}<div className={cn('grid grid-cols-2 gap-1 rounded-lg bg-black/15 p-1', support.manualCallAvailable ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>{([['NOTE', 'یادداشت داخلی'], ['PUBLIC', 'پاسخ ثبت‌شده'], ['CUSTOMER', 'پیام مشتری'], ...(support.manualCallAvailable ? [['CALL', 'تماس'] as const] : [])] as const).map(([value, label]) => <button key={value} className={cn('rounded-md px-2 py-2 text-xs transition', mode === value ? 'bg-white/8 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')} type="button" onClick={() => setMode(value)}>{label}</button>)}</div>{mode === 'CALL' ? <Field label="نتیجه تماس"><select className={selectClass} value={disposition} onChange={(event) => setDisposition(event.target.value as typeof disposition)}><option value="ANSWERED">پاسخ داده شد</option><option value="MISSED">بی‌پاسخ</option><option value="ABANDONED">قطع‌شده</option><option value="VOICEMAIL">پیام صوتی</option></select></Field> : null}<Textarea aria-label="متن تعامل" className={cn(inputClass, 'min-h-28')} maxLength={100000} placeholder={mode === 'NOTE' ? 'یادداشت فقط برای تیم پشتیبانی…' : 'خلاصه دقیق تعامل انجام‌شده…'} value={body} onChange={(event) => setBody(event.target.value)} /><div className="flex justify-end"><Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={!body.trim() || submitting || (mode === 'CALL' && !support.manualCallAvailable)} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : mode === 'CALL' ? <PhoneCall className="size-4" /> : <Send className="size-4" />} ثبت تعامل</Button></div></form></CardContent>
      </Card>
   );
}

function TimelineCard({ events, interactions }: { events: SupportCaseEvent[]; interactions: SupportInteraction[] }) {
   const timeline = useMemo(() => [
      ...events.map((item) => ({ at: item.occurredAt, id: `event:${item.id}`, kind: 'event' as const, item })),
      ...interactions.map((item) => ({ at: item.occurredAt, id: `interaction:${item.id}`, kind: 'interaction' as const, item })),
   ].sort((left, right) => left.at.localeCompare(right.at)), [events, interactions]);
   return (
      <Card className="border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><History className="size-4 text-zinc-500" /> خط زمانی و تاریخچه تغییرات</CardTitle><CardDescription className="text-zinc-600">تعامل‌ها و رویدادهای عملیاتی به ترتیب وقوع</CardDescription></CardHeader>
         <CardContent>
            {!timeline.length ? <p className="rounded-lg border border-dashed border-white/10 py-10 text-center text-sm text-zinc-600">هنوز رویدادی ثبت نشده است.</p> : <ol className="space-y-0">{timeline.map((entry, index) => <li key={entry.id} className="relative flex gap-3 pb-5 last:pb-0">{index < timeline.length - 1 ? <span className="absolute end-[13px] top-7 h-[calc(100%-1rem)] w-px bg-white/7" /> : null}<span className={cn('relative z-[1] mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border', entry.kind === 'interaction' ? 'border-indigo-400/20 bg-indigo-400/8 text-indigo-300' : 'border-white/10 bg-[#111113] text-zinc-500')}>{entry.kind === 'interaction' ? entry.item.kind === 'CALL' ? <PhoneCall className="size-3.5" /> : <MessageSquareText className="size-3.5" /> : <History className="size-3.5" />}</span><div className="min-w-0 flex-1 rounded-lg border border-white/6 bg-black/10 px-3 py-2.5">{entry.kind === 'interaction' ? <InteractionTimelineItem item={entry.item} /> : <EventTimelineItem item={entry.item} />}<time className="mt-2 block text-[11px] text-zinc-600">{formatJalaliDateTime(entry.at)}</time></div></li>)}</ol>}
         </CardContent>
      </Card>
   );
}

function InteractionTimelineItem({ item }: { item: SupportInteraction }) {
   const label = item.kind === 'CALL' ? 'تماس' : item.visibility === 'INTERNAL' ? 'یادداشت داخلی' : item.direction === 'INBOUND' ? 'پیام مشتری' : 'پاسخ ثبت‌شده';
   const body = item.content && 'body' in item.content ? item.content.body : '';
   return <div><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-zinc-300">{label}</span><Badge variant="outline" className="border-white/8 text-[10px] text-zinc-500">{supportSourceLabels[item.channel]}</Badge>{item.author?.name || item.actor?.name ? <span className="text-[11px] text-zinc-600">{item.author?.name || item.actor?.name}</span> : null}</div>{body ? <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-zinc-400">{body}</p> : <p className="mt-2 text-xs text-zinc-600">متن تعامل در این نما موجود نیست.</p>}{item.call ? <p className="mt-2 text-xs text-zinc-500">نتیجه تماس: {callDispositionLabel(item.call.disposition)}{typeof item.call.durationSeconds === 'number' ? ` — ${item.call.durationSeconds.toLocaleString('fa-IR')} ثانیه` : ''}</p> : null}</div>;
}

function EventTimelineItem({ item }: { item: SupportCaseEvent }) {
   return <div><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-zinc-300">{eventActionLabel(item.action)}</span>{item.actor?.name ? <span className="text-[11px] text-zinc-600">توسط {item.actor.name}</span> : null}</div>{item.reason ? <p className="mt-2 text-xs leading-6 text-zinc-500">دلیل: {item.reason}</p> : null}</div>;
}

function Fact({ icon: Icon, label, ltr, value }: { icon: React.ComponentType<{ className?: string }>; label: string; ltr?: boolean; value: string }) {
   return <div className="flex items-start gap-2.5"><Icon className="mt-0.5 size-4 shrink-0 text-zinc-600" /><div className="min-w-0"><div className="text-[11px] text-zinc-600">{label}</div><div dir={ltr ? 'ltr' : undefined} className={cn('mt-0.5 break-words text-xs leading-6 text-zinc-300', ltr && 'text-left')}>{value}</div></div></div>;
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
   return <label className="grid gap-1.5 text-xs text-zinc-400"><span>{label}</span>{children}</label>;
}

function InlineError({ message }: { message: string }) {
   return <p role="alert" className="mb-3 rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-xs leading-6 text-red-200">{message}</p>;
}

function eventActionLabel(action: string) {
   const labels: Record<string, string> = {
      'case.created': 'پرونده ایجاد شد',
      'case.routed': 'به دپارتمان ارجاع شد',
      'case.assigned': 'مسئول پرونده تعیین شد',
      'case.unassigned': 'به صف دپارتمان بازگشت',
      'case.transferred': 'دپارتمان پرونده تغییر کرد',
      'case.waiting': 'وضعیت انتظار ثبت شد',
      'case.attention_snoozed': 'توجه به پرونده تعویق شد',
      'case.attention_resumed': 'توجه به پرونده از سر گرفته شد',
      'case.resolved': 'پرونده حل شد',
      'case.closed': 'پرونده بسته شد',
      'case.reopened': 'پرونده دوباره باز شد',
      'case.interaction_recorded': 'تعامل ثبت شد',
      'case.returned_to_department_inbox': 'پس از تغییر عضویت به صف بازگشت',
   };
   return labels[action] || action;
}

function callDispositionLabel(value: string) {
   return ({ ANSWERED: 'پاسخ داده شد', MISSED: 'بی‌پاسخ', ABANDONED: 'قطع‌شده', VOICEMAIL: 'پیام صوتی' } as Record<string, string>)[value] || value;
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
