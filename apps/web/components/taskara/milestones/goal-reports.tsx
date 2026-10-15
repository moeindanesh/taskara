import { useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Loader2, PenLine } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { LinearAvatar } from '@/components/taskara/linear-ui';
import { formatJalaliDateTime } from '@/lib/jalali';
import { taskaraRequest, TaskaraClientError } from '@/lib/taskara-client';
import type {
   GoalPeriod,
   TaskaraActivity,
   TaskaraMilestone,
   TaskaraMilestoneHealth,
} from '@/lib/taskara-types';
import { goalPeriodLabels } from './goal-period';
import { formatMilestoneDateOnly, MilestoneBadge, milestoneHealthMeta } from './primitives';
import { useOnlineStatus } from './use-online-status';

export function GoalReports({
   milestone,
   onPosted,
   onConflict,
   disabled = false,
}: {
   milestone: TaskaraMilestone;
   onPosted: (milestone: TaskaraMilestone) => void;
   onConflict: () => void;
   disabled?: boolean;
}) {
   const online = useOnlineStatus();
   const [body, setBody] = useState('');
   const [health, setHealth] = useState<TaskaraMilestoneHealth>(milestone.health || 'ON_TRACK');
   const healthTouched = useRef(false);
   useEffect(() => {
      if (!healthTouched.current) setHealth(milestone.health || 'ON_TRACK');
   }, [milestone.health]);
   const [posting, setPosting] = useState(false);
   const [error, setError] = useState('');
   const reports = (milestone.activity || []).filter((item) => item.action === 'report_posted');
   async function post() {
      if (posting || !body.trim()) return;
      setPosting(true);
      setError('');
      try {
         const result = await taskaraRequest<{
            milestone: TaskaraMilestone;
            report: TaskaraActivity;
         }>(`/milestones/${encodeURIComponent(milestone.id)}/reports`, {
            method: 'POST',
            body: JSON.stringify({ body: body.trim(), health, version: milestone.version }),
         });
         onPosted({
            ...result.milestone,
            activity: [result.report, ...(milestone.activity || [])],
         });
         setBody('');
         healthTouched.current = false;
         toast.success('گزارش پیشرفت ثبت شد.');
      } catch (failure) {
         if (failure instanceof TaskaraClientError && failure.status === 409) {
            onConflict();
            setError(
               'هدف تغییر کرده است. پس از تازه‌شدن اطلاعات دوباره ثبت کنید؛ متن گزارش محفوظ است.'
            );
         } else
            setError(
               failure instanceof Error ? failure.message : 'ثبت گزارش انجام نشد. دوباره تلاش کنید.'
            );
      } finally {
         setPosting(false);
      }
   }
   return (
      <div className="space-y-8">
         {milestone.canManage !== false && !milestone.archivedAt ? (
            <section
               className="rounded-xl border border-border/70 bg-muted/25 p-4 sm:p-5"
               aria-label="گزارش پیشرفت جدید"
            >
               <div className="flex flex-wrap items-center gap-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                     <PenLine className="size-4 text-muted-foreground" />
                     گزارش پیشرفت
                  </span>
                  <Select
                     value={health}
                     onValueChange={(value) => {
                        healthTouched.current = true;
                        setHealth(value as TaskaraMilestoneHealth);
                     }}
                     disabled={posting}
                  >
                     <SelectTrigger
                        aria-label="وضعیت گزارش"
                        className="h-8 w-auto rounded-full border-border/60 bg-background/50 text-xs"
                     >
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent className="[direction:rtl]">
                        {Object.entries(milestoneHealthMeta).map(([value, meta]) => (
                           <SelectItem key={value} value={value}>
                              <span className="flex items-center gap-2">
                                 <meta.icon className="size-3.5" />
                                 {meta.label}
                              </span>
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </div>
               <Textarea
                  aria-label="متن گزارش پیشرفت"
                  value={body}
                  maxLength={15000}
                  disabled={posting}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="چه نتیجه‌ای گرفتیم؟ چه مانعی داریم؟ قدم بعدی چیست؟"
                  className="my-4 min-h-36 resize-y border-0 bg-transparent px-0 text-sm leading-7 shadow-none focus-visible:ring-0"
               />
               {error ? (
                  <p role="alert" className="mb-3 text-xs leading-6 text-destructive">
                     {error}
                  </p>
               ) : null}
               <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[11px] leading-5 text-muted-foreground">
                     {!online
                        ? 'برای ثبت گزارش به اینترنت وصل شوید.'
                        : disabled
                          ? 'ابتدا تغییرات هدف را ذخیره کنید.'
                          : 'وضعیت و پیشرفت امروز همراه گزارش ذخیره می‌شود.'}
                  </span>
                  <Button
                     disabled={
                        posting ||
                        !body.trim() ||
                        !online ||
                        disabled ||
                        milestone.syncState === 'pending'
                     }
                     size="sm"
                     className="rounded-full"
                     onClick={() => void post()}
                  >
                     {posting ? <Loader2 className="size-4 animate-spin" /> : null}ثبت گزارش
                  </Button>
               </div>
            </section>
         ) : null}
         <section aria-label="گزارش‌های ثبت‌شده" className="space-y-5">
            <h2 className="text-sm font-medium">
               گزارش‌های پیشرفت{' '}
               <span className="ms-2 text-muted-foreground">
                  {reports.length.toLocaleString('fa-IR')}
               </span>
            </h2>
            {reports.length ? (
               reports.map((report) => (
                  <GoalReportCard key={report.id} report={report} goalName={milestone.name} />
               ))
            ) : (
               <div className="py-10 text-center">
                  <PenLine className="mx-auto mb-3 size-6 text-muted-foreground/60" />
                  <p className="text-sm">هنوز گزارشی ثبت نشده</p>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">
                     اولین گزارش را بنویسید تا تیم و مدیر از روند این هدف باخبر شوند.
                  </p>
               </div>
            )}
         </section>
      </div>
   );
}

export function GoalReportCard({
   report,
   goalName,
}: {
   report: TaskaraActivity;
   goalName: string;
}) {
   const data = report.after || {};
   const health =
      typeof data.health === 'string'
         ? milestoneHealthMeta[data.health as TaskaraMilestoneHealth]
         : null;
   const progress = data.progress as TaskaraMilestone['progress'] | undefined;
   const body = typeof data.body === 'string' ? data.body : '';
   const period = goalPeriodLabels[data.period as GoalPeriod];
   const dates = [data.startsOn, data.targetOn]
      .filter((value): value is string => typeof value === 'string')
      .map(formatMilestoneDateOnly)
      .join(' تا ');
   async function copy() {
      try {
         await navigator.clipboard.writeText(
            [
               goalName,
               `گزارش ${formatJalaliDateTime(report.createdAt)}`,
               report.actor?.name,
               [period, dates].filter(Boolean).join(' · '),
               health?.label,
               progress
                  ? `${progress.completedTasks} از ${progress.eligibleTasks} کار تکمیل شده`
                  : '',
               body,
            ]
               .filter(Boolean)
               .join('\n')
         );
         toast.success('گزارش کپی شد.');
      } catch {
         toast.error('کپی گزارش در این مرورگر در دسترس نیست.');
      }
   }
   return (
      <article className="rounded-xl border border-border/70 bg-muted/15 p-4 sm:p-5">
         <div className="flex flex-wrap items-center gap-2.5">
            <LinearAvatar
               className="size-7"
               name={report.actor?.name || 'عضو تیم'}
               src={report.actor?.avatarUrl}
            />
            <span className="text-xs font-medium">{report.actor?.name || 'عضو تیم'}</span>
            <span className="text-[11px] text-muted-foreground">
               {formatJalaliDateTime(report.createdAt)}
            </span>
            <button
               type="button"
               aria-label="کپی گزارش"
               title="کپی گزارش"
               className="ms-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
               onClick={() => void copy()}
            >
               <ClipboardCopy className="size-3.5" />
            </button>
         </div>
         <div className="mt-4 flex flex-wrap items-center gap-2">
            {health ? <MilestoneBadge {...health} /> : null}
            {progress ? (
               <span className="text-[11px] text-muted-foreground">
                  {progress.completedTasks.toLocaleString('fa-IR')} از{' '}
                  {progress.eligibleTasks.toLocaleString('fa-IR')} کار تکمیل‌شده
                  {progress.percentage !== null
                     ? ` · ${progress.percentage.toLocaleString('fa-IR')}٪`
                     : ''}
               </span>
            ) : null}
         </div>
         <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">{body}</p>
         {period || dates ? (
            <p className="mt-4 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
               {[period, dates].filter(Boolean).join(' · ')}
            </p>
         ) : null}
      </article>
   );
}
