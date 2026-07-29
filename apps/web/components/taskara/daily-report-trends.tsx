'use client';

import { useEffect, useState } from 'react';
import { fa } from '@/lib/fa-copy';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraDailyReportTrends } from '@/lib/taskara-types';
import { LinearAvatar, LinearEmptyState, LinearPanel } from './linear-ui';

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

   if (denied || !trends) return null;

   const maxSubmitted = Math.max(1, ...trends.byDay.map((day) => day.expected || day.submitted));

   return (
      <LinearPanel title={fa.dailyReportTrends.title}>
         <div className="flex flex-col gap-4 p-4">
            <p className="text-xs text-white/50">{fa.dailyReportTrends.subtitle}</p>

            <div className="grid gap-3 sm:grid-cols-3">
               <Stat
                  label={fa.dailyReportTrends.participation}
                  value={fa.dailyReportTrends.participationValue(trends.totals.submitted, trends.totals.possible)}
               />
               <Stat
                  label={fa.dailyReportTrends.unplannedShare}
                  value={`${trends.totals.unplannedShare.toLocaleString('fa-IR')}٪`}
               />
               <Stat
                  label={fa.dailyReportTrends.blockerShare}
                  value={`${trends.totals.blockerShare.toLocaleString('fa-IR')}٪`}
               />
            </div>

            {trends.byDay.length ? (
               <div className="flex items-end gap-1" dir="ltr">
                  {trends.byDay.map((day) => (
                     <div key={day.dateKey} className="flex flex-1 flex-col items-center gap-1" title={day.dateKey}>
                        <div className="flex h-16 w-full items-end">
                           <div
                              className="w-full rounded-sm bg-sky-400/40"
                              style={{ height: `${Math.round((day.submitted / maxSubmitted) * 100)}%` }}
                           />
                        </div>
                        <span className="text-[10px] text-white/35">{day.dateKey.slice(8)}</span>
                     </div>
                  ))}
               </div>
            ) : (
               <LinearEmptyState>{fa.dailyReportTrends.empty}</LinearEmptyState>
            )}

            <div className="flex flex-col gap-2">
               <span className="text-xs font-medium text-white/70">{fa.dailyReportTrends.perPerson}</span>
               {trends.byPerson.map((person) => (
                  <div key={person.user.id} className="flex items-center justify-between gap-3 text-xs">
                     <div className="flex items-center gap-2">
                        <LinearAvatar name={person.user.name} src={person.user.avatarUrl} />
                        <span className="text-white/80">{person.user.name}</span>
                     </div>
                     <div className="flex items-center gap-3 text-white/50">
                        <span>{fa.dailyReportTrends.personDays(person.submitted, person.possible)}</span>
                        {person.unplannedDays ? (
                           <span className="text-amber-200/70">
                              {fa.dailyReportTrends.unplannedDays(person.unplannedDays)}
                           </span>
                        ) : null}
                     </div>
                  </div>
               ))}
            </div>
         </div>
      </LinearPanel>
   );
}

function Stat({ label, value }: { label: string; value: string }) {
   return (
      <div className="rounded-lg border border-white/10 bg-[#111113] px-3 py-2">
         <div className="text-[11px] text-white/45">{label}</div>
         <div className="text-sm text-white/90">{value}</div>
      </div>
   );
}
