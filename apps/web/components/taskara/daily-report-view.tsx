'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { sendTaskSyncMutation } from '@/lib/task-sync';
import { taskaraRequest } from '@/lib/taskara-client';
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

   return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
         <header className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
               <h1 className="text-lg font-semibold text-white">{fa.dailyReport.title}</h1>
               {dayLabel ? <span className="text-xs text-white/50">{dayLabel}</span> : null}
            </div>
            <p className="text-sm text-white/60">{fa.dailyReport.subtitle}</p>
         </header>

         {draft?.yesterday?.planText ? (
            <section className="rounded-lg border border-white/10 bg-[#111113] p-4">
               <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                     <span className="text-xs font-medium text-white/70">{fa.dailyReport.yesterdayPlanTitle}</span>
                     <p className="whitespace-pre-wrap text-sm text-white/80">{draft.yesterday.planText}</p>
                  </div>
                  <Button
                     type="button"
                     variant="ghost"
                     size="sm"
                     onClick={() => appendLine('planText', draft.yesterday?.planText || '')}
                  >
                     {fa.dailyReport.carryForward}
                  </Button>
               </div>
            </section>
         ) : null}

         <ReportSection
            label={fa.dailyReport.completedLabel}
            placeholder={fa.dailyReport.completedPlaceholder}
            value={fields.completedText}
            onChange={(value) => setFields((current) => ({ ...current, completedText: value }))}
            candidates={draft?.completedCandidates ?? []}
            candidatesTitle={fa.dailyReport.suggestionsTitle}
            onPick={(line) => appendLine('completedText', line)}
            disabled={loading}
         />

         <ReportSection
            label={fa.dailyReport.unplannedLabel}
            hint={fa.dailyReport.unplannedHint}
            placeholder={fa.dailyReport.unplannedPlaceholder}
            value={fields.unplannedText}
            onChange={(value) => setFields((current) => ({ ...current, unplannedText: value }))}
            candidates={draft?.unplannedCandidates ?? []}
            candidatesTitle={fa.dailyReport.unplannedSuggestionsTitle}
            onPick={(line) => appendLine('unplannedText', line)}
            disabled={loading}
         />

         <ReportSection
            label={fa.dailyReport.planLabel}
            placeholder={fa.dailyReport.planPlaceholder}
            value={fields.planText}
            onChange={(value) => setFields((current) => ({ ...current, planText: value }))}
            candidates={draft?.planCandidates ?? []}
            candidatesTitle={fa.dailyReport.planSuggestionsTitle}
            onPick={(line) => appendLine('planText', line)}
            disabled={loading}
         />

         <section className="flex flex-col gap-3">
            <button
               type="button"
               className="self-start text-xs text-white/60 underline-offset-4 hover:text-white hover:underline"
               onClick={() => setShowHelp((current) => !current)}
            >
               {fa.dailyReport.needHelpToggle}
            </button>
            {showHelp ? (
               <div className="flex flex-col gap-4 rounded-lg border border-white/10 bg-[#111113] p-4">
                  <ReportSection
                     label={fa.dailyReport.blockersLabel}
                     placeholder={fa.dailyReport.blockersPlaceholder}
                     value={fields.blockersText}
                     onChange={(value) => setFields((current) => ({ ...current, blockersText: value }))}
                     candidates={draft?.blockedTasks ?? []}
                     candidatesTitle={fa.dailyReport.blockedTitle}
                     onPick={(line) => appendLine('blockersText', line)}
                     disabled={loading}
                     bare
                  />
                  <ReportSection
                     label={fa.dailyReport.helpLabel}
                     placeholder={fa.dailyReport.helpPlaceholder}
                     value={fields.helpText}
                     onChange={(value) => setFields((current) => ({ ...current, helpText: value }))}
                     candidates={[]}
                     onPick={() => undefined}
                     disabled={loading}
                     bare
                  />
               </div>
            ) : null}
         </section>

         <footer className="flex items-center justify-between gap-3 border-t border-white/10 pt-4">
            <div className="flex flex-col gap-0.5 text-xs text-white/50">
               {submittedAt ? <span>{fa.dailyReport.lastEdited(formatJalaliDate(submittedAt))}</span> : null}
               <span>{fa.dailyReport.editableHint}</span>
            </div>
            <Button type="button" onClick={submit} disabled={saving || loading || !hasAnswer}>
               {saving
                  ? fa.dailyReport.submitting
                  : submittedAt
                     ? fa.dailyReport.update
                     : fa.dailyReport.submit}
            </Button>
         </footer>
      </div>
   );
}

interface ReportSectionProps {
   label: string;
   hint?: string;
   placeholder?: string;
   value: string;
   onChange: (value: string) => void;
   candidates: TaskaraDailyReportCandidate[];
   candidatesTitle?: string;
   onPick: (line: string) => void;
   disabled?: boolean;
   bare?: boolean;
}

function ReportSection({
   label,
   hint,
   placeholder,
   value,
   onChange,
   candidates,
   candidatesTitle,
   onPick,
   disabled,
   bare,
}: ReportSectionProps) {
   return (
      <section className={bare ? 'flex flex-col gap-2' : 'flex flex-col gap-2 rounded-lg border border-white/10 bg-[#111113] p-4'}>
         <div className="flex flex-col gap-0.5">
            <label className="text-sm font-medium text-white/90">{label}</label>
            {hint ? <span className="text-xs text-white/50">{hint}</span> : null}
         </div>
         <Textarea
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            rows={3}
            onChange={(event) => onChange(event.target.value)}
         />
         {candidates.length ? (
            <div className="flex flex-col gap-1.5">
               {candidatesTitle ? (
                  <span className="text-xs text-white/50">
                     {candidatesTitle} — {fa.dailyReport.suggestionsHint}
                  </span>
               ) : null}
               <div className="flex flex-wrap gap-1.5">
                  {candidates.map((candidate) => (
                     <button
                        key={`${candidate.key}-${candidate.reason}`}
                        type="button"
                        className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/70 transition hover:border-white/25 hover:text-white"
                        onClick={() => onPick(`${candidate.key} — ${candidate.title}`)}
                     >
                        <span className="text-white/40">{fa.dailyReport.reasonLabel[candidate.reason]}</span>
                        {' · '}
                        {candidate.key}
                     </button>
                  ))}
               </div>
            </div>
         ) : null}
      </section>
   );
}
