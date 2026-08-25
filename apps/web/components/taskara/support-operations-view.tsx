import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
   AlarmClock,
   CalendarDays,
   CheckCircle2,
   CopyPlus,
   Loader2,
   Plus,
   Power,
   ShieldCheck,
   Trash2,
} from 'lucide-react';
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
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportOperationsClient } from '@/lib/support-operations-client';
import {
   supportSlaMetrics,
   type CreateSupportCalendarInput,
   type CreateSupportSlaPolicyInput,
   type SupportBusinessCalendar,
   type SupportCalendarHoliday,
   type SupportCalendarPeriod,
   type SupportSlaMetric,
   type SupportSlaPolicy,
   type SupportSlaTarget,
} from '@/lib/support-operations-types';
import type { SupportCasePriority, SupportCaseSource, SupportDepartment } from '@/lib/support-types';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { cn } from '@/lib/utils';

const dayLabels: Record<number, string> = {
   1: 'دوشنبه', 2: 'سه‌شنبه', 3: 'چهارشنبه', 4: 'پنج‌شنبه',
   5: 'جمعه', 6: 'شنبه', 7: 'یکشنبه',
};

const metricLabels: Record<SupportSlaMetric, string> = {
   TRIAGE: 'تریاژ',
   FIRST_RESPONSE: 'اولین پاسخ',
   NEXT_RESPONSE: 'پاسخ بعدی',
   RESOLUTION: 'حل پرونده',
   FOLLOW_UP: 'پیگیری',
   MEMBER_ASSIGNMENT: 'واگذاری به عضو',
};

const priorityLabels: Record<SupportCasePriority, string> = {
   LOW: 'کم', NORMAL: 'عادی', HIGH: 'بالا', URGENT: 'فوری',
};

const sourceLabels: Record<SupportCaseSource, string> = {
   API: 'API', CALL: 'تماس', MANUAL: 'دستی', EMAIL: 'ایمیل', MESSAGING: 'پیام‌رسان',
};

const defaultPeriods: SupportCalendarPeriod[] = [6, 7, 1, 2, 3].map((dayOfWeek) => ({
   dayOfWeek,
   startMinute: 9 * 60,
   endMinute: 17 * 60,
}));

export function SupportOperationsView() {
   const support = useSupportWorkspace();
   const [calendars, setCalendars] = useState<SupportBusinessCalendar[]>([]);
   const [policies, setPolicies] = useState<SupportSlaPolicy[]>([]);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [calendarDialog, setCalendarDialog] = useState<SupportBusinessCalendar | null | undefined>();
   const [policyDialog, setPolicyDialog] = useState<SupportSlaPolicy | null | undefined>();

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      try {
         const [nextCalendars, nextPolicies] = await Promise.all([
            supportOperationsClient.listCalendars(),
            supportOperationsClient.listSlaPolicies(),
            support.loadDepartments(),
         ]);
         setCalendars(nextCalendars);
         setPolicies(nextPolicies);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'بارگذاری تنظیمات عملیاتی پشتیبانی ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [support.loadDepartments]);

   useEffect(() => {
      void load();
   }, [load]);

   async function deactivate(policy: SupportSlaPolicy) {
      if (!window.confirm(`نسخه ${policy.version.toLocaleString('fa-IR')} سیاست «${policy.name}» غیرفعال شود؟ سابقه آن تغییر نمی‌کند.`)) return;
      setError('');
      try {
         const updated = await supportOperationsClient.deactivateSlaPolicy(policy.id);
         setPolicies((current) => current.map((item) => item.id === updated.id ? updated : item));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'غیرفعال‌سازی سیاست SLA ناموفق بود.');
      }
   }

   return (
      <main dir="rtl" className="min-h-full bg-[#101011] px-4 py-5 text-zinc-200 sm:px-5" data-testid="support-operations-screen">
         <div className="mx-auto max-w-7xl space-y-4">
            <div className="rounded-xl border border-indigo-400/15 bg-indigo-400/[0.045] px-4 py-3.5 text-sm leading-7 text-indigo-100/75">
               <ShieldCheck className="me-1 inline size-4 text-indigo-300" />
               تقویم، زمان کاری هر دپارتمان را تعریف می‌کند. هر تغییر SLA با یک نسخه تازه اعمال می‌شود تا تعهد پرونده‌های قبلی قابل حسابرسی بماند.
            </div>
            {error ? <InlineError message={error} /> : null}
            {loading ? <LoadingPanel /> : (
               <div className="grid gap-4 xl:grid-cols-2">
                  <CalendarSection calendars={calendars} onCreate={() => setCalendarDialog(null)} onEdit={setCalendarDialog} />
                  <SupportSlaPolicySection policies={policies} onCreate={() => setPolicyDialog(null)} onNewVersion={setPolicyDialog} onDeactivate={(policy) => void deactivate(policy)} />
               </div>
            )}
         </div>

         {calendarDialog !== undefined ? (
            <CalendarDialog
               calendar={calendarDialog}
               departments={support.departments}
               open
               onOpenChange={(open) => { if (!open) setCalendarDialog(undefined); }}
               onSaved={(saved) => {
                  setCalendars((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
                  setCalendarDialog(undefined);
               }}
            />
         ) : null}
         {policyDialog !== undefined ? (
            <SlaPolicyDialog
               calendars={calendars.filter((calendar) => calendar.active)}
               departments={support.departments.filter((department) => department.active)}
               template={policyDialog}
               open
               onOpenChange={(open) => { if (!open) setPolicyDialog(undefined); }}
               onCreated={(created) => {
                  setPolicies((current) => [created, ...current]);
                  setPolicyDialog(undefined);
               }}
            />
         ) : null}
      </main>
   );
}

function CalendarSection({
   calendars,
   onCreate,
   onEdit,
}: {
   calendars: SupportBusinessCalendar[];
   onCreate: () => void;
   onEdit: (calendar: SupportBusinessCalendar) => void;
}) {
   return (
      <Card className="h-fit border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-white/7">
            <div>
               <CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="size-4 text-indigo-300" />تقویم‌های کاری</CardTitle>
               <CardDescription className="mt-1.5 leading-6 text-zinc-500">ساعت کاری، منطقه زمانی و تعطیلات سازمان</CardDescription>
            </div>
            <Button className="shrink-0 bg-zinc-100 text-zinc-950 hover:bg-white" size="sm" type="button" onClick={onCreate}><Plus className="size-4" />تقویم</Button>
         </CardHeader>
         <CardContent className="space-y-3 p-4">
            {!calendars.length ? <Empty icon={CalendarDays} text="هنوز تقویم کاری ساخته نشده است." /> : null}
            {calendars.map((calendar) => (
               <article key={calendar.id} className="rounded-xl border border-white/7 bg-black/10 p-4" data-testid={`support-calendar-${calendar.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                     <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                           <h3 className="font-medium text-zinc-200">{calendar.name}</h3>
                           <Badge variant="outline" className={calendar.active ? 'border-lime-400/20 bg-lime-400/8 text-lime-300' : 'border-white/10 text-zinc-500'}>{calendar.active ? 'فعال' : 'غیرفعال'}</Badge>
                        </div>
                        <p dir="ltr" className="mt-1 text-left text-xs text-zinc-600">{calendar.timezone}</p>
                     </div>
                     <Button className="border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" size="sm" type="button" variant="secondary" onClick={() => onEdit(calendar)}>ویرایش تقویم</Button>
                  </div>
                  <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                     <Fact label="محدوده" value={calendar.department?.name || 'کل فضای پشتیبانی'} />
                     <Fact label="بازه‌های کاری" value={`${calendar.periods.length.toLocaleString('fa-IR')} بازه در هفته`} />
                     <Fact label="استثناهای ثبت‌شده" value={`${calendar.holidays.length.toLocaleString('fa-IR')} روز`} />
                     <Fact label="آخرین تغییر" value={formatJalaliDateTime(calendar.updatedAt)} />
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                     {calendar.periods.map((period, index) => (
                        <span key={`${period.dayOfWeek}-${period.startMinute}-${index}`} className="rounded-md border border-white/7 bg-white/[0.025] px-2 py-1 text-[11px] text-zinc-500">
                           {dayLabels[period.dayOfWeek]} {minuteLabel(period.startMinute)}–{minuteLabel(period.endMinute)}
                        </span>
                     ))}
                  </div>
               </article>
            ))}
         </CardContent>
      </Card>
   );
}

export function SupportSlaPolicySection({
   policies,
   onCreate,
   onNewVersion,
   onDeactivate,
}: {
   policies: SupportSlaPolicy[];
   onCreate: () => void;
   onNewVersion: (policy: SupportSlaPolicy) => void;
   onDeactivate: (policy: SupportSlaPolicy) => void;
}) {
   return (
      <Card className="h-fit border-white/8 bg-[#171719] text-zinc-100">
         <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-white/7">
            <div>
               <CardTitle className="flex items-center gap-2 text-base"><AlarmClock className="size-4 text-amber-300" />سیاست‌های SLA</CardTitle>
               <CardDescription className="mt-1.5 leading-6 text-zinc-500">نسخه‌های تغییرناپذیر تعهد پاسخ و حل</CardDescription>
            </div>
            <Button className="shrink-0 bg-zinc-100 text-zinc-950 hover:bg-white" size="sm" type="button" onClick={onCreate}><Plus className="size-4" />سیاست</Button>
         </CardHeader>
         <CardContent className="space-y-3 p-4">
            {!policies.length ? <Empty icon={AlarmClock} text="هنوز سیاست SLA ساخته نشده است." /> : null}
            {policies.map((policy) => (
               <article key={policy.id} className="rounded-xl border border-white/7 bg-black/10 p-4" data-testid={`support-sla-policy-${policy.id}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                     <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                           <h3 className="font-medium text-zinc-200">{policy.name}</h3>
                           <Badge variant="outline" className="border-white/10 font-mono text-[10px] text-zinc-500"><bdi dir="ltr">{policy.policyKey}</bdi></Badge>
                           <Badge variant="outline" className="border-indigo-400/15 bg-indigo-400/5 text-indigo-200">نسخه {policy.version.toLocaleString('fa-IR')}</Badge>
                           <Badge variant="outline" className={policy.active ? 'border-lime-400/20 bg-lime-400/8 text-lime-300' : 'border-white/10 text-zinc-500'}>{policy.active ? 'فعال' : 'غیرفعال'}</Badge>
                        </div>
                        <p className="mt-1.5 text-xs text-zinc-600">تقویم {policy.calendar.name} · اولویت اجرا {policy.priority.toLocaleString('fa-IR')}</p>
                     </div>
                     <div className="flex flex-wrap gap-2">
                        <Button className="border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10" size="sm" type="button" variant="secondary" onClick={() => onNewVersion(policy)}><CopyPlus className="size-3.5" />نسخه جدید</Button>
                        {policy.active ? <Button aria-label={`غیرفعال‌سازی نسخه ${policy.version} ${policy.name}`} className="text-zinc-500 hover:bg-red-400/10 hover:text-red-300" size="icon" type="button" variant="ghost" onClick={() => onDeactivate(policy)}><Power className="size-4" /></Button> : null}
                     </div>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                     {Object.entries(policy.targets).map(([metric, target]) => (
                        <div key={metric} className="flex items-center justify-between gap-3 rounded-lg border border-white/6 px-3 py-2 text-xs">
                           <span className="text-zinc-500">{metricLabels[metric as SupportSlaMetric]}</span>
                           <span className="text-zinc-300">{durationLabel(target.businessSeconds)}</span>
                        </div>
                     ))}
                  </div>
                  <p className="mt-3 text-[11px] leading-6 text-zinc-600">اثر از {formatJalaliDateTime(policy.effectiveFrom)}{policy.effectiveUntil ? ` تا ${formatJalaliDateTime(policy.effectiveUntil)}` : ' · بدون پایان مشخص'}</p>
                  <p className="mt-2 rounded-md border border-white/6 bg-white/[0.02] px-3 py-2 text-[11px] leading-6 text-zinc-600">این نسخه ویرایش نمی‌شود؛ برای تغییر هدف‌ها یا قواعد توقف، نسخه تازه بسازید.</p>
               </article>
            ))}
         </CardContent>
      </Card>
   );
}

function CalendarDialog({
   calendar,
   departments,
   open,
   onOpenChange,
   onSaved,
}: {
   calendar: SupportBusinessCalendar | null;
   departments: SupportDepartment[];
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onSaved: (calendar: SupportBusinessCalendar) => void;
}) {
   const [name, setName] = useState(calendar?.name || 'ساعات کاری تهران');
   const [timezone, setTimezone] = useState(calendar?.timezone || 'Asia/Tehran');
   const [departmentId, setDepartmentId] = useState(calendar?.department?.id || '');
   const [active, setActive] = useState(calendar?.active !== false);
   const [periods, setPeriods] = useState<SupportCalendarPeriod[]>(calendar?.periods || defaultPeriods);
   const [holidays, setHolidays] = useState<SupportCalendarHoliday[]>(calendar?.holidays || []);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!name.trim() || !timezone.trim() || !periods.length) return;
      setSubmitting(true);
      setError('');
      const input: CreateSupportCalendarInput = {
         name: name.trim(),
         timezone: timezone.trim(),
         departmentId: departmentId || null,
         periods: periods.map((period) => ({ ...period })),
         holidays: holidays.filter((holiday) => holiday.date && holiday.name.trim()).map((holiday) => ({ ...holiday, name: holiday.name.trim() })),
      };
      try {
         const saved = calendar
            ? await supportOperationsClient.updateCalendar(calendar.id, { ...input, active })
            : await supportOperationsClient.createCalendar(input);
         onSaved(saved);
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ذخیره تقویم کاری ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent dir="rtl" className="max-h-[92vh] max-w-3xl overflow-y-auto border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader className="text-right"><DialogTitle>{calendar ? 'ویرایش تقویم کاری' : 'ساخت تقویم کاری'}</DialogTitle><DialogDescription className="leading-6 text-zinc-500">بازه‌ها به وقت منطقه زمانی تقویم محاسبه می‌شوند و هم‌پوشانی ندارند.</DialogDescription></DialogHeader>
            <form className="space-y-5" onSubmit={submit}>
               {error ? <InlineError message={error} /> : null}
               <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="نام تقویم"><Input className={inputClass} required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></Field>
                  <Field label="منطقه زمانی IANA"><Input dir="ltr" className={cn(inputClass, 'text-left')} required maxLength={120} placeholder="Asia/Tehran" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field>
                  <Field label="محدوده دپارتمان"><select className={selectClass} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">کل فضای پشتیبانی</option>{departments.filter((item) => item.active || item.id === departmentId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
                  {calendar ? <Field label="وضعیت"><select className={selectClass} value={active ? 'ACTIVE' : 'INACTIVE'} onChange={(event) => setActive(event.target.value === 'ACTIVE')}><option value="ACTIVE">فعال</option><option value="INACTIVE">غیرفعال</option></select></Field> : null}
               </div>

               <section>
                  <div className="mb-2 flex items-center justify-between gap-3"><div><h4 className="text-sm font-medium">بازه‌های هفتگی</h4><p className="mt-1 text-xs leading-6 text-zinc-600">حداقل یک بازه لازم است؛ پایان باید پس از شروع باشد.</p></div><Button size="sm" type="button" variant="secondary" className="border border-white/10 bg-white/5 text-zinc-300" onClick={() => setPeriods((current) => [...current, { dayOfWeek: 6, startMinute: 540, endMinute: 1020 }])}><Plus className="size-3.5" />بازه</Button></div>
                  <div className="space-y-2">
                     {periods.map((period, index) => (
                        <div key={index} className="grid grid-cols-[minmax(0,1fr)_100px_100px_36px] gap-2 rounded-lg border border-white/7 bg-black/10 p-2">
                           <select aria-label={`روز بازه ${index + 1}`} className={selectClass} value={period.dayOfWeek} onChange={(event) => setPeriods(replaceAt(periods, index, { ...period, dayOfWeek: Number(event.target.value) }))}>{Object.entries(dayLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                           <Input aria-label={`شروع بازه ${index + 1}`} dir="ltr" type="time" className={cn(inputClass, 'text-left')} value={minuteInput(period.startMinute)} onChange={(event) => setPeriods(replaceAt(periods, index, { ...period, startMinute: inputMinute(event.target.value) }))} />
                           <Input aria-label={`پایان بازه ${index + 1}`} dir="ltr" type="time" className={cn(inputClass, 'text-left')} value={minuteInput(period.endMinute)} onChange={(event) => setPeriods(replaceAt(periods, index, { ...period, endMinute: inputEndMinute(event.target.value) }))} />
                           <Button aria-label={`حذف بازه ${index + 1}`} className="text-zinc-600 hover:bg-red-400/10 hover:text-red-300" size="icon" type="button" variant="ghost" onClick={() => setPeriods(periods.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-4" /></Button>
                        </div>
                     ))}
                  </div>
               </section>

               <section>
                  <div className="mb-2 flex items-center justify-between gap-3"><div><h4 className="text-sm font-medium">تعطیلات و استثناها</h4><p className="mt-1 text-xs leading-6 text-zinc-600">تاریخ را با تقویم جلالی انتخاب کنید؛ روز غیرکاری پیش‌فرض است.</p></div><Button size="sm" type="button" variant="secondary" className="border border-white/10 bg-white/5 text-zinc-300" onClick={() => setHolidays((current) => [...current, { date: '', name: '', working: false }])}><Plus className="size-3.5" />روز</Button></div>
                  <div className="space-y-2">
                     {holidays.map((holiday, index) => (
                        <div key={index} className="grid gap-2 rounded-lg border border-white/7 bg-black/10 p-2 sm:grid-cols-[180px_minmax(0,1fr)_140px_36px] sm:items-center">
                           <LazyJalaliDatePicker ariaLabel={`تاریخ استثنا ${index + 1}`} value={holiday.date ? `${holiday.date}T12:00:00` : null} onChange={(value) => setHolidays(replaceAt(holidays, index, { ...holiday, date: value ? localDateKey(value) : '' }))} />
                           <Input aria-label={`نام استثنا ${index + 1}`} className={inputClass} maxLength={160} placeholder="نام تعطیلی یا روز کاری" value={holiday.name} onChange={(event) => setHolidays(replaceAt(holidays, index, { ...holiday, name: event.target.value }))} />
                           <label className="flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" checked={holiday.working} onChange={(event) => setHolidays(replaceAt(holidays, index, { ...holiday, working: event.target.checked }))} />روز کاری استثنایی</label>
                           <Button aria-label={`حذف استثنا ${index + 1}`} className="text-zinc-600 hover:bg-red-400/10 hover:text-red-300" size="icon" type="button" variant="ghost" onClick={() => setHolidays(holidays.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-4" /></Button>
                        </div>
                     ))}
                  </div>
               </section>
               <DialogFooter className="gap-2 sm:justify-start"><Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={submitting || !name.trim() || !timezone.trim() || !periods.length} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{calendar ? 'ذخیره تغییرات' : 'ساخت تقویم'}</Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

type TargetDraft = Record<SupportSlaMetric, { enabled: boolean; hours: string; atRiskHours: string }>;

function SlaPolicyDialog({
   calendars,
   departments,
   template,
   open,
   onOpenChange,
   onCreated,
}: {
   calendars: SupportBusinessCalendar[];
   departments: SupportDepartment[];
   template: SupportSlaPolicy | null;
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onCreated: (policy: SupportSlaPolicy) => void;
}) {
   const [calendarId, setCalendarId] = useState(template?.calendar.id || calendars[0]?.id || '');
   const [policyKey, setPolicyKey] = useState(template?.policyKey || 'standard-support');
   const [name, setName] = useState(template?.name || 'استاندارد پشتیبانی');
   const [priority, setPriority] = useState(String(template?.priority ?? 100));
   const [effectiveFrom, setEffectiveFrom] = useState<string | null>(new Date().toISOString());
   const [effectiveUntil, setEffectiveUntil] = useState<string | null>(null);
   const [caseTypes, setCaseTypes] = useState(template?.conditions.caseTypes?.join(', ') || '');
   const [priorities, setPriorities] = useState<SupportCasePriority[]>(template?.conditions.priorities || []);
   const [sources, setSources] = useState<SupportCaseSource[]>(template?.conditions.sourceChannels || []);
   const [departmentIds, setDepartmentIds] = useState<string[]>(template?.conditions.departmentIds || []);
   const [targets, setTargets] = useState<TargetDraft>(() => targetDraft(template));
   const [pauseRules, setPauseRules] = useState(() => ({
      waitingOnCustomer: template?.pauseRules.waitingOnCustomer || [] as SupportSlaMetric[],
      waitingOnInternal: template?.pauseRules.waitingOnInternal || [] as SupportSlaMetric[],
      snoozed: template?.pauseRules.snoozed || [] as SupportSlaMetric[],
      automatedPublicResponseMeets: template?.pauseRules.automatedPublicResponseMeets || [] as Array<'FIRST_RESPONSE' | 'NEXT_RESPONSE'>,
   }));
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   const targetInput = useMemo(() => Object.fromEntries(
      supportSlaMetrics.flatMap((metric) => {
         const draft = targets[metric];
         const hours = Number(draft.hours);
         const atRiskHours = draft.atRiskHours === '' ? undefined : Number(draft.atRiskHours);
         if (!draft.enabled || !Number.isFinite(hours) || hours <= 0) return [];
         const target: SupportSlaTarget = {
            businessSeconds: Math.round(hours * 3600),
            ...(atRiskHours !== undefined && Number.isFinite(atRiskHours) && atRiskHours >= 0
               ? { atRiskSeconds: Math.round(atRiskHours * 3600) }
               : {}),
         };
         return [[metric, target]];
      })
   ), [targets]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!calendarId || !policyKey.trim() || !name.trim() || !effectiveFrom || !Object.keys(targetInput).length) return;
      setSubmitting(true);
      setError('');
      const input: CreateSupportSlaPolicyInput = {
         calendarId,
         policyKey: policyKey.trim().toLowerCase(),
         name: name.trim(),
         priority: Number(priority),
         conditions: {
            ...(commaValues(caseTypes).length ? { caseTypes: commaValues(caseTypes) } : {}),
            ...(priorities.length ? { priorities } : {}),
            ...(sources.length ? { sourceChannels: sources } : {}),
            ...(departmentIds.length ? { departmentIds } : {}),
         },
         targets: targetInput,
         pauseRules,
         effectiveFrom,
         effectiveUntil,
      };
      try {
         onCreated(await supportOperationsClient.createSlaPolicy(input));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ساخت نسخه سیاست SLA ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent dir="rtl" className="max-h-[94vh] max-w-5xl overflow-y-auto border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader className="text-right"><DialogTitle>{template ? `نسخه تازه ${template.name}` : 'ساخت سیاست SLA'}</DialogTitle><DialogDescription className="leading-6 text-zinc-500">ذخیره، یک نسخه تغییرناپذیر می‌سازد. هدف‌ها بر حسب ساعت کاری تقویم محاسبه می‌شوند.</DialogDescription></DialogHeader>
            <form className="space-y-5" onSubmit={submit}>
               {error ? <InlineError message={error} /> : null}
               {!calendars.length ? <InlineError message="برای ساخت SLA ابتدا یک تقویم کاری فعال بسازید." /> : null}
               <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="کلید سیاست"><Input dir="ltr" className={cn(inputClass, 'text-left')} required readOnly={Boolean(template)} pattern="[a-z0-9][a-z0-9_-]{1,79}" value={policyKey} onChange={(event) => setPolicyKey(event.target.value)} /></Field>
                  <Field label="نام نسخه"><Input className={inputClass} required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></Field>
                  <Field label="اولویت تطبیق (کمتر، مقدم‌تر)"><Input dir="ltr" className={cn(inputClass, 'text-left')} type="number" min={0} max={10000} required value={priority} onChange={(event) => setPriority(event.target.value)} /></Field>
                  <Field label="تقویم کاری"><select className={selectClass} required value={calendarId} onChange={(event) => setCalendarId(event.target.value)}><option value="">انتخاب تقویم</option>{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name} — {calendar.timezone}</option>)}</select></Field>
                  <Field label="زمان شروع اثر"><LazyJalaliDatePicker ariaLabel="زمان شروع اثر سیاست" showTime value={effectiveFrom} onChange={setEffectiveFrom} /></Field>
                  <Field label="زمان پایان اثر (اختیاری)"><LazyJalaliDatePicker ariaLabel="زمان پایان اثر سیاست" showTime value={effectiveUntil} onChange={setEffectiveUntil} /></Field>
               </div>

               <section className="rounded-xl border border-white/7 bg-black/10 p-4">
                  <h4 className="text-sm font-medium">شرایط تطبیق</h4>
                  <p className="mt-1 text-xs leading-6 text-zinc-600">خالی‌بودن هر گروه یعنی همه مقادیر آن گروه. شرایط محدودتر را با اولویت کمتر ثبت کنید.</p>
                  <div className="mt-3 grid gap-4 lg:grid-cols-2">
                     <Field label="نوع پرونده (با ویرگول جدا کنید)"><Input dir="ltr" className={cn(inputClass, 'text-left')} placeholder="billing, outage" value={caseTypes} onChange={(event) => setCaseTypes(event.target.value)} /></Field>
                     <CheckGroup label="اولویت‌ها" values={Object.keys(priorityLabels) as SupportCasePriority[]} selected={priorities} labelFor={(value) => priorityLabels[value]} onChange={setPriorities} />
                     <CheckGroup label="کانال‌های ورودی" values={Object.keys(sourceLabels) as SupportCaseSource[]} selected={sources} labelFor={(value) => sourceLabels[value]} onChange={setSources} />
                     <CheckGroup label="دپارتمان‌ها" values={departments.map((item) => item.id)} selected={departmentIds} labelFor={(value) => departments.find((item) => item.id === value)?.name || value} onChange={setDepartmentIds} />
                  </div>
               </section>

               <section>
                  <h4 className="text-sm font-medium">هدف‌ها و قواعد توقف</h4>
                  <p className="mt-1 text-xs leading-6 text-zinc-600">SLA را هنگام انتظار داخلی یا تعویق، فقط با سیاست روشن متوقف کنید؛ این گزینه‌ها می‌توانند تعهد را طولانی کنند.</p>
                  <div className="mt-3 overflow-x-auto rounded-xl border border-white/7">
                     <table className="w-full min-w-[940px] text-xs">
                        <thead className="bg-white/[0.025] text-zinc-500"><tr><th className="px-3 py-2.5 text-right">معیار</th><th className="px-3 py-2.5">فعال</th><th className="px-3 py-2.5">هدف (ساعت کاری)</th><th className="px-3 py-2.5">هشدار از ساعت</th><th className="px-3 py-2.5">انتظار مشتری</th><th className="px-3 py-2.5">انتظار داخلی</th><th className="px-3 py-2.5">تعویق هشدار</th><th className="px-3 py-2.5">پاسخ خودکار کافی است</th></tr></thead>
                        <tbody className="divide-y divide-white/6">
                           {supportSlaMetrics.map((metric) => (
                              <tr key={metric} className={cn(!targets[metric].enabled && 'opacity-55')}>
                                 <td className="whitespace-nowrap px-3 py-2.5 text-zinc-300">{metricLabels[metric]}</td>
                                 <td className="px-3 py-2.5 text-center"><input aria-label={`فعال‌سازی ${metricLabels[metric]}`} type="checkbox" checked={targets[metric].enabled} onChange={(event) => setTargets({ ...targets, [metric]: { ...targets[metric], enabled: event.target.checked } })} /></td>
                                 <td className="px-3 py-2.5"><Input aria-label={`هدف ${metricLabels[metric]}`} dir="ltr" className={cn(inputClass, 'min-w-24 text-left')} type="number" min="0.25" step="0.25" disabled={!targets[metric].enabled} value={targets[metric].hours} onChange={(event) => setTargets({ ...targets, [metric]: { ...targets[metric], hours: event.target.value } })} /></td>
                                 <td className="px-3 py-2.5"><Input aria-label={`آستانه هشدار ${metricLabels[metric]}`} dir="ltr" className={cn(inputClass, 'min-w-24 text-left')} type="number" min="0" step="0.25" disabled={!targets[metric].enabled} value={targets[metric].atRiskHours} onChange={(event) => setTargets({ ...targets, [metric]: { ...targets[metric], atRiskHours: event.target.value } })} /></td>
                                 <PauseCell checked={pauseRules.waitingOnCustomer.includes(metric)} label={`توقف ${metricLabels[metric]} در انتظار مشتری`} onChange={(checked) => setPauseRules({ ...pauseRules, waitingOnCustomer: toggle(pauseRules.waitingOnCustomer, metric, checked) })} />
                                 <PauseCell checked={pauseRules.waitingOnInternal.includes(metric)} label={`توقف ${metricLabels[metric]} در انتظار داخلی`} onChange={(checked) => setPauseRules({ ...pauseRules, waitingOnInternal: toggle(pauseRules.waitingOnInternal, metric, checked) })} />
                                 <PauseCell checked={pauseRules.snoozed.includes(metric)} label={`توقف ${metricLabels[metric]} هنگام تعویق`} onChange={(checked) => setPauseRules({ ...pauseRules, snoozed: toggle(pauseRules.snoozed, metric, checked) })} />
                                 <td className="px-3 py-2.5 text-center">{metric === 'FIRST_RESPONSE' || metric === 'NEXT_RESPONSE' ? <input aria-label={`پاسخ خودکار برای ${metricLabels[metric]}`} type="checkbox" checked={pauseRules.automatedPublicResponseMeets.includes(metric)} onChange={(event) => setPauseRules({ ...pauseRules, automatedPublicResponseMeets: toggle(pauseRules.automatedPublicResponseMeets, metric, event.target.checked) })} /> : <span className="text-zinc-700">—</span>}</td>
                              </tr>
                           ))}
                        </tbody>
                     </table>
                  </div>
               </section>
               <DialogFooter className="gap-2 sm:justify-start"><Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={submitting || !calendars.length || !calendarId || !effectiveFrom || !Object.keys(targetInput).length} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : <CopyPlus className="size-4" />}{template ? 'ساخت نسخه جدید' : 'ساخت سیاست'}</Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function PauseCell({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
   return <td className="px-3 py-2.5 text-center"><input aria-label={label} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></td>;
}

function CheckGroup<T extends string>({ label, values, selected, labelFor, onChange }: { label: string; values: T[]; selected: T[]; labelFor: (value: T) => string; onChange: (values: T[]) => void }) {
   return <fieldset className="rounded-lg border border-white/7 p-3"><legend className="px-1 text-xs text-zinc-500">{label}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{values.map((value) => <label key={value} className="flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" checked={selected.includes(value)} onChange={(event) => onChange(toggle(selected, value, event.target.checked))} />{labelFor(value)}</label>)}</div></fieldset>;
}

function targetDraft(policy: SupportSlaPolicy | null): TargetDraft {
   return Object.fromEntries(supportSlaMetrics.map((metric) => {
      const target = policy?.targets[metric];
      const defaultTarget = metric === 'FIRST_RESPONSE' ? 1 : metric === 'RESOLUTION' ? 8 : 4;
      return [metric, {
         enabled: Boolean(target) || (!policy && metric === 'FIRST_RESPONSE'),
         hours: String(target ? target.businessSeconds / 3600 : defaultTarget),
         atRiskHours: target?.atRiskSeconds === undefined ? '' : String(target.atRiskSeconds / 3600),
      }];
   })) as TargetDraft;
}

function toggle<T>(values: T[], value: T, checked: boolean): T[] {
   return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function replaceAt<T>(values: T[], index: number, value: T): T[] {
   return values.map((item, itemIndex) => itemIndex === index ? value : item);
}

function commaValues(value: string): string[] {
   return [...new Set(value.split(/[،,]/).map((item) => item.trim()).filter(Boolean))];
}

function minuteInput(value: number): string {
   if (value === 1440) return '00:00';
   return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function inputMinute(value: string): number {
   const [hour = '0', minute = '0'] = value.split(':');
   return Number(hour) * 60 + Number(minute);
}

function inputEndMinute(value: string): number {
   const minute = inputMinute(value);
   return minute === 0 ? 1440 : minute;
}

function minuteLabel(value: number): string {
   const label = value === 1440 ? '24:00' : minuteInput(value);
   return label.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
}

function localDateKey(value: string): string {
   const date = new Date(value);
   return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function durationLabel(seconds: number): string {
   const hours = seconds / 3600;
   return `${hours.toLocaleString('fa-IR', { maximumFractionDigits: 2 })} ساعت کاری`;
}

function Fact({ label, value }: { label: string; value: string }) {
   return <div><dt className="text-zinc-600">{label}</dt><dd className="mt-1 text-zinc-300">{value}</dd></div>;
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
   return <label className="grid gap-1.5 text-xs text-zinc-400"><span>{label}</span>{children}</label>;
}

function Empty({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
   return <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center"><Icon className="mx-auto size-7 text-zinc-700" /><p className="mt-3 text-sm text-zinc-600">{text}</p></div>;
}

function LoadingPanel() {
   return <div className="flex min-h-72 items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171719] text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" />در حال بارگذاری تقویم‌ها و سیاست‌ها…</div>;
}

function InlineError({ message }: { message: string }) {
   return <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-sm leading-6 text-red-200">{message}</p>;
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
