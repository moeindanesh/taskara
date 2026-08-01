'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { useLiveRefresh } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import { cn } from '@/lib/utils';
import type {
   TaskaraCheckInResponse,
   TaskaraDailyReportDigest,
   TaskaraDailyReportDigestPerson,
} from '@/lib/taskara-types';
import { LinearAvatar } from './linear-ui';

// The manager's morning artifact. Blockers lead because they are the only part that needs an answer
// today; everything else is one row per person, so nobody is read four times over.
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
   const isToday = dateKey >= todayKey();

   // Yesterday's plan belongs with the person who wrote it, not in a table of its own.
   const planByUser = useMemo(() => {
      const map = new Map<string, TaskaraDailyReportDigest['planVsDone'][number]>();
      for (const entry of digest?.planVsDone ?? []) map.set(entry.userId, entry);
      return map;
   }, [digest]);

   return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-zinc-900 dark:bg-[#101011] dark:text-zinc-100">
         <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
            {/* PageHeader already names the screen; this row carries the day and its controls. */}
            <header className="flex flex-wrap items-center justify-between gap-3">
               <div className="flex items-baseline gap-3">
                  <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{dayLabel}</span>
                  {/* On a weekend the day has no denominator, so the ratio would read "۰ از ۰" —
                      a perfect score rendered as total failure. The reports below still list
                      whatever was filed anyway. */}
                  {digest && !digest.workday ? (
                     <span className="text-[13px] text-zinc-500 dark:text-zinc-400">
                        {fa.dailyReportsDigest.weekend}
                     </span>
                  ) : stats ? (
                     <span className="text-[13px] text-zinc-900 dark:text-zinc-100">
                        {fa.dailyReportsDigest.submittedStat(stats.submitted, stats.expected)}
                     </span>
                  ) : null}
               </div>
               <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 p-0.5 dark:border-white/8">
                  <IconStep label={fa.dailyReportsDigest.previousDay} onClick={() => setDateKey(shiftDay(dateKey, -1))}>
                     <ChevronRight className="size-4" />
                  </IconStep>
                  <button
                     type="button"
                     onClick={() => setDateKey(todayKey())}
                     className="rounded-md px-2.5 py-1 text-[12px] text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-100"
                  >
                     {fa.dailyReportsDigest.today}
                  </button>
                  <IconStep
                     label={fa.dailyReportsDigest.nextDay}
                     disabled={isToday}
                     onClick={() => setDateKey(shiftDay(dateKey, 1))}
                  >
                     <ChevronLeft className="size-4" />
                  </IconStep>
               </div>
            </header>

            {/* Blockers stand alone: this is the one section that is a to-do list, not a record. */}
            {digest?.blockersFirst.length ? (
               <section className="overflow-hidden rounded-xl border border-amber-500/25 bg-amber-50/60 dark:border-amber-400/20 dark:bg-amber-400/[0.04]">
                  <div className="border-b border-amber-500/20 px-5 py-3 dark:border-amber-400/15">
                     <div className="text-[13px] font-medium text-amber-900 dark:text-amber-200">
                        {fa.dailyReportsDigest.blockersTitle}
                     </div>
                     <p className="mt-0.5 text-[11px] leading-5 text-amber-800/70 dark:text-amber-200/60">
                        {fa.dailyReportsDigest.blockersHint}
                     </p>
                  </div>
                  <div className="divide-y divide-amber-500/15 dark:divide-amber-400/10">
                     {digest.blockersFirst.map((report) => (
                        <div key={report.id} className="px-5 py-3.5">
                           <PersonLine user={report.user} />
                           <div className="mt-1.5 flex flex-col gap-1.5 ps-7">
                              {report.blockersText ? (
                                 <Field label={fa.dailyReportsDigest.blockersSection} value={report.blockersText} />
                              ) : null}
                              {report.helpText ? (
                                 <Field label={fa.dailyReportsDigest.helpSection} value={report.helpText} />
                              ) : null}
                           </div>
                        </div>
                     ))}
                  </div>
               </section>
            ) : null}

            <AiSummaryStrip dateKey={dateKey} hasReports={Boolean(digest?.reports.length)} />

            <div className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:divide-white/7 dark:border-white/8 dark:bg-[#161618]">
               {/* The blocker count is not repeated here: the section above lists them in full, so
                   the meta slot carries the one figure nothing else on the page shows. */}
               <SectionHeader
                  title={fa.dailyReportsDigest.reportsTitle}
                  count={digest?.reports.length}
                  meta={stats ? fa.dailyReportsDigest.unplannedStat(stats.unplannedShare) : undefined}
               />

               {loading && !digest ? (
                  <EmptyLine>{'…'}</EmptyLine>
               ) : digest?.reports.length ? (
                  digest.reports.map((report) => (
                     <ReportRow key={report.id} report={report} plan={planByUser.get(report.userId)} />
                  ))
               ) : (
                  <EmptyLine>{fa.dailyReportsDigest.noReports}</EmptyLine>
               )}

               {digest ? (
                  <div className="px-5 py-3.5">
                     <div className="mb-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                        {fa.dailyReportsDigest.missingTitle}
                     </div>
                     {digest.missing.length ? (
                        <div className="flex flex-wrap gap-1.5">
                           {digest.missing.map((person) => (
                              <button
                                 key={person.id}
                                 type="button"
                                 disabled={requested[person.id]}
                                 onClick={() => void requestReport(person.id)}
                                 title={requested[person.id] ? fa.dailyReportsDigest.requested : fa.dailyReportsDigest.requestReport}
                                 className={cn(
                                    'inline-flex items-center gap-1.5 rounded-full border py-1 pe-2.5 ps-1 text-[11px] transition',
                                    requested[person.id]
                                       ? 'cursor-default border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                       : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 dark:border-white/10 dark:text-zinc-400 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-zinc-100'
                                 )}
                              >
                                 <LinearAvatar name={person.name} src={person.avatarUrl} className="size-4 text-[8px]" />
                                 {person.name}
                              </button>
                           ))}
                        </div>
                     ) : (
                        <div className="text-[13px] text-zinc-500 dark:text-zinc-400">
                           {fa.dailyReportsDigest.noMissing}
                        </div>
                     )}
                  </div>
               ) : null}
            </div>
         </div>
      </div>
   );
}

function IconStep({
   label,
   disabled,
   onClick,
   children,
}: {
   label: string;
   disabled?: boolean;
   onClick: () => void;
   children: React.ReactNode;
}) {
   return (
      <button
         type="button"
         aria-label={label}
         title={label}
         disabled={disabled}
         onClick={onClick}
         className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-35 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-100"
      >
         {children}
      </button>
   );
}

function SectionHeader({ title, count, meta }: { title: string; count?: number; meta?: string }) {
   return (
      <div className="flex items-center justify-between gap-3 px-5 py-3">
         <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
            {typeof count === 'number' ? (
               <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{count.toLocaleString('fa-IR')}</span>
            ) : null}
         </div>
         {meta ? <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{meta}</span> : null}
      </div>
   );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
   return <div className="px-5 py-6 text-center text-[13px] text-zinc-500 dark:text-zinc-400">{children}</div>;
}

// One person, one row: what they did, what interrupted them, what is next, and how yesterday's plan
// actually landed — instead of the same name and avatar repeated down four separate panels.
function ReportRow({
   report,
   plan,
}: {
   report: TaskaraCheckInResponse;
   plan?: TaskaraDailyReportDigest['planVsDone'][number];
}) {
   return (
      <article className="px-5 py-4">
         <div className="flex items-center justify-between gap-3">
            <PersonLine user={report.user} />
            <div className="flex items-center gap-2">
               {report.unplannedText ? (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                     {fa.dailyReportsDigest.unplannedMarker}
                  </span>
               ) : null}
               {report.author && report.authorId !== report.userId ? (
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                     {fa.dailyReportsDigest.byAuthor(report.author.name)}
                  </span>
               ) : null}
            </div>
         </div>

         <div className="mt-2 flex flex-col gap-1.5 ps-7">
            {report.completedText ? (
               <Field label={fa.dailyReportsDigest.completedSection} value={report.completedText} />
            ) : null}
            {report.unplannedText ? (
               <Field label={fa.dailyReportsDigest.unplannedSection} value={report.unplannedText} />
            ) : null}
            {report.planText ? (
               <Field label={fa.dailyReportsDigest.planSection} value={report.planText} />
            ) : null}

            {plan?.tasks.length ? (
               <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                     {fa.dailyReportsDigest.plannedYesterday}
                  </span>
                  {plan.tasks.map((task) => (
                     <span
                        key={task.key}
                        className={cn(
                           'rounded-full px-2 py-0.5 text-[10px]',
                           task.status === 'done'
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                              : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        )}
                     >
                        {task.key} ·{' '}
                        {task.status === 'done'
                           ? fa.dailyReportsDigest.taskDone
                           : fa.dailyReportsDigest.taskSlipped}
                     </span>
                  ))}
               </div>
            ) : null}
         </div>
      </article>
   );
}

// Opt-in and off the critical path: the reports below render whether or not this ever runs.
function AiSummaryStrip({ dateKey, hasReports }: { dateKey: string; hasReports: boolean }) {
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

   if (summary) {
      return (
         <section className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-5 py-4 dark:border-white/8 dark:bg-white/[0.03]">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
               <Sparkles className="size-3" />
               {fa.dailyReportsDigest.aiSummaryTitle}
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-6 text-zinc-800 dark:text-zinc-200">{summary}</p>
            <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">{fa.dailyReportsDigest.aiSummaryLabel}</p>
         </section>
      );
   }

   return (
      <Button
         type="button"
         variant="ghost"
         size="sm"
         className="self-start gap-1.5 text-zinc-500 dark:text-zinc-400"
         disabled={busy}
         onClick={() => void generate()}
      >
         <Sparkles className="size-3.5" />
         {busy ? fa.dailyReportsDigest.aiSummaryGenerating : fa.dailyReportsDigest.aiSummaryGenerate}
      </Button>
   );
}

// Persian is a connected script: `uppercase` does nothing and letter-spacing breaks the joins, so
// these labels stay plain and lean on colour and size for hierarchy instead.
function Field({ label, value }: { label: string; value: string }) {
   return (
      <div className="text-[13px] leading-6">
         <span className="text-zinc-400 dark:text-zinc-500">{label}: </span>
         <span className="whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">{linkifyTaskKeys(value)}</span>
      </div>
   );
}

function PersonLine({ user }: { user?: TaskaraDailyReportDigestPerson | null }) {
   if (!user) return null;
   return (
      <div className="flex items-center gap-2">
         <LinearAvatar name={user.name} src={user.avatarUrl} className="size-5 text-[9px]" />
         <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{user.name}</span>
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
         <Link
            key={index}
            to={`../issue/${part.key}`}
            relative="path"
            className="text-sky-600 hover:underline dark:text-sky-300"
         >
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
