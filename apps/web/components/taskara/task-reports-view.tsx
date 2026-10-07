'use client';

import { useMemo, useRef, useState } from 'react';
import { Bot, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { formatJalaliDateTime } from '@/lib/jalali';
import { taskaraRequest } from '@/lib/taskara-client';
import { cn } from '@/lib/utils';

type ReportResponse = {
   period: {
      startsAt: string;
      endsAt: string;
   };
   summary: {
      totalTasks: number;
      doneTasks: number;
      blockedTasks: number;
      overdueOpenTasks: number;
      completionRate: number;
      statusCounts: Record<string, number>;
      priorityCounts: Record<string, number>;
      topAssignees: Array<{ name: string; total: number; done: number }>;
   };
   report: string;
   sampleSize: number;
   totalMatchedTasks: number;
   appliedFilters?: {
      request: string;
      teamSlug: string | null;
      teamName: string | null;
      assigneeHint: string | null;
      reporterHint: string | null;
      statuses: string[];
      priorities: string[];
      keywords: string[];
      guidance: string | null;
   };
   resolvedQuery?: {
      request: string;
      startsAt: string;
      endsAt: string;
      teamSlug: string | null;
      statuses: string[];
      priorities: string[];
      keywords: string[];
   };
   ai: {
      provider: 'OPENROUTER';
      model: string;
   };
};

const inputClassName =
   'border-white/10 bg-[#111113] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/25';

export function TaskReportsView() {
   const [requestText, setRequestText] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');
   const [reportResult, setReportResult] = useState<ReportResponse | null>(null);
   const reportRequestRef = useRef(0);

   const canSubmit = useMemo(() => requestText.trim().length >= 3, [requestText]);

   async function handleGenerateReport() {
      const requestId = ++reportRequestRef.current;
      setError('');
      setReportResult(null);

      if (!canSubmit) {
         setError('متن درخواست را کامل وارد کنید.');
         return;
      }

      setSubmitting(true);
      try {
         const result = await taskaraRequest<ReportResponse>('/reports/tasks/analyze', {
            method: 'POST',
            body: JSON.stringify({ request: requestText.trim() }),
         });
         if (requestId === reportRequestRef.current) setReportResult(result);
      } catch (err) {
         if (requestId === reportRequestRef.current) {
            setError(err instanceof Error ? err.message : 'گزارش‌گیری ناموفق بود.');
         }
      } finally {
         if (requestId === reportRequestRef.current) setSubmitting(false);
      }
   }

   return (
      <div className="mx-auto w-full max-w-[1100px] space-y-5 px-6 py-6">
         <Card className="border-white/8 bg-[#19191b] text-zinc-100">
            <CardHeader className="border-b border-white/7">
               <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="size-4 text-indigo-700 dark:text-indigo-300" />
                  تحلیل داده تسک‌ها با AI
               </CardTitle>
               <CardDescription className="text-zinc-500">
                  فقط درخواستت را بنویس. بقیه تشخیص فیلتر، واکشی دیتا و تحلیل در بک‌اند انجام می‌شود.
               </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
               <label className="grid gap-2 text-sm text-zinc-300">
                  <span>پارام تحلیل</span>
                  <Textarea
                     className={cn(inputClassName, 'min-h-32')}
                     placeholder="مثال: عملکرد تسک های سارامحمدی در ۳۰ روز اخیر را بررسی کن، فقط تسک های BLOCKED و DONE را مقایسه کن و پیشنهاد اقدام بده."
                     value={requestText}
                     onChange={(event) => setRequestText(event.target.value)}
                  />
               </label>

               {error ? (
                  <div className="rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
                     {error}
                  </div>
               ) : null}

               <div className="flex justify-end">
                  <Button
                     className="h-9 border border-white/10 bg-zinc-100 px-4 text-zinc-950 hover:bg-white"
                     disabled={!canSubmit || submitting}
                     type="button"
                     onClick={() => void handleGenerateReport()}
                  >
                     {submitting ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
                     تهیه گزارش
                  </Button>
               </div>
            </CardContent>
         </Card>

         {reportResult ? (
            <Card className="border-white/8 bg-[#19191b] text-zinc-100">
               <CardHeader className="border-b border-white/7">
                  <CardTitle className="text-base">خروجی گزارش</CardTitle>
                  <CardDescription className="text-zinc-500">
                     {`${formatJalaliDateTime(reportResult.period.startsAt)} تا ${formatJalaliDateTime(reportResult.period.endsAt)}`}
                     {' • '}
                     {reportResult.ai.provider} - {reportResult.ai.model}
                  </CardDescription>
               </CardHeader>
               <CardContent className="space-y-4 p-4">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                     <StatItem label="کل تسک" value={reportResult.summary.totalTasks} />
                     <StatItem label="انجام‌شده" value={reportResult.summary.doneTasks} />
                     <StatItem label="مسدود" value={reportResult.summary.blockedTasks} />
                     <StatItem label="دیرکرد باز" value={reportResult.summary.overdueOpenTasks} />
                  </div>

                  <ResolvedQueryView reportResult={reportResult} />

                  <div className="grid gap-3 lg:grid-cols-2">
                     <CountsChart
                        title="نمودار وضعیت تسک‌ها"
                        data={toCountEntries(reportResult.summary.statusCounts)}
                     />
                     <CountsChart
                        title="نمودار اولویت تسک‌ها"
                        data={toCountEntries(reportResult.summary.priorityCounts)}
                     />
                  </div>

                  <div className="rounded-lg border border-white/8 bg-black/20 p-4">
                     <pre className="whitespace-pre-wrap text-sm leading-7 text-zinc-200">{reportResult.report}</pre>
                  </div>

                  <div className="text-xs text-zinc-500">
                     {`تعداد تسک‌های بررسی‌شده: ${reportResult.totalMatchedTasks.toLocaleString('fa-IR')} | نمونه ارسالی به AI: ${reportResult.sampleSize.toLocaleString('fa-IR')}`}
                  </div>
               </CardContent>
            </Card>
         ) : null}
      </div>
   );
}

function ResolvedQueryView({ reportResult }: { reportResult: ReportResponse }) {
   const applied = reportResult.appliedFilters;
   const resolved = reportResult.resolvedQuery;

   if (!applied && !resolved) return null;

   return (
      <div className="rounded-md border border-indigo-300/25 bg-indigo-400/10 px-3 py-3 text-sm text-indigo-700 dark:text-indigo-100">
         <div className="font-medium">برداشت بک‌اند از پارام شما</div>
         <div className="mt-2 space-y-1 text-indigo-700 dark:text-indigo-100/90">
            {resolved ? <div>{`بازه: ${formatJalaliDateTime(resolved.startsAt)} تا ${formatJalaliDateTime(resolved.endsAt)}`}</div> : null}
            <div>{`تیم: ${applied?.teamName ? `${applied.teamName}${applied.teamSlug ? ` (${applied.teamSlug})` : ''}` : 'همه تیم‌ها'}`}</div>
            {applied?.assigneeHint ? <div>{`مسئول: ${applied.assigneeHint}`}</div> : null}
            {applied?.reporterHint ? <div>{`گزارش‌دهنده: ${applied.reporterHint}`}</div> : null}
            {applied?.statuses?.length ? <div>{`وضعیت‌ها: ${applied.statuses.join('، ')}`}</div> : null}
            {applied?.priorities?.length ? <div>{`اولویت‌ها: ${applied.priorities.join('، ')}`}</div> : null}
            {applied?.keywords?.length ? <div>{`کلیدواژه‌ها: ${applied.keywords.join('، ')}`}</div> : null}
         </div>
      </div>
   );
}

function StatItem({ label, value }: { label: string; value: number }) {
   return (
      <div className="rounded-md border border-white/8 bg-black/20 px-3 py-3">
         <div className="text-xs text-zinc-500">{label}</div>
         <div className="mt-1 text-lg font-semibold text-zinc-100">{value.toLocaleString('fa-IR')}</div>
      </div>
   );
}

function CountsChart({
   title,
   data,
}: {
   title: string;
   data: Array<{ key: string; value: number }>;
}) {
   const maxValue = data.reduce((acc, item) => Math.max(acc, item.value), 0);

   return (
      <div className="rounded-lg border border-white/8 bg-black/20 p-3">
         <div className="mb-3 text-sm font-medium text-zinc-200">{title}</div>
         <div className="space-y-2">
            {data.length === 0 ? (
               <div className="text-xs text-zinc-500">داده‌ای برای نمودار وجود ندارد.</div>
            ) : (
               data.map((item) => {
                  const width = maxValue > 0 ? Math.max((item.value / maxValue) * 100, 4) : 0;
                  return (
                     <div key={item.key} className="space-y-1">
                        <div className="flex items-center justify-between text-xs text-zinc-400">
                           <span>{item.key}</span>
                           <span>{item.value.toLocaleString('fa-IR')}</span>
                        </div>
                        <div className="h-2 rounded-full bg-white/8">
                           <div className="h-2 rounded-full bg-indigo-300/80" style={{ width: `${width}%` }} />
                        </div>
                     </div>
                  );
               })
            )}
         </div>
      </div>
   );
}

function toCountEntries(input: Record<string, number>): Array<{ key: string; value: number }> {
   return Object.entries(input)
      .filter(([, value]) => typeof value === 'number' && value > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => ({ key, value }));
}
