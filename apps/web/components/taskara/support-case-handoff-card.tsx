import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
   AlertTriangle,
   ArrowLeft,
   CheckCircle2,
   CircleOff,
   FileWarning,
   Link2,
   Loader2,
   Plus,
   RefreshCw,
   Search,
   ShieldAlert,
   Trash2,
   Unplug,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { supportHandoffClient } from '@/lib/support-handoff-client';
import {
   supportHandoffConflictMessage,
   supportHandoffIrreversibilityWarning,
   supportHandoffVisibilityWarning,
   supportTaskLinkSignalLabel,
   supportTaskLinkState,
   supportTaskLinkStateLabel,
   supportTaskRelationLabels,
   teamTaskPriorityLabels,
} from '@/lib/support-handoff-presenters';
import type {
   SupportCaseHandoffOptions,
   SupportCaseTaskLinkProjection,
   SupportCaseWorkTarget,
   SupportHandoffTaskOption,
   SupportTaskRelationType,
} from '@/lib/support-handoff-types';
import { supportTaskRelationTypes } from '@/lib/support-handoff-types';
import type { SupportCase } from '@/lib/support-types';
import { TaskaraClientError } from '@/lib/taskara-client';
import { cn } from '@/lib/utils';
import { supportAccessEpochMatches, useSupportWorkspace } from '@/lib/support-workspace-provider';
import { isWorkspaceAdminRole } from '@/lib/workspace-mode';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';

type HandoffMode = 'LINK' | 'CREATE';

type HandoffDraft = {
   targetActionRef: string;
   relationType: SupportTaskRelationType;
   handoffTitle: string;
   handoffSummary: string;
   taskActionRef: string;
   taskTitle: string;
   taskDescription: string;
   taskPriority: 'NO_PRIORITY' | 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
   parentTaskActionRef: string;
};

const emptyDraft: HandoffDraft = {
   targetActionRef: '',
   relationType: 'FIX_WORK',
   handoffTitle: '',
   handoffSummary: '',
   taskActionRef: '',
   taskTitle: '',
   taskDescription: '',
   taskPriority: 'NO_PRIORITY',
   parentTaskActionRef: '',
};

export function SupportCaseHandoffCard({
   canMutate = true,
   item,
   onCaseChanged,
}: {
   canMutate?: boolean;
   item: SupportCase;
   onCaseChanged: () => Promise<void>;
}) {
   const support = useSupportWorkspace();
   const runtime = useWorkspaceRuntime();
   const [links, setLinks] = useState<SupportCaseTaskLinkProjection[]>([]);
   const [options, setOptions] = useState<SupportCaseHandoffOptions>({ items: [], caseVersion: item.version });
   const [caseVersion, setCaseVersion] = useState(item.version);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [optionsError, setOptionsError] = useState('');
   const [notice, setNotice] = useState('');
   const [dialogMode, setDialogMode] = useState<HandoffMode | null>(null);
   const [unlinking, setUnlinking] = useState<SupportCaseTaskLinkProjection | null>(null);

   const load = useCallback(async () => {
      setLoading(true);
      setError('');
      setOptionsError('');
      const [linkResult, optionsResult] = await Promise.allSettled([
         supportHandoffClient.listCaseLinks(item.key),
         supportHandoffClient.getCaseHandoffOptions(item.key),
      ]);
      const incomingEpochs = [
         linkResult.status === 'fulfilled' ? linkResult.value.accessEpoch : undefined,
         optionsResult.status === 'fulfilled' ? optionsResult.value.accessEpoch : undefined,
      ];
      if (incomingEpochs.some((epoch) => !supportAccessEpochMatches(support.accessEpoch, epoch))) {
         setLinks([]);
         setOptions({ items: [], caseVersion: item.version });
         setError('محدوده دسترسی پشتیبانی تغییر کرده است؛ داده‌های قبلی پاک و دسترسی تازه در حال بارگذاری است.');
         setLoading(false);
         await support.bootstrap();
         return;
      }
      if (linkResult.status === 'fulfilled') {
         setLinks(linkResult.value.items);
         setCaseVersion(linkResult.value.caseVersion ?? item.version);
      } else {
         setError(linkResult.reason instanceof Error ? linkResult.reason.message : 'بارگذاری کارهای مرتبط ناموفق بود.');
      }
      if (optionsResult.status === 'fulfilled') {
         setOptions(optionsResult.value);
         setCaseVersion((current) => Math.max(current, optionsResult.value.caseVersion));
      } else {
         setOptions({ items: [], caseVersion: item.version });
         setOptionsError(optionsResult.reason instanceof Error ? optionsResult.reason.message : 'مقصد مجاز برای تحویل بارگذاری نشد.');
      }
      setLoading(false);
   }, [item.key, item.version, support.accessEpoch, support.bootstrap]);

   useEffect(() => {
      void load();
   }, [load]);

   useEffect(() => {
      setCaseVersion((current) => Math.max(current, item.version));
   }, [item.version]);

   async function acceptMutation(version: number, replayed: boolean, incomingEpoch?: string | number) {
      if (!supportAccessEpochMatches(support.accessEpoch, incomingEpoch)) {
         setLinks([]);
         await support.bootstrap();
         return;
      }
      setCaseVersion(version);
      setNotice(replayed
         ? 'نتیجه درخواست قبلی بازیابی شد؛ کار یا پیوند تکراری ساخته نشد.'
         : 'تحویل کار ثبت شد. وضعیت کار تیمی، وضعیت پرونده را به‌طور خودکار تغییر نمی‌دهد.');
      setDialogMode(null);
      await Promise.allSettled([load(), onCaseChanged()]);
   }

   const canCreate = options.items.some((target) => target.allowCreateTasks);
   const canLink = options.items.some((target) => target.allowLinkTasks);

   return (
      <>
         <Card className="border-white/8 bg-[#171719] text-zinc-100" data-testid="support-case-handoff-card">
            <CardHeader className="border-b border-white/7">
               <div className="flex items-start justify-between gap-3">
                  <div>
                     <CardTitle className="flex items-center gap-2 text-sm"><Link2 className="size-4 text-indigo-300" /> کار تیمی مرتبط</CardTitle>
                     <CardDescription className="mt-1.5 leading-6 text-zinc-600">فقط نمای تأییدشده کار تیمی نمایش داده می‌شود؛ این پیوند دسترسی تازه‌ای ایجاد نمی‌کند.</CardDescription>
                  </div>
                  <Button aria-label="تازه‌سازی کارهای مرتبط" className="size-8 shrink-0 text-zinc-500 hover:bg-white/6" size="icon" type="button" variant="ghost" onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button>
               </div>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
               {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
               {notice ? <InlineMessage tone="success">{notice}</InlineMessage> : null}
               {loading && !links.length ? <div className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-600"><Loader2 className="size-4 animate-spin" /> در حال بارگذاری پیوندها…</div> : null}
               {!loading && !links.length ? <p className="rounded-lg border border-dashed border-white/10 px-3 py-5 text-center text-xs text-zinc-600">هنوز کار تیمی به این پرونده پیوند نشده است.</p> : null}
               <SupportCaseTaskLinkListView
                  canUnlink={canMutate}
                  canUnlinkFrozen={isWorkspaceAdminRole(runtime.role)}
                  links={links}
                  onUnlink={setUnlinking}
               />
               {canMutate && item.status !== 'CLOSED' ? (
                  <div className="grid gap-2 border-t border-white/6 pt-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                     <Button className="border border-white/10 bg-white/6 text-zinc-200 hover:bg-white/10" disabled={!canLink || loading} size="sm" type="button" variant="secondary" onClick={() => setDialogMode('LINK')}><Link2 className="size-4" /> پیوند کار موجود</Button>
                     <Button className="bg-indigo-400/15 text-indigo-100 hover:bg-indigo-400/25" disabled={!canCreate || loading} size="sm" type="button" onClick={() => setDialogMode('CREATE')}><Plus className="size-4" /> ساخت کار تیمی</Button>
                  </div>
               ) : null}
               {optionsError ? <p className="text-xs leading-6 text-amber-200/80"><AlertTriangle className="me-1 inline size-3.5" />{optionsError}</p> : null}
               {!optionsError && !loading && !options.items.length ? <p className="text-xs leading-6 text-zinc-600">برای دپارتمان مالک، اتصال فعال و مقصد پروژه‌ای مجاز تعریف نشده است.</p> : null}
            </CardContent>
         </Card>

         <SupportHandoffDialog
            baseVersion={caseVersion}
            caseKey={item.key}
            mode={dialogMode}
            targets={options.items}
            onConflict={async () => {
               setNotice(supportHandoffConflictMessage());
               await Promise.allSettled([load(), onCaseChanged()]);
            }}
            onOpenChange={(open) => !open && setDialogMode(null)}
            onSubmitted={(version, replayed, accessEpoch) => acceptMutation(version, replayed, accessEpoch)}
         />
         <UnlinkTaskDialog
            baseVersion={caseVersion}
            caseKey={item.key}
            link={unlinking}
            onConflict={async () => {
               setUnlinking(null);
               setNotice(supportHandoffConflictMessage());
               await Promise.allSettled([load(), onCaseChanged()]);
            }}
            onOpenChange={(open) => !open && setUnlinking(null)}
            onUnlinked={async (version, replayed, accessEpoch) => {
               if (!supportAccessEpochMatches(support.accessEpoch, accessEpoch)) {
                  setLinks([]);
                  setUnlinking(null);
                  await support.bootstrap();
                  return;
               }
               setUnlinking(null);
               setCaseVersion(version);
               setNotice(replayed ? 'این پیوند پیش‌تر برداشته شده بود.' : 'پیوند برداشته شد؛ پرونده و کار تیمی حذف نشدند.');
               await Promise.allSettled([load(), onCaseChanged()]);
            }}
         />
      </>
   );
}

export function SupportCaseTaskLinkListView({
   canUnlink = true,
   canUnlinkFrozen = true,
   links,
   onUnlink = () => undefined,
}: {
   canUnlink?: boolean;
   canUnlinkFrozen?: boolean;
   links: SupportCaseTaskLinkProjection[];
   onUnlink?: (link: SupportCaseTaskLinkProjection) => void;
}) {
   return (
      <div className="space-y-2">
         {links.map((link) => {
            const state = supportTaskLinkState(link);
            const unlinkAllowed = canUnlink && (state === 'ACTIVE' || canUnlinkFrozen);
            return (
               <article key={link.linkId} className={cn('rounded-lg border p-3', state === 'ACTIVE' ? 'border-white/8 bg-black/10' : 'border-amber-400/10 bg-amber-400/[0.025]')}>
                  <div className="flex items-start gap-2.5">
                     <TaskLinkStateIcon state={state} />
                     <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                           <bdi dir="ltr" className="font-mono text-[11px] text-indigo-300">{link.taskKey}</bdi>
                           <Badge variant="outline" className="border-white/10 text-[10px] text-zinc-500">{taskStatusLabel(link.status)}</Badge>
                        </div>
                        <h4 className="mt-1.5 break-words text-xs font-medium leading-6 text-zinc-300">{link.title}</h4>
                        <p className="mt-1 text-[11px] text-zinc-600">{link.teamWorkspaceName} · {supportTaskLinkSignalLabel(link)}</p>
                        {state !== 'ACTIVE' ? <p className="mt-1.5 text-[11px] leading-5 text-amber-200/75">{supportTaskLinkStateLabel(link)}</p> : null}
                     </div>
                     {unlinkAllowed && state !== 'UNLINKED' ? <Button aria-label={`برداشتن پیوند ${link.taskKey}`} className="size-7 shrink-0 text-zinc-600 hover:bg-red-400/10 hover:text-red-200" size="icon" type="button" variant="ghost" onClick={() => onUnlink(link)}><Trash2 className="size-3.5" /></Button> : null}
                  </div>
               </article>
            );
         })}
      </div>
   );
}

function SupportHandoffDialog({
   baseVersion,
   caseKey,
   mode,
   targets,
   onConflict,
   onOpenChange,
   onSubmitted,
}: {
   baseVersion: number;
   caseKey: string;
   mode: HandoffMode | null;
   targets: SupportCaseWorkTarget[];
   onConflict: () => Promise<void>;
   onOpenChange: (open: boolean) => void;
   onSubmitted: (version: number, replayed: boolean, accessEpoch?: string | number) => Promise<void>;
}) {
   const [draft, setDraft] = useState<HandoffDraft>(emptyDraft);
   const [tasks, setTasks] = useState<SupportHandoffTaskOption[]>([]);
   const [taskQuery, setTaskQuery] = useState('');
   const [preview, setPreview] = useState(false);
   const [confirmed, setConfirmed] = useState(false);
   const [idempotencyKey, setIdempotencyKey] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [searching, setSearching] = useState(false);
   const [error, setError] = useState('');
   const taskSearchRequestRef = useRef(0);

   useEffect(() => {
      if (!mode) return;
      taskSearchRequestRef.current += 1;
      setDraft(emptyDraft);
      setTasks([]);
      setTaskQuery('');
      setSearching(false);
      setPreview(false);
      setConfirmed(false);
      setIdempotencyKey(newHandoffKey());
      setError('');
   }, [mode]);

   const selectedTarget = useMemo(
      () => targets.find((target) => target.actionRef === draft.targetActionRef),
      [draft.targetActionRef, targets]
   );
   const allowedTargets = targets.filter((target) => mode === 'CREATE' ? target.allowCreateTasks : target.allowLinkTasks);

   async function searchTasks() {
      if (!draft.targetActionRef || !taskQuery.trim()) return;
      const requestId = ++taskSearchRequestRef.current;
      const targetActionRef = draft.targetActionRef;
      setSearching(true);
      setError('');
      try {
         const result = await supportHandoffClient.searchTargetTasks(targetActionRef, taskQuery.trim());
         if (requestId === taskSearchRequestRef.current) setTasks(result);
      } catch (caught) {
         if (requestId === taskSearchRequestRef.current) {
            setError(caught instanceof Error ? caught.message : 'جست‌وجوی کارهای تیمی ناموفق بود.');
         }
      } finally {
         if (requestId === taskSearchRequestRef.current) setSearching(false);
      }
   }

   function selectTarget(targetActionRef: string) {
      taskSearchRequestRef.current += 1;
      setSearching(false);
      setTasks([]);
      setTaskQuery('');
      setDraft((current) => ({ ...current, targetActionRef, taskActionRef: '', parentTaskActionRef: '' }));
   }

   function showPreview(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!selectedTarget || !validDraft(mode, draft)) return;
      setPreview(true);
      setConfirmed(false);
      setError('');
   }

   async function submit() {
      if (!mode || !selectedTarget || !confirmed || submitting || !validDraft(mode, draft)) return;
      setSubmitting(true);
      setError('');
      try {
         const common = {
            workTargetId: selectedTarget.actionRef,
            relationType: draft.relationType,
            handoffTitle: draft.handoffTitle.trim(),
            handoffSummary: draft.handoffSummary.trim(),
            baseVersion,
            idempotencyKey,
         };
         const result = mode === 'LINK'
            ? await supportHandoffClient.linkExistingTask(caseKey, { ...common, taskId: draft.taskActionRef })
            : await supportHandoffClient.createLinkedTask(caseKey, {
                 ...common,
                 parentTaskId: draft.parentTaskActionRef || undefined,
                 taskTitle: draft.taskTitle.trim(),
                 taskDescription: draft.taskDescription.trim() || undefined,
                 taskPriority: draft.taskPriority,
              });
         await onSubmitted(result.caseVersion, result.replayed, result.accessEpoch);
      } catch (caught) {
         if (caught instanceof TaskaraClientError && caught.status === 409) {
            setPreview(false);
            setConfirmed(false);
            setIdempotencyKey(newHandoffKey());
            setError(/idempotency/i.test(caught.message)
               ? 'شناسه تلاش قبلی با متن دیگری استفاده شده است. یک تلاش تازه ساخته شد؛ متن و مقصد را دوباره بررسی کنید.'
               : supportHandoffConflictMessage());
            await onConflict();
         } else {
            setError(caught instanceof Error ? caught.message : 'ثبت تحویل کار ناموفق بود. برای تلاش دوباره همین درخواست حفظ شده است.');
         }
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={Boolean(mode)} onOpenChange={(open) => !submitting && onOpenChange(open)}>
         <DialogContent dir="rtl" className="max-h-[92vh] overflow-y-auto border-white/10 bg-[#171719] text-zinc-100 sm:max-w-2xl">
            <DialogHeader>
               <DialogTitle>{mode === 'CREATE' ? 'ساخت کار تیمی از پرونده' : 'پیوند کار تیمی موجود'}</DialogTitle>
               <DialogDescription className="leading-6 text-zinc-500">پرونده پشتیبانی <bdi dir="ltr" className="font-mono">{caseKey}</bdi> · فقط متن این فرم به فضای تیمی می‌رود؛ شرح پرونده و مکالمه خودکار کپی نمی‌شود.</DialogDescription>
            </DialogHeader>
            {!preview ? (
               <form className="space-y-4" onSubmit={showPreview}>
                  {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
                  <Field label="مقصد مجاز">
                     <select className={selectClass} required value={draft.targetActionRef} onChange={(event) => selectTarget(event.target.value)}>
                        <option value="">انتخاب فضای تیمی و پروژه</option>
                        {allowedTargets.map((target) => <option key={target.actionRef} value={target.actionRef}>{target.teamWorkspaceName} — {target.project.name} ({target.project.keyPrefix})</option>)}
                     </select>
                  </Field>
                  <Field label="نوع رابطه">
                     <select className={selectClass} value={draft.relationType} onChange={(event) => setDraft((current) => ({ ...current, relationType: event.target.value as SupportTaskRelationType }))}>
                        {supportTaskRelationTypes.map((relation) => <option key={relation} value={relation}>{supportTaskRelationLabels[relation]}</option>)}
                     </select>
                  </Field>
                  <Field label="عنوان تأییدشده تحویل">
                     <Input className={inputClass} maxLength={240} required value={draft.handoffTitle} onChange={(event) => setDraft((current) => ({ ...current, handoffTitle: event.target.value }))} />
                  </Field>
                  <Field label="شرح مسئله و نتیجه مورد انتظار برای تیم">
                     <Textarea className={cn(inputClass, 'min-h-28')} maxLength={20_000} required value={draft.handoffSummary} onChange={(event) => setDraft((current) => ({ ...current, handoffSummary: event.target.value }))} />
                  </Field>

                  {selectedTarget ? (
                     <TaskPicker
                        label={mode === 'LINK' ? 'کار موجود' : 'والد اختیاری (ساخت زیرکار واقعی)'}
                        optional={mode === 'CREATE'}
                        query={taskQuery}
                        searching={searching}
                        tasks={tasks}
                        value={mode === 'LINK' ? draft.taskActionRef : draft.parentTaskActionRef}
                        onQueryChange={setTaskQuery}
                        onSearch={() => void searchTasks()}
                        onValueChange={(value) => setDraft((current) => mode === 'LINK' ? { ...current, taskActionRef: value } : { ...current, parentTaskActionRef: value })}
                     />
                  ) : null}

                  {mode === 'CREATE' ? (
                     <div className="grid gap-4 border-t border-white/6 pt-4 sm:grid-cols-2">
                        <Field className="sm:col-span-2" label="عنوان کار تیمی"><Input className={inputClass} maxLength={240} required value={draft.taskTitle} onChange={(event) => setDraft((current) => ({ ...current, taskTitle: event.target.value }))} /></Field>
                        <Field className="sm:col-span-2" label="جزئیات تکمیلی غیرحساس (اختیاری)"><Textarea className={cn(inputClass, 'min-h-20')} maxLength={50_000} value={draft.taskDescription} onChange={(event) => setDraft((current) => ({ ...current, taskDescription: event.target.value }))} /></Field>
                        <Field label="اولویت"><select className={selectClass} value={draft.taskPriority} onChange={(event) => setDraft((current) => ({ ...current, taskPriority: event.target.value as HandoffDraft['taskPriority'] }))}>{Object.entries(teamTaskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                     </div>
                  ) : null}

                  <div className="rounded-lg border border-sky-400/10 bg-sky-400/[0.035] px-3 py-2.5 text-xs leading-6 text-sky-100/75"><ShieldAlert className="me-1 inline size-4" />اطلاعات تماس، یادداشت خصوصی، فایل، متن تماس و تاریخچه مکالمه را در این فرم وارد نکنید.</div>
                  <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-indigo-400/15 text-indigo-100 hover:bg-indigo-400/25" disabled={!selectedTarget || !validDraft(mode, draft)} type="submit">بررسی پیش‌نمایش <ArrowLeft className="size-4" /></Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
               </form>
            ) : selectedTarget ? (
               <SupportHandoffPreview
                  confirmed={confirmed}
                  draft={draft}
                  mode={mode!}
                  target={selectedTarget}
                  onConfirmedChange={setConfirmed}
                  onEdit={() => { setPreview(false); setConfirmed(false); }}
                  onSubmit={() => void submit()}
                  submitting={submitting}
                  error={error}
               />
            ) : null}
         </DialogContent>
      </Dialog>
   );
}

export function SupportHandoffPreview({
   confirmed,
   draft,
   error = '',
   mode,
   submitting = false,
   target,
   onConfirmedChange = () => undefined,
   onEdit = () => undefined,
   onSubmit = () => undefined,
}: {
   confirmed: boolean;
   draft: HandoffDraft;
   error?: string;
   mode: HandoffMode;
   submitting?: boolean;
   target: SupportCaseWorkTarget;
   onConfirmedChange?: (confirmed: boolean) => void;
   onEdit?: () => void;
   onSubmit?: () => void;
}) {
   return (
      <div className="space-y-4" data-testid="support-handoff-preview">
         {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
         <div className="rounded-lg border border-white/8 bg-black/15 p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline" className="border-indigo-400/20 text-indigo-200">{target.teamWorkspaceName}</Badge><span className="text-zinc-600">پروژه</span><span className="text-zinc-300">{target.project.name}</span><span dir="ltr" className="font-mono text-zinc-600">{target.project.keyPrefix}</span></div>
            <h3 className="mt-4 text-sm font-semibold text-zinc-100">{draft.handoffTitle}</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-8 text-zinc-300">{draft.handoffSummary}</p>
            {mode === 'CREATE' ? <div className="mt-4 border-t border-white/7 pt-4"><div className="text-xs text-zinc-600">کار تازه</div><div className="mt-1 text-sm text-zinc-200">{draft.taskTitle}</div>{draft.taskDescription ? <p className="mt-2 whitespace-pre-wrap text-xs leading-7 text-zinc-400">{draft.taskDescription}</p> : null}</div> : null}
         </div>
         <div className="rounded-lg border border-amber-400/15 bg-amber-400/[0.045] px-3 py-3 text-xs leading-6 text-amber-100/85"><FileWarning className="me-1 inline size-4" />{supportHandoffVisibilityWarning(target.teamWorkspaceName, target.project.name)}<p className="mt-2 border-t border-amber-400/10 pt-2">{supportHandoffIrreversibilityWarning}</p></div>
         <label className="flex items-start gap-2 rounded-lg border border-white/8 px-3 py-3 text-xs leading-6 text-zinc-300"><input checked={confirmed} className="mt-1 size-4 accent-indigo-500" type="checkbox" onChange={(event) => onConfirmedChange(event.target.checked)} /><span>مقصد و متن بالا را بررسی کردم؛ این متن برای مخاطبان پروژه مقصد مناسب است و داده حساس مشتری ندارد.</span></label>
         <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-indigo-400/15 text-indigo-100 hover:bg-indigo-400/25" disabled={!confirmed || submitting} type="button" onClick={onSubmit}>{submitting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} تأیید و ثبت تحویل</Button><Button disabled={submitting} type="button" variant="ghost" onClick={onEdit}>ویرایش متن</Button></DialogFooter>
      </div>
   );
}

function TaskPicker({
   label,
   onQueryChange,
   onSearch,
   onValueChange,
   optional,
   query,
   searching,
   tasks,
   value,
}: {
   label: string;
   onQueryChange: (value: string) => void;
   onSearch: () => void;
   onValueChange: (value: string) => void;
   optional: boolean;
   query: string;
   searching: boolean;
   tasks: SupportHandoffTaskOption[];
   value: string;
}) {
   return (
      <div className="space-y-2 rounded-lg border border-white/7 bg-black/10 p-3">
         <span className="text-xs text-zinc-400">{label}</span>
         <div className="flex gap-2"><Input className={inputClass} placeholder="جست‌وجو با کلید یا عنوان کار" value={query} onChange={(event) => onQueryChange(event.target.value)} /><Button aria-label="جست‌وجوی کار تیمی" className="shrink-0 border border-white/10 bg-white/6" disabled={!query.trim() || searching} size="icon" type="button" variant="secondary" onClick={onSearch}>{searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}</Button></div>
         <select aria-label={label} className={selectClass} required={!optional} value={value} onChange={(event) => onValueChange(event.target.value)}><option value="">{optional ? 'بدون والد — کار مستقل' : 'انتخاب کار موجود'}</option>{tasks.map((task) => <option key={task.actionRef} value={task.actionRef}>{task.key} — {task.title}</option>)}</select>
         <p className="text-[11px] leading-5 text-zinc-600">انتخاب، فقط شناسه عملیاتی را برای ثبت می‌فرستد؛ در پرونده صرفاً کلید، عنوان پاک‌سازی‌شده و وضعیت نمایش داده می‌شود.</p>
      </div>
   );
}

function UnlinkTaskDialog({
   baseVersion,
   caseKey,
   link,
   onConflict,
   onOpenChange,
   onUnlinked,
}: {
   baseVersion: number;
   caseKey: string;
   link: SupportCaseTaskLinkProjection | null;
   onConflict: () => Promise<void>;
   onOpenChange: (open: boolean) => void;
   onUnlinked: (version: number, replayed: boolean, accessEpoch?: string | number) => Promise<void>;
}) {
   const [reason, setReason] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');

   useEffect(() => {
      if (!link) return;
      setReason('');
      setError('');
   }, [link]);

   async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!link || !reason.trim() || submitting) return;
      setSubmitting(true);
      setError('');
      try {
         const result = await supportHandoffClient.unlinkTask(caseKey, link.linkId, { reason: reason.trim(), baseVersion });
         await onUnlinked(result.caseVersion, result.replayed, result.accessEpoch);
      } catch (caught) {
         if (caught instanceof TaskaraClientError && caught.status === 409) await onConflict();
         else setError(caught instanceof Error ? caught.message : 'برداشتن پیوند ناموفق بود.');
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={Boolean(link)} onOpenChange={(open) => !submitting && onOpenChange(open)}>
         <DialogContent dir="rtl" className="border-white/10 bg-[#171719] text-zinc-100">
            <DialogHeader><DialogTitle>برداشتن پیوند کار تیمی</DialogTitle><DialogDescription className="leading-6 text-zinc-500"><bdi dir="ltr" className="font-mono">{link?.taskKey}</bdi> · این کار پرونده یا کار تیمی را حذف نمی‌کند.</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={submit}>
               {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
               <div className="rounded-lg border border-amber-400/15 bg-amber-400/[0.045] px-3 py-2.5 text-xs leading-6 text-amber-100/80">{supportHandoffIrreversibilityWarning}</div>
               <Field label="دلیل برداشتن پیوند"><Textarea className={inputClass} maxLength={1000} required value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
               <DialogFooter className="sm:flex-row-reverse sm:justify-start"><Button className="bg-red-500/20 text-red-100 hover:bg-red-500/30" disabled={!reason.trim() || submitting} type="submit">{submitting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} برداشتن پیوند</Button><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>انصراف</Button></DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function TaskLinkStateIcon({ state }: { state: ReturnType<typeof supportTaskLinkState> }) {
   const className = 'mt-0.5 size-4 shrink-0';
   if (state === 'TASK_DELETED') return <CircleOff className={cn(className, 'text-red-300')} />;
   if (state === 'CONNECTION_REVOKED') return <Unplug className={cn(className, 'text-amber-300')} />;
   if (state === 'UNLINKED') return <CircleOff className={cn(className, 'text-zinc-600')} />;
   return <Link2 className={cn(className, 'text-indigo-300')} />;
}

function validDraft(mode: HandoffMode | null, draft: HandoffDraft): boolean {
   if (!mode || !draft.targetActionRef || !draft.handoffTitle.trim() || !draft.handoffSummary.trim()) return false;
   if (mode === 'LINK') return Boolean(draft.taskActionRef);
   return Boolean(draft.taskTitle.trim());
}

function newHandoffKey(): string {
   return `web-handoff-${crypto.randomUUID()}`;
}

function taskStatusLabel(status: string): string {
   const labels: Record<string, string> = {
      BACKLOG: 'صف',
      TODO: 'برای انجام',
      IN_PROGRESS: 'در حال انجام',
      IN_REVIEW: 'در بازبینی',
      BLOCKED: 'مسدود',
      DONE: 'انجام‌شده',
      CANCELED: 'لغوشده',
   };
   return labels[status] || status;
}

function Field({ children, className, label }: { children: React.ReactNode; className?: string; label: string }) {
   return <label className={cn('grid gap-1.5 text-xs text-zinc-400', className)}><span>{label}</span>{children}</label>;
}

function InlineMessage({ children, tone }: { children: React.ReactNode; tone: 'error' | 'success' }) {
   return <p role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-lg border px-3 py-2.5 text-xs leading-6', tone === 'error' ? 'border-red-400/20 bg-red-400/8 text-red-200' : 'border-lime-400/15 bg-lime-400/[0.045] text-lime-200')}>{tone === 'error' ? <AlertTriangle className="me-1 inline size-3.5" /> : <CheckCircle2 className="me-1 inline size-3.5" />}{children}</p>;
}

const inputClass = 'border-white/10 bg-[#0c0c0e] text-zinc-100 placeholder:text-zinc-600 shadow-none focus-visible:border-indigo-400/50 focus-visible:ring-indigo-400/20';
const selectClass = 'h-9 w-full rounded-md border border-white/10 bg-[#0c0c0e] px-3 text-sm text-zinc-200 outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-400/20';
