'use client';

import { useEffect, useMemo, useState } from 'react';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { taskaraRequest } from '@/lib/taskara-client';
import { cn } from '@/lib/utils';
import type { TaskaraDailyReportTrends } from '@/lib/taskara-types';
import { LinearAvatar } from './linear-ui';

// Participation is shown as a rate over a window, never a streak: streak mechanics reliably turn
// into filler reports filed to avoid breaking the chain.
export function DailyReportTrendsPanel({ days = 14 }: { days?: number }) {
   const [trends, setTrends] = useState<TaskaraDailyReportTrends | null>(null);
   const [denied, setDenied] = useState(false);

   useEffect(() => {
      let cancelled = false;
      taskaraRequest<TaskaraDailyReportTrends>(`/check-ins/trends?days=${days}`)
         .then((data) => {
            if (!cancelled) setTrends(data);
         })
         .catch(() => {
            if (!cancelled) setDenied(true);
         });
      return () => {
         cancelled = true;
      };
   }, [days]);

   // Bars are read against the number of people expected that day, so a full day is a full bar
   // whatever the team's size — and a weekend is not a hole in the chart.
   const peak = useMemo(
      () => Math.max(1, ...(trends?.byDay ?? []).map((day) => Math.max(day.expected, day.submitted))),
      [trends]
   );

   if (denied || !trends) return null;

   const { totals } = trends;
   const participation = totals.possible ? Math.round((totals.submitted / totals.possible) * 100) : 0;

   return (
      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-white/8 dark:bg-[#161618]">
         <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-white/7">
            <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
               {fa.dailyReportTrends.title}
            </span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
               {fa.dailyReportTrends.windowLabel(trends.workdays)}
            </span>
         </div>

         <div className="grid gap-px bg-zinc-200 sm:grid-cols-3 dark:bg-white/7">
            <Metric
               label={fa.dailyReportTrends.participation}
               value={`${participation.toLocaleString('fa-IR')}٪`}
               detail={fa.dailyReportTrends.participationValueShort(totals.submitted, totals.possible)}
            />
            <Metric
               label={fa.dailyReportTrends.unplannedShare}
               value={`${totals.unplannedShare.toLocaleString('fa-IR')}٪`}
            />
            <Metric
               label={fa.dailyReportTrends.blockerShare}
               value={`${totals.blockerShare.toLocaleString('fa-IR')}٪`}
            />
         </div>

         {trends.byDay.length ? (
            <div className="border-t border-zinc-200 px-4 py-4 dark:border-white/7">
               <div className="flex items-end gap-1.5">
                  {trends.byDay.map((day) => (
                     <DayBar key={day.dateKey} day={day} peak={peak} />
                  ))}
               </div>
            </div>
         ) : (
            <div className="border-t border-zinc-200 px-4 py-6 text-center text-[13px] text-zinc-500 dark:border-white/7 dark:text-zinc-400">
               {fa.dailyReportTrends.empty}
            </div>
         )}

         <div className="divide-y divide-zinc-200 border-t border-zinc-200 dark:divide-white/7 dark:border-white/7">
            <div className="px-4 py-2.5 text-[11px] text-zinc-400 dark:text-zinc-500">
               {fa.dailyReportTrends.perPerson}
            </div>
            {trends.byPerson.map((person) => {
               const ratio = person.possible ? person.submitted / person.possible : 0;
               return (
                  <div key={person.user.id} className="flex items-center gap-3 px-4 py-2.5">
                     <LinearAvatar name={person.user.name} src={person.user.avatarUrl} className="size-5 text-[9px]" />
                     <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-800 dark:text-zinc-200">
                        {person.user.name}
                     </span>
                     {person.unplannedDays ? (
                        <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300/80">
                           {fa.dailyReportTrends.unplannedDays(person.unplannedDays)}
                        </span>
                     ) : null}
                     {/* A rate, not a streak: the bar shows how much of the window they covered. */}
                     <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/8">
                        <div
                           className="h-full rounded-full bg-sky-500/70 dark:bg-sky-400/60"
                           style={{ width: `${Math.round(ratio * 100)}%` }}
                        />
                     </div>
                     <span className="w-12 shrink-0 text-end text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                        {fa.dailyReportTrends.participationValueShort(person.submitted, person.possible)}
                     </span>
                  </div>
               );
            })}
         </div>
      </section>
   );
}

function DayBar({ day, peak }: { day: TaskaraDailyReportTrends['byDay'][number]; peak: number }) {
   const label = formatJalaliDate(`${day.dateKey}T12:00:00.000Z`);
   const height = Math.round((day.submitted / peak) * 100);
   const title = day.workday
      ? `${label} — ${fa.dailyReportTrends.participationValueShort(day.submitted, day.expected)}`
      : `${label} — ${fa.dailyReportTrends.weekend}`;

   return (
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1" title={title}>
         <div className="relative flex h-14 w-full items-end">
            {/* The full-height track is the day's expectation, so a short bar reads as a shortfall
                rather than just a small number. */}
            <div
               className={cn(
                  'absolute inset-0 rounded-[3px]',
                  day.workday ? 'bg-zinc-100 dark:bg-white/[0.04]' : 'bg-transparent'
               )}
            />
            {day.submitted ? (
               <div
                  className={cn(
                     'relative w-full rounded-[3px]',
                     day.workday ? 'bg-sky-500/70 dark:bg-sky-400/60' : 'bg-zinc-300 dark:bg-white/15'
                  )}
                  style={{ height: `${Math.max(height, 6)}%` }}
               />
            ) : null}
         </div>
         <span
            className={cn(
               'w-full truncate text-center text-[9px]',
               day.workday ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-300 dark:text-zinc-600'
            )}
         >
            {label.split(' ')[0]}
         </span>
      </div>
   );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
   return (
      <div className="bg-white px-4 py-3 dark:bg-[#161618]">
         <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
         <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-lg font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
            {detail ? (
               <span className="text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">{detail}</span>
            ) : null}
         </div>
      </div>
   );
}
