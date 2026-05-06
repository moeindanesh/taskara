'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, Sparkles } from 'lucide-react';
import { JalaliDatePicker } from '@/components/taskara/jalali-date-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { formatJalaliDateTime } from '@/lib/jalali';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraTeam } from '@/lib/taskara-types';
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
   ai: {
      provider: 'OPENROUTER';
      model: string;
   };
};

const inputClassName =
   'border-white/10 bg-[#111113] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/25';

export function TaskReportsView() {
   const [teams, setTeams] = useState<TaskaraTeam[]>([]);
   const [teamId, setTeamId] = useState('all');
   const [startsAt, setStartsAt] = useState<string | null>(null);
   const [endsAt, setEndsAt] = useState<string | null>(null);
   const [guidance, setGuidance] = useState('');
   const [loadingTeams, setLoadingTeams] = useState(true);
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');
   const [reportResult, setReportResult] = useState<ReportResponse | null>(null);

   useEffect(() => {
      let cancelled = false;

      void (async () => {
         setLoadingTeams(true);
         setError('');
         try {
            const result = await taskaraRequest<TaskaraTeam[]>('/teams');
            if (!cancelled) setTeams(result);
         } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : 'بارگذاری تیم‌ها ناموفق بود.');
         } finally {
            if (!cancelled) setLoadingTeams(false);
         }
      })();

      return () => {
         cancelled = true;
      };
   }, []);

   const canSubmit = useMemo(() => Boolean(startsAt && endsAt), [endsAt, startsAt]);

   async function handleGenerateReport() {
      setError('');
      setReportResult(null);

      if (!canSubmit) {
         setError('فیلتر گزارش را کامل کنید.');
         return;
      }

      const startDate = startsAt ? new Date(startsAt) : null;
      const endDate = endsAt ? new Date(endsAt) : null;
      if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate >= endDate) {
         setError('بازه تاریخ معتبر نیست.');
         return;
      }

      setSubmitting(true);
      try {
         const payload = {
            teamId,
            guidance: guidance.trim() || undefined,
            startsAt: startsAt || undefined,
            endsAt: endsAt || undefined,
         };

         const result = await taskaraRequest<ReportResponse>('/reports/tasks/analyze', {
            method: 'POST',
            body: JSON.stringify(payload),
         });
         setReportResult(result);
      } catch (err) {
         setError(err instanceof Error ? err.message : 'گزارش‌گیری ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <div className="mx-auto w-full max-w-[1100px] space-y-5 px-6 py-6">
         <Card className="border-white/8 bg-[#19191b] text-zinc-100">
            <CardHeader className="border-b border-white/7">
               <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="size-4 text-indigo-300" />
                  تحلیل داده تسک‌ها با AI
               </CardTitle>
               <CardDescription className="text-zinc-500">
                  بازه زمانی را انتخاب کن، دستور تحلیل اختیاری بده، و گزارش مدیریتی تحویل بگیر.
               </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
               <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-2 text-sm text-zinc-300">
                     <span>تیم</span>
                     <select
                        className={cn(inputClassName, 'h-9 rounded-md px-3 text-sm')}
                        disabled={loadingTeams || submitting}
                        value={teamId}
                        onChange={(event) => setTeamId(event.target.value)}
                     >
                        <option value="all">همه تیم‌ها</option>
                        {teams.map((team) => (
                           <option key={team.id} value={team.slug}>
                              {team.name}
                           </option>
                        ))}
                     </select>
                  </label>

                  <div />
               </div>

               <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-2 text-sm text-zinc-300">
                     <span>از تاریخ</span>
                     <JalaliDatePicker
                        ariaLabel="از تاریخ"
                        value={startsAt}
                        onChange={setStartsAt}
                     />
                  </label>
                  <label className="grid gap-2 text-sm text-zinc-300">
                     <span>تا تاریخ</span>
                     <JalaliDatePicker
                        ariaLabel="تا تاریخ"
                        value={endsAt}
                        onChange={setEndsAt}
                     />
                  </label>
               </div>

               <label className="grid gap-2 text-sm text-zinc-300">
                  <span>راهنمای تحلیل (اختیاری)</span>
                  <Textarea
                     className={cn(inputClassName, 'min-h-28')}
                     placeholder="مثال: روی ریسک تاخیر، گلوگاه‌های تیم، و پیشنهاد اقدام کوتاه‌مدت تمرکز کن."
                     value={guidance}
                     onChange={(event) => setGuidance(event.target.value)}
                  />
               </label>

               {error ? (
                  <div className="rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">
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

function StatItem({ label, value }: { label: string; value: number }) {
   return (
      <div className="rounded-md border border-white/8 bg-black/20 px-3 py-3">
         <div className="text-xs text-zinc-500">{label}</div>
         <div className="mt-1 text-lg font-semibold text-zinc-100">{value.toLocaleString('fa-IR')}</div>
      </div>
   );
}
