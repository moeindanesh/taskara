'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { useLiveRefresh } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   TaskaraCheckInResponse,
   TaskaraDailyReportDigest,
   TaskaraDailyReportDigestPerson,
} from '@/lib/taskara-types';
import { LinearAvatar, LinearEmptyState, LinearPanel } from './linear-ui';

// The digest is the manager's morning artifact: one screen, blockers first, then the day's
// unexpected work, then everyone's report, then who still owes one.
export function DailyReportsDigestView() {
   const [dateKey, setDateKey] = useState<string>(() => defaultDigestDay());
   const [digest, setDigest] = useState<TaskaraDailyReportDigest | null>(null);
   const [loading, setLoading] = useState(true);
   const [requested, setRequested] = useState<Record<string, boolean>>({});

   const load = useCallback(async () => {
      setLoading(true);
      try {
         const data = await taskaraRequest<TaskaraDailyReportDigest>(`/check-ins/digest?dateKey=${dateKey}`);
         setDigest(data);
      } catch {
         toast.error(fa.dailyReport.loadFailed);
      } finally {
         setLoading(false);
      }
   }, [dateKey]);

   useEffect(() => {
      void load();
   }, [load]);

   useLiveRefresh(() => {
      void load();
   });

   const requestReport = useCallback(async (userId: string) => {
      try {
         await taskaraRequest('/check-ins/request', {
            method: 'POST',
            body: JSON.stringify({ userId }),
         });
         setRequested((current) => ({ ...current, [userId]: true }));
         toast.success(fa.dailyReportsDigest.requested);
      } catch {
         toast.error(fa.dailyReport.submitFailed);
      }
   }, []);

   const dayLabel = useMemo(() => formatJalaliDate(`${dateKey}T12:00:00.000Z`), [dateKey]);
   const stats = digest?.stats;

   return (
      <div className="flex w-full flex-col gap-5 p-6">
         {/* PageHeader already names the screen; this row only carries the day and its controls. */}
         <header className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{dayLabel}</span>
            <div className="flex items-center gap-2">
               <Button type="button" variant="ghost" size="sm" onClick={() => setDateKey(shiftDay(dateKey, -1))}>
                  {fa.dailyReportsDigest.previousDay}
               </Button>
               <Button type="button" variant="ghost" size="sm" onClick={() => setDateKey(todayKey())}>
                  {fa.dailyReportsDigest.today}
               </Button>
               <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={dateKey >= todayKey()}
                  onClick={() => setDateKey(shiftDay(dateKey, 1))}
               >
                  {fa.dailyReportsDigest.nextDay}
               </Button>
            </div>
         </header>

         {stats ? (
            <div className="flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
               <span className="rounded-full border border-zinc-200 dark:border-white/8 bg-zinc-100 dark:bg-white/5 px-3 py-1">
                  {fa.dailyReportsDigest.submittedStat(stats.submitted, stats.expected)}
               </span>
               <span className="rounded-full border border-zinc-200 dark:border-white/8 bg-zinc-100 dark:bg-white/5 px-3 py-1">
                  {fa.dailyReportsDigest.blockerStat(stats.blockerCount)}
               </span>
               <span className="rounded-full border border-zinc-200 dark:border-white/8 bg-zinc-100 dark:bg-white/5 px-3 py-1">
                  {fa.dailyReportsDigest.unplannedStat(stats.unplannedShare)}
               </span>
            </div>
         ) : null}

         <AiSummaryPanel dateKey={dateKey} hasReports={Boolean(digest?.reports.length)} />

         <LinearPanel title={fa.dailyReportsDigest.blockersTitle}>
            <p className="border-b border-zinc-200 dark:border-white/7 px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
               {fa.dailyReportsDigest.blockersHint}
            </p>
            {digest?.blockersFirst.length ? (
               <div className="flex flex-col gap-3 p-4">
                  {digest.blockersFirst.map((report) => (
                     <article key={report.id} className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
                        <PersonLine user={report.user} />
                        {report.blockersText ? (
                           <ReportField label={fa.dailyReportsDigest.blockersSection} value={report.blockersText} />
                        ) : null}
                        {report.helpText ? (
                           <ReportField label={fa.dailyReportsDigest.helpSection} value={report.helpText} />
                        ) : null}
                     </article>
                  ))}
               </div>
            ) : (
               <LinearEmptyState>{fa.dailyReportsDigest.noBlockers}</LinearEmptyState>
            )}
         </LinearPanel>

         <LinearPanel title={fa.dailyReportsDigest.unplannedTitle}>
            {digest?.unplanned.length ? (
               <div className="flex flex-col gap-3 p-4">
                  {digest.unplanned.map((report) => (
                     <article key={report.id} className="rounded-lg border border-zinc-200 dark:border-white/8 bg-white dark:bg-[#161618] p-3">
                        <PersonLine user={report.user} />
                        <ReportField label={fa.dailyReportsDigest.unplannedSection} value={report.unplannedText || ''} />
                     </article>
                  ))}
               </div>
            ) : (
               <LinearEmptyState>{fa.dailyReportsDigest.noUnplanned}</LinearEmptyState>
            )}
         </LinearPanel>

         <LinearPanel title={fa.dailyReportsDigest.reportsTitle}>
            {loading && !digest ? null : digest?.reports.length ? (
               <div className="flex flex-col gap-3 p-4">
                  {digest.reports.map((report) => (
                     <ReportCard key={report.id} report={report} />
                  ))}
               </div>
            ) : (
               <LinearEmptyState>{fa.dailyReportsDigest.noReports}</LinearEmptyState>
            )}
         </LinearPanel>

         {digest?.planVsDone.length ? (
            <LinearPanel title={fa.dailyReportsDigest.planVsDoneTitle}>
               <div className="flex flex-col gap-3 p-4">
                  {digest.planVsDone.map((entry) => (
                     <article key={entry.userId} className="rounded-lg border border-zinc-200 dark:border-white/8 bg-white dark:bg-[#161618] p-3">
                        <PersonLine user={entry.user} />
                        <div className="mt-2 grid gap-3 sm:grid-cols-2">
                           <ReportField
                              label={fa.dailyReportsDigest.plannedYesterday}
                              value={entry.plannedYesterday || '—'}
                           />
                           <ReportField
                              label={fa.dailyReportsDigest.completedToday}
                              value={entry.completedToday || '—'}
                           />
                        </div>
                        {entry.tasks.length ? (
                           <div className="mt-2 flex flex-wrap gap-1.5">
                              {entry.tasks.map((task) => (
                                 <span
                                    key={task.key}
                                    className={
                                       task.status === 'done'
                                          ? 'rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-200'
                                          : 'rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-200'
                                    }
                                 >
                                    {task.key} ·{' '}
                                    {task.status === 'done'
                                       ? fa.dailyReportsDigest.taskDone
                                       : fa.dailyReportsDigest.taskSlipped}
                                 </span>
                              ))}
                           </div>
                        ) : null}
                     </article>
                  ))}
               </div>
            </LinearPanel>
         ) : null}

         <LinearPanel title={fa.dailyReportsDigest.missingTitle}>
            {digest?.missing.length ? (
               <div className="flex flex-col gap-2 p-4">
                  {digest.missing.map((person) => (
                     <div
                        key={person.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-white/8 bg-white dark:bg-[#161618] px-3 py-2"
                     >
                        <PersonLine user={person} />
                        <Button
                           type="button"
                           variant="ghost"
                           size="sm"
                           disabled={requested[person.id]}
                           onClick={() => void requestReport(person.id)}
                        >
                           {requested[person.id] ? fa.dailyReportsDigest.requested : fa.dailyReportsDigest.requestReport}
                        </Button>
                     </div>
                  ))}
               </div>
            ) : (
               <LinearEmptyState>{fa.dailyReportsDigest.noMissing}</LinearEmptyState>
            )}
         </LinearPanel>
      </div>
   );
}

// Opt-in, and never on the critical path: the raw reports render whether or not this succeeds.
function AiSummaryPanel({ dateKey, hasReports }: { dateKey: string; hasReports: boolean }) {
   const [summary, setSummary] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);

   useEffect(() => {
      setSummary(null);
   }, [dateKey]);

   if (!hasReports) return null;

   const generate = async () => {
      setBusy(true);
      try {
         const result = await taskaraRequest<{ summary: string | null }>('/check-ins/digest/summary', {
            method: 'POST',
            body: JSON.stringify({ dateKey }),
         });
         setSummary(result.summary);
      } catch {
         toast.error(fa.dailyReportsDigest.aiSummaryFailed);
      } finally {
         setBusy(false);
      }
   };

   return (
      <LinearPanel title={fa.dailyReportsDigest.aiSummaryTitle}>
         <div className="flex flex-col gap-2 p-4">
            {summary ? (
               <>
                  <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{summary}</p>
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{fa.dailyReportsDigest.aiSummaryLabel}</span>
               </>
            ) : (
               <Button type="button" variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => void generate()}>
                  {busy ? fa.dailyReportsDigest.aiSummaryGenerating : fa.dailyReportsDigest.aiSummaryGenerate}
               </Button>
            )}
         </div>
      </LinearPanel>
   );
}

function ReportCard({ report }: { report: TaskaraCheckInResponse }) {
   return (
      <article className="rounded-lg border border-zinc-200 dark:border-white/8 bg-white dark:bg-[#161618] p-3">
         <div className="flex items-center justify-between gap-3">
            <PersonLine user={report.user} />
            {report.author && report.authorId !== report.userId ? (
               <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{fa.dailyReportsDigest.byAuthor(report.author.name)}</span>
            ) : null}
         </div>
         <div className="mt-2 flex flex-col gap-2">
            {report.completedText ? (
               <ReportField label={fa.dailyReportsDigest.completedSection} value={report.completedText} />
            ) : null}
            {report.unplannedText ? (
               <ReportField label={fa.dailyReportsDigest.unplannedSection} value={report.unplannedText} />
            ) : null}
            {report.planText ? (
               <ReportField label={fa.dailyReportsDigest.planSection} value={report.planText} />
            ) : null}
         </div>
      </article>
   );
}

function ReportField({ label, value }: { label: string; value: string }) {
   return (
      <div className="flex flex-col gap-0.5">
         <span className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</span>
         <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{linkifyTaskKeys(value)}</p>
      </div>
   );
}

function PersonLine({ user }: { user?: TaskaraDailyReportDigestPerson | null }) {
   if (!user) return null;
   return (
      <div className="flex items-center gap-2">
         <LinearAvatar name={user.name} src={user.avatarUrl} />
         <span className="text-sm text-zinc-800 dark:text-zinc-200">{user.name}</span>
      </div>
   );
}

const taskKeyPattern = /\b[A-Z][A-Z0-9]*-\d+\b/g;

// Task keys typed into a report become links to the issue, so the digest stays one click from work.
function linkifyTaskKeys(value: string) {
   const parts: Array<string | { key: string }> = [];
   let lastIndex = 0;
   for (const match of value.matchAll(taskKeyPattern)) {
      const index = match.index ?? 0;
      if (index > lastIndex) parts.push(value.slice(lastIndex, index));
      parts.push({ key: match[0] });
      lastIndex = index + match[0].length;
   }
   if (lastIndex < value.length) parts.push(value.slice(lastIndex));

   return parts.map((part, index) =>
      typeof part === 'string' ? (
         <span key={index}>{part}</span>
      ) : (
         <Link key={index} to={`../issue/${part.key}`} relative="path" className="text-sky-600 dark:text-sky-300 hover:underline">
            {part.key}
         </Link>
      )
   );
}

function todayKey(): string {
   return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
}

function shiftDay(dateKey: string, days: number): string {
   const [year, month, day] = dateKey.split('-').map(Number);
   const shifted = new Date(Date.UTC(year, month - 1, day + days));
   return shifted.toISOString().slice(0, 10);
}

// Managers read the digest in the morning, when the reports that matter are yesterday's.
function defaultDigestDay(): string {
   const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', hour: '2-digit', hour12: false }).format(new Date())
   ) % 24;
   const today = todayKey();
   return hour < 10 ? shiftDay(today, -1) : today;
}
