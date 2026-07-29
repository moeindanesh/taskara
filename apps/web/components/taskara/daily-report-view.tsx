'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, CornerDownLeft, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { sendTaskSyncMutation } from '@/lib/task-sync';
import { taskaraRequest } from '@/lib/taskara-client';
import { cn } from '@/lib/utils';
import type { TaskaraDailyReportCandidate, TaskaraDailyReportDraft } from '@/lib/taskara-types';

interface ReportFields {
   completedText: string;
   unplannedText: string;
   blockersText: string;
   planText: string;
   helpText: string;
}

const emptyFields: ReportFields = {
   completedText: '',
   unplannedText: '',
   blockersText: '',
   planText: '',
   helpText: '',
};

export function DailyReportView() {
   const [draft, setDraft] = useState<TaskaraDailyReportDraft | null>(null);
   const [fields, setFields] = useState<ReportFields>(emptyFields);
   const [loading, setLoading] = useState(true);
   const [saving, setSaving] = useState(false);
   const [showHelp, setShowHelp] = useState(false);
   const [submittedAt, setSubmittedAt] = useState<string | null>(null);

   useEffect(() => {
      let cancelled = false;
      setLoading(true);
      taskaraRequest<TaskaraDailyReportDraft>('/check-ins/draft')
         .then((data) => {
            if (cancelled) return;
            setDraft(data);
            if (data.existing) {
               setFields({
                  completedText: data.existing.completedText || '',
                  unplannedText: data.existing.unplannedText || '',
                  blockersText: data.existing.blockersText || '',
                  planText: data.existing.planText || '',
                  helpText: data.existing.helpText || '',
               });
               setSubmittedAt(data.existing.updatedAt);
               if (data.existing.blockersText || data.existing.helpText) setShowHelp(true);
            }
         })
         .catch(() => {
            if (!cancelled) toast.error(fa.dailyReport.loadFailed);
         })
         .finally(() => {
            if (!cancelled) setLoading(false);
         });
      return () => {
         cancelled = true;
      };
   }, []);

   const appendLine = useCallback((field: keyof ReportFields, line: string) => {
      setFields((current) => {
         if (current[field].includes(line)) return current;
         const prefix = current[field].trim() ? `${current[field].replace(/\s+$/, '')}\n` : '';
         return { ...current, [field]: `${prefix}${line}` };
      });
   }, []);

   const setField = useCallback((field: keyof ReportFields, value: string) => {
      setFields((current) => ({ ...current, [field]: value }));
   }, []);

   const hasAnswer = useMemo(
      () => Object.values(fields).some((value) => value.trim().length > 0),
      [fields]
   );

   const submit = useCallback(async () => {
      if (!hasAnswer) {
         toast.error(fa.dailyReport.emptyError);
         return;
      }
      setSaving(true);
      try {
         await sendTaskSyncMutation('check_in.upsert', {
            completedText: fields.completedText.trim() || null,
            unplannedText: fields.unplannedText.trim() || null,
            blockersText: fields.blockersText.trim() || null,
            planText: fields.planText.trim() || null,
            helpText: fields.helpText.trim() || null,
         });
         setSubmittedAt(new Date().toISOString());
         toast.success(fa.dailyReport.submitted);
      } catch {
         toast.error(fa.dailyReport.submitFailed);
      } finally {
         setSaving(false);
      }
   }, [fields, hasAnswer]);

   const dayLabel = draft?.dateKey ? formatJalaliDate(`${draft.dateKey}T12:00:00.000Z`) : '';
   const helpFilled = Boolean(fields.blockersText.trim() || fields.helpText.trim());

   return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-zinc-900 dark:bg-[#101011] dark:text-zinc-100">
         <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 sm:px-6">
            {/* The page title comes from PageHeader; this line only anchors the report to its day. */}
            <div className="flex items-center justify-between gap-3">
               <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{dayLabel}</span>
               {submittedAt ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                     <Check className="size-3" />
                     {fa.dailyReport.lastEdited(formatJalaliDate(submittedAt))}
                  </span>
               ) : null}
            </div>

            {draft?.yesterday?.planText ? (
               <div className="flex items-start justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-white/8 dark:bg-white/[0.03]">
                  <div className="min-w-0">
                     <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {fa.dailyReport.yesterdayPlanTitle}
                     </div>
                     <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-6 text-zinc-700 dark:text-zinc-300">
                        {draft.yesterday.planText}
                     </p>
                  </div>
                  <button
                     type="button"
                     className="shrink-0 rounded-md px-2 py-1 text-[11px] text-zinc-600 transition hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/8 dark:hover:text-zinc-100"
                     onClick={() => appendLine('planText', draft.yesterday?.planText || '')}
                  >
                     <CornerDownLeft className="ms-1 inline size-3" />
                     {fa.dailyReport.carryForward}
                  </button>
               </div>
            ) : null}

            {/* One surface with hairline-divided steps, rather than three competing cards. */}
            <div className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:divide-white/7 dark:border-white/8 dark:bg-[#161618]">
               <ReportStep
                  step={1}
                  label={fa.dailyReport.completedLabel}
                  placeholder={fa.dailyReport.completedPlaceholder}
                  value={fields.completedText}
                  onChange={(value) => setField('completedText', value)}
                  candidates={draft?.completedCandidates ?? []}
                  candidatesTitle={fa.dailyReport.suggestionsTitle}
                  candidatesHint={fa.dailyReport.suggestionsHint}
                  onPick={(line) => appendLine('completedText', line)}
                  disabled={loading}
               />

               <ReportStep
                  step={2}
                  label={fa.dailyReport.unplannedLabel}
                  hint={fa.dailyReport.unplannedHint}
                  placeholder={fa.dailyReport.unplannedPlaceholder}
                  value={fields.unplannedText}
                  onChange={(value) => setField('unplannedText', value)}
                  candidates={draft?.unplannedCandidates ?? []}
                  candidatesTitle={fa.dailyReport.unplannedSuggestionsTitle}
                  onPick={(line) => appendLine('unplannedText', line)}
                  disabled={loading}
               />

               <ReportStep
                  step={3}
                  label={fa.dailyReport.planLabel}
                  placeholder={fa.dailyReport.planPlaceholder}
                  value={fields.planText}
                  onChange={(value) => setField('planText', value)}
                  candidates={draft?.planCandidates ?? []}
                  candidatesTitle={fa.dailyReport.planSuggestionsTitle}
                  onPick={(line) => appendLine('planText', line)}
                  disabled={loading}
               />

               <div>
                  <button
                     type="button"
                     aria-expanded={showHelp}
                     className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-start transition hover:bg-zinc-50 dark:hover:bg-white/[0.03]"
                     onClick={() => setShowHelp((current) => !current)}
                  >
                     <span className="flex items-center gap-2 text-[13px] text-zinc-600 dark:text-zinc-300">
                        {fa.dailyReport.needHelpToggle}
                        {helpFilled && !showHelp ? (
                           <span className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
                        ) : null}
                     </span>
                     <ChevronDown
                        className={cn(
                           'size-4 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500',
                           showHelp && 'rotate-180'
                        )}
                     />
                  </button>

                  {showHelp ? (
                     <div className="border-t border-zinc-200 dark:border-white/7">
                        <ReportStep
                           label={fa.dailyReport.blockersLabel}
                           placeholder={fa.dailyReport.blockersPlaceholder}
                           value={fields.blockersText}
                           onChange={(value) => setField('blockersText', value)}
                           candidates={draft?.blockedTasks ?? []}
                           candidatesTitle={fa.dailyReport.blockedTitle}
                           onPick={(line) => appendLine('blockersText', line)}
                           disabled={loading}
                        />
                        <div className="border-t border-zinc-200 dark:border-white/7">
                           <ReportStep
                              label={fa.dailyReport.helpLabel}
                              placeholder={fa.dailyReport.helpPlaceholder}
                              value={fields.helpText}
                              onChange={(value) => setField('helpText', value)}
                              candidates={[]}
                              onPick={() => undefined}
                              disabled={loading}
                           />
                        </div>
                     </div>
                  ) : null}
               </div>
            </div>

            <div className="flex items-center justify-between gap-3">
               <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{fa.dailyReport.editableHint}</span>
               <Button type="button" onClick={submit} disabled={saving || loading || !hasAnswer}>
                  {saving
                     ? fa.dailyReport.submitting
                     : submittedAt
                        ? fa.dailyReport.update
                        : fa.dailyReport.submit}
               </Button>
            </div>
         </div>
      </div>
   );
}

interface ReportStepProps {
   step?: number;
   label: string;
   hint?: string;
   placeholder?: string;
   value: string;
   onChange: (value: string) => void;
   candidates: TaskaraDailyReportCandidate[];
   candidatesTitle?: string;
   candidatesHint?: string;
   onPick: (line: string) => void;
   disabled?: boolean;
}

function ReportStep({
   step,
   label,
   hint,
   placeholder,
   value,
   onChange,
   candidates,
   candidatesTitle,
   candidatesHint,
   onPick,
   disabled,
}: ReportStepProps) {
   return (
      <section className="flex gap-3 px-5 py-4">
         {step ? (
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-zinc-200 text-[10px] text-zinc-400 dark:border-white/10 dark:text-zinc-500">
               {step.toLocaleString('fa-IR')}
            </span>
         ) : null}

         <div className="min-w-0 flex-1">
            <label className="block text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{label}</label>
            {hint ? <p className="mt-0.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{hint}</p> : null}

            {/* Quiet at rest but unmistakably a field, so nobody has to guess where to type. */}
            <textarea
               value={value}
               placeholder={placeholder}
               disabled={disabled}
               rows={2}
               onChange={(event) => onChange(event.target.value)}
               className="mt-2 w-full resize-none rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 py-2 text-[13px] leading-6 text-zinc-900 outline-none transition placeholder:text-zinc-400 hover:border-zinc-300 focus:border-zinc-400 focus:bg-white disabled:opacity-50 dark:border-white/8 dark:bg-white/[0.03] dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:hover:border-white/12 dark:focus:border-white/20 dark:focus:bg-white/[0.05]"
            />

            {candidates.length ? (
               <div className="mt-2.5">
                  {candidatesTitle ? (
                     <div className="mb-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                        {candidatesTitle}
                        {/* Taught once, on the first step only — the + on each chip carries it after that. */}
                        {candidatesHint ? <span className="text-zinc-300 dark:text-zinc-600"> — {candidatesHint}</span> : null}
                     </div>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                     {candidates.map((candidate) => (
                        <CandidateChip
                           key={`${candidate.key}-${candidate.reason}`}
                           candidate={candidate}
                           added={mentionsTaskKey(value, candidate.key)}
                           onPick={onPick}
                        />
                     ))}
                  </div>
               </div>
            ) : null}
         </div>
      </section>
   );
}

// The title is the only part a person can actually recognise, so it leads. The key stays as a small
// muted anchor and the reason moves to the tooltip, since it repeats across every chip in a row.
function CandidateChip({
   candidate,
   added,
   onPick,
}: {
   candidate: TaskaraDailyReportCandidate;
   added: boolean;
   onPick: (line: string) => void;
}) {
   return (
      <button
         type="button"
         title={fa.dailyReport.reasonLabel[candidate.reason]}
         disabled={added}
         onClick={() => onPick(`${candidate.key} — ${candidate.title}`)}
         className={cn(
            'group inline-flex max-w-[17rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition',
            added
               ? 'cursor-default border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
               : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 dark:border-white/10 dark:text-zinc-400 dark:hover:border-white/20 dark:hover:bg-white/5 dark:hover:text-zinc-100'
         )}
      >
         {added ? (
            <Check className="size-3 shrink-0" />
         ) : (
            <Plus className="size-3 shrink-0 text-zinc-400 transition group-hover:text-zinc-600 dark:text-zinc-600 dark:group-hover:text-zinc-300" />
         )}
         <span className="shrink-0 tabular-nums text-zinc-400 dark:text-zinc-500">{candidate.key}</span>
         <span className="truncate">{candidate.title}</span>
      </button>
   );
}
