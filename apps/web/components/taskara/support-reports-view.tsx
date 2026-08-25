import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
   Activity,
   AlertTriangle,
   BarChart3,
   CheckCircle2,
   Clock3,
   Inbox,
   Loader2,
   RefreshCw,
   ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LazyJalaliDatePicker } from '@/components/taskara/lazy-jalali-date-picker';
import { formatJalaliDateTime } from '@/lib/jalali';
import { supportOperationsClient } from '@/lib/support-operations-client';
import type { SupportDurationSummary, SupportOperationalReport, SupportSlaMetric } from '@/lib/support-operations-types';
import { supportPriorityLabels, supportResolutionLabels, supportSourceLabels, supportStatusLabels } from '@/lib/support-presenters';
import { useSupportWorkspace } from '@/lib/support-workspace-provider';
import { cn } from '@/lib/utils';

const metricLabels: Record<SupportSlaMetric, string> = {
   TRIAGE: 'تریاژ', FIRST_RESPONSE: 'اولین پاسخ', NEXT_RESPONSE: 'پاسخ بعدی',
   RESOLUTION: 'حل پرونده', FOLLOW_UP: 'پیگیری', MEMBER_ASSIGNMENT: 'واگذاری به عضو',
};

const queueLabels: Record<string, string> = {
   TRIAGE: 'تریاژ', DEPARTMENT_INBOX: 'صف دپارتمان', MY_CASES: 'پرونده‌های من', NEEDS_ATTENTION: 'نیازمند توجه',
   triage: 'تریاژ', departmentInbox: 'صف دپارتمان', myCases: 'پرونده‌های من', needsAttention: 'نیازمند توجه',
};

export function SupportReportsView() {
   const support = useSupportWorkspace();
   const [to, setTo] = useState<string | null>(() => new Date().toISOString());
   const [from, setFrom] = useState<string | null>(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
   const [departmentId, setDepartmentId] = useState('');
   const [report, setReport] = useState<SupportOperationalReport>();
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');

   const load = useCallback(async (query = { from, to, departmentId }) => {
      if (!query.from || !query.to) return;
      setLoading(true);
      setError('');
      try {
         setReport(await supportOperationsClient.getReport({
            from: query.from,
            to: query.to,
            departmentId: query.departmentId || undefined,
         }));
      } catch (caught) {
         setError(caught instanceof Error ? caught.message : 'ساخت گزارش عملیاتی پشتیبانی ناموفق بود.');
      } finally {
         setLoading(false);
      }
   }, [departmentId, from, to]);

   useEffect(() => {
      void load();
      // The initial cohort is intentionally loaded once; later filter changes require Apply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);

   function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!from || !to || new Date(from) >= new Date(to)) {
         setError('شروع بازه باید پیش از پایان آن باشد.');
         return;
      }
      void load();
   }

   return (
      <main dir="rtl" className="min-h-full bg-[#101011] px-4 py-5 text-zinc-200 sm:px-5" data-testid="support-reports-screen">
         <div className="mx-auto max-w-7xl space-y-4">
            <form className="grid gap-3 rounded-xl border border-white/8 bg-[#171719] p-4 sm:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_minmax(220px,1fr)_auto] xl:items-end" onSubmit={submit}>
               <Field label="شروع بازه"><LazyJalaliDatePicker ariaLabel="شروع بازه گزارش" showTime value={from} onChange={setFrom} /></Field>
               <Field label="پایان بازه"><LazyJalaliDatePicker ariaLabel="پایان بازه گزارش" showTime value={to} onChange={setTo} /></Field>
               <Field label="دپارتمان"><select className={selectClass} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">همه محدوده مجاز من</option>{support.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></Field>
               <Button className="bg-zinc-100 text-zinc-950 hover:bg-white" disabled={loading || !from || !to} type="submit">{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}اعمال بازه</Button>
            </form>
            {error ? <InlineError message={error} /> : null}
            {loading && !report ? <LoadingPanel /> : report ? <SupportReportOverview report={report} /> : null}
         </div>
      </main>
   );
}

export function SupportReportOverview({ report }: { report: SupportOperationalReport }) {
   const summaryCards = [
      { label: 'دریافت‌شده در هم‌گروه', value: report.summary.received, detail: `${report.summary.resolved.toLocaleString('fa-IR')} حل‌شده`, icon: Inbox, tone: 'text-indigo-300' },
      { label: 'نرخ اولین پاسخ', value: percent(report.summary.firstResponseRate), detail: `${report.summary.firstResponseSeconds.count.toLocaleString('fa-IR')} پرونده پاسخ‌گرفته`, icon: Activity, tone: 'text-sky-300', formatted: true },
      { label: 'بسته‌شده', value: report.summary.closed, detail: `${report.summary.reopened.toLocaleString('fa-IR')} بازگشایی‌شده`, icon: CheckCircle2, tone: 'text-lime-300' },
      { label: 'انباشت باز', value: report.backlog.open, detail: `میانه سن: ${duration(report.backlog.ageSeconds.p50)}`, icon: AlertTriangle, tone: 'text-amber-300' },
   ];

   return (
      <div className="space-y-4">
         <section className="grid gap-3 rounded-xl border border-indigo-400/15 bg-indigo-400/[0.04] px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center" data-testid="support-report-cohort">
            <div>
               <h2 className="text-sm font-semibold text-indigo-100">تعریف هم‌گروه (Cohort)</h2>
               <p className="mt-1.5 text-sm leading-7 text-indigo-100/65">فقط پرونده‌هایی شمرده می‌شوند که اکنون در محدوده دسترسی شما هستند و زمان دریافتشان از شروع بازه، شامل، تا پایان بازه، غیرشامل، باشد. تغییر دسترسی می‌تواند نتیجه اجرای بعدی را تغییر دهد.</p>
               <p className="mt-1 text-xs leading-6 text-indigo-200/45">{formatJalaliDateTime(report.cohort.from)} تا پیش از {formatJalaliDateTime(report.cohort.to)} · منطقه زمانی گزارش: <bdi dir="ltr">{report.timezone}</bdi></p>
            </div>
            <Badge variant="outline" className="w-fit border-indigo-300/20 bg-indigo-300/5 text-indigo-200">{scopeLabel(report.scope.kind)}</Badge>
         </section>

         <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map(({ icon: Icon, ...card }) => <Card key={card.label} className="border-white/8 bg-[#171719] text-zinc-100"><CardContent className="flex items-start gap-3 p-4"><span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.035]', card.tone)}><Icon className="size-4" /></span><div><p className="text-xs text-zinc-600">{card.label}</p><p className="mt-1 text-2xl font-semibold text-zinc-200">{card.formatted ? card.value : Number(card.value).toLocaleString('fa-IR')}</p><p className="mt-1 text-[11px] leading-5 text-zinc-600">{card.detail}</p></div></CardContent></Card>)}
         </section>

         <section className="grid gap-4 xl:grid-cols-2">
            <Card className="border-white/8 bg-[#171719] text-zinc-100">
               <CardHeader className="border-b border-white/7"><CardTitle className="flex items-center gap-2 text-base"><Clock3 className="size-4 text-sky-300" />زمان پاسخ و حل</CardTitle><CardDescription className="leading-6 text-zinc-500">صدک‌ها فقط از پرونده‌های دارای رویداد مربوط محاسبه می‌شوند.</CardDescription></CardHeader>
               <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
                  <DurationCard label="اولین پاسخ" summary={report.summary.firstResponseSeconds} />
                  <DurationCard label="حل پرونده" summary={report.summary.resolutionSeconds} />
                  <DurationCard label="سن انباشت باز" summary={report.backlog.ageSeconds} />
                  <div className="rounded-xl border border-white/7 bg-black/10 p-4"><p className="text-xs text-zinc-600">نرخ حل هم‌گروه</p><p className="mt-2 text-xl font-medium text-zinc-200">{percent(report.summary.received ? report.summary.resolved / report.summary.received : null)}</p><p className="mt-1 text-[11px] text-zinc-600">حل‌شده تقسیم بر دریافت‌شده</p></div>
               </CardContent>
            </Card>

            <Card className="border-white/8 bg-[#171719] text-zinc-100">
               <CardHeader className="border-b border-white/7"><CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="size-4 text-indigo-300" />صف‌های جاری</CardTitle><CardDescription className="leading-6 text-zinc-500">تصویر لحظه‌ای در همان محدوده دسترسی، نه بخشی از هم‌گروه تاریخی</CardDescription></CardHeader>
               <CardContent className="grid gap-2 p-4 sm:grid-cols-2">{Object.entries(report.queues).map(([key, value]) => <div key={key} className="flex items-center justify-between rounded-lg border border-white/7 bg-black/10 px-3 py-3"><span className="text-xs text-zinc-500">{queueLabels[key] || key}</span><span className="text-lg font-medium text-zinc-200">{value.toLocaleString('fa-IR')}</span></div>)}{!Object.keys(report.queues).length ? <p className="text-sm text-zinc-600">صفی در این محدوده موجود نیست.</p> : null}</CardContent>
            </Card>
         </section>

         <Card className="border-white/8 bg-[#171719] text-zinc-100">
            <CardHeader className="border-b border-white/7"><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4 text-amber-300" />عملکرد SLA</CardTitle><CardDescription className="leading-6 text-zinc-500">نرخ تحقق فقط از ساعت‌های تصمیم‌گرفته‌شده (رعایت‌شده یا نقض‌شده) است.</CardDescription></CardHeader>
            <CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-xs"><thead className="bg-white/[0.025] text-zinc-600"><tr><th className="px-4 py-3 text-right">معیار</th><th className="px-4 py-3">رعایت</th><th className="px-4 py-3">نقض</th><th className="px-4 py-3">فعال</th><th className="px-4 py-3">لغوشده</th><th className="px-4 py-3">نرخ تحقق</th></tr></thead><tbody className="divide-y divide-white/6">{report.sla.map((row) => <tr key={row.metric}><td className="px-4 py-3 text-zinc-300">{metricLabels[row.metric]}</td><NumberCell value={row.met} tone="text-lime-300" /><NumberCell value={row.breached} tone="text-red-300" /><NumberCell value={row.active} /><NumberCell value={row.canceled} /><td className="px-4 py-3 text-center text-zinc-300">{percent(row.attainmentRate)}</td></tr>)}</tbody></table></div>{!report.sla.length ? <p className="px-4 py-10 text-center text-sm text-zinc-600">در این بازه ساعت SLA ثبت نشده است.</p> : null}</CardContent>
         </Card>

         <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <BreakdownCard title="وضعیت" values={report.breakdowns.status} labelFor={(key) => supportStatusLabels[key as keyof typeof supportStatusLabels] || key} />
            <BreakdownCard title="اولویت" values={report.breakdowns.priority} labelFor={(key) => supportPriorityLabels[key as keyof typeof supportPriorityLabels] || key} />
            <BreakdownCard title="کانال ورودی" values={report.breakdowns.sourceChannel} labelFor={(key) => supportSourceLabels[key as keyof typeof supportSourceLabels] || key} />
            <BreakdownCard title="نوع پرونده" values={report.breakdowns.type} />
            <BreakdownCard title="نتیجه حل" values={report.breakdowns.resolutionCode} labelFor={(key) => supportResolutionLabels[key as keyof typeof supportResolutionLabels] || key} />
            <DepartmentBreakdown rows={report.breakdowns.department} />
         </section>

         <section className="rounded-xl border border-lime-400/15 bg-lime-400/[0.035] px-4 py-4" data-testid="support-report-privacy">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-lime-100"><ShieldCheck className="size-4 text-lime-300" />حریم خصوصی اعضای دپارتمان</h2>
            <p className="mt-1.5 text-sm leading-7 text-lime-100/60">این گزارش عمداً هیچ رتبه‌بندی، عملکرد فردی یا مقایسه همکاران ندارد. تمام جمع‌ها با همان محدوده دسترسی پرونده‌ها محاسبه می‌شوند.</p>
            <p className="mt-1 text-[11px] leading-5 text-lime-200/35">تولید: {formatJalaliDateTime(report.generatedAt)}</p>
         </section>
      </div>
   );
}

function DurationCard({ label, summary }: { label: string; summary: SupportDurationSummary }) {
   return <div className="rounded-xl border border-white/7 bg-black/10 p-4"><p className="text-xs text-zinc-600">{label}</p><div className="mt-3 grid grid-cols-2 gap-3"><div><span className="text-[10px] text-zinc-700">میانه (P50)</span><p className="mt-1 text-sm text-zinc-300">{duration(summary.p50)}</p></div><div><span className="text-[10px] text-zinc-700">P90</span><p className="mt-1 text-sm text-zinc-300">{duration(summary.p90)}</p></div></div><p className="mt-3 text-[11px] text-zinc-600">نمونه: {summary.count.toLocaleString('fa-IR')} پرونده</p></div>;
}

function BreakdownCard({ title, values, labelFor = (value) => value }: { title: string; values: Record<string, number>; labelFor?: (value: string) => string }) {
   const total = Object.values(values).reduce((sum, value) => sum + value, 0);
   return <Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader className="pb-3"><CardTitle className="text-sm">{title}</CardTitle></CardHeader><CardContent className="space-y-2">{Object.entries(values).sort(([, left], [, right]) => right - left).map(([key, value]) => <div key={key}><div className="flex items-center justify-between gap-3 text-xs"><span className="truncate text-zinc-500">{labelFor(key)}</span><span className="text-zinc-300">{value.toLocaleString('fa-IR')}</span></div><div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-indigo-400/50" style={{ width: `${total ? Math.max(3, value / total * 100) : 0}%` }} /></div></div>)}{!total ? <p className="py-5 text-center text-xs text-zinc-600">داده‌ای ثبت نشده است.</p> : null}</CardContent></Card>;
}

function DepartmentBreakdown({ rows }: { rows: SupportOperationalReport['breakdowns']['department'] }) {
   const total = rows.reduce((sum, row) => sum + row.count, 0);
   return <Card className="border-white/8 bg-[#171719] text-zinc-100"><CardHeader className="pb-3"><CardTitle className="text-sm">دپارتمان</CardTitle></CardHeader><CardContent className="space-y-2">{[...rows].sort((left, right) => right.count - left.count).map((row) => <div key={row.departmentId || 'UNROUTED'}><div className="flex items-center justify-between gap-3 text-xs"><span className="truncate text-zinc-500">{row.departmentId ? row.name : 'بدون دپارتمان'}</span><span className="text-zinc-300">{row.count.toLocaleString('fa-IR')}</span></div><div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-sky-400/50" style={{ width: `${total ? Math.max(3, row.count / total * 100) : 0}%` }} /></div></div>)}{!rows.length ? <p className="py-5 text-center text-xs text-zinc-600">داده‌ای ثبت نشده است.</p> : null}</CardContent></Card>;
}

function NumberCell({ tone, value }: { tone?: string; value: number }) {
   return <td className={cn('px-4 py-3 text-center text-zinc-400', tone)}>{value.toLocaleString('fa-IR')}</td>;
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
   return <label className="grid gap-1.5 text-xs text-zinc-400"><span>{label}</span>{children}</label>;
}

function percent(value: number | null): string {
   return value === null ? 'داده ناکافی' : new Intl.NumberFormat('fa-IR', { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function duration(seconds: number | null): string {
   if (seconds === null) return 'داده ناکافی';
   if (seconds < 60) return `${Math.round(seconds).toLocaleString('fa-IR')} ثانیه`;
   if (seconds < 3600) return `${Math.round(seconds / 60).toLocaleString('fa-IR')} دقیقه`;
   if (seconds < 86_400) return `${(seconds / 3600).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} ساعت`;
   return `${(seconds / 86_400).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} روز`;
}

function scopeLabel(scope: string): string {
   return ({ WORKSPACE: 'کل فضای مجاز', DEPARTMENT: 'یک دپارتمان', MANAGED_DEPARTMENTS: 'دپارتمان‌های تحت مدیریت', ASSIGNED_CASES: 'پرونده‌های واگذارشده' } as Record<string, string>)[scope] || scope;
}

function LoadingPanel() {
   return <div className="flex min-h-80 items-center justify-center gap-2 rounded-xl border border-white/7 bg-[#171719] text-sm text-zinc-500"><Loader2 className="size-4 animate-spin" />در حال ساخت گزارش محدوده دسترسی شما…</div>;
}

function InlineError({ message }: { message: string }) {
   return <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/8 px-4 py-3 text-sm leading-6 text-red-200">{message}</p>;
}

const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
