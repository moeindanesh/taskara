'use client';

import { useEffect, useMemo, useState } from 'react';
import { Archive, ArrowLeftRight, Check, Loader2, RotateCcw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { fa } from '@/lib/fa-copy';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import type { TaskaraMilestone, TaskaraMilestoneLifecycleInput } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { MilestoneProgress, milestoneStatusMeta } from './primitives';
import { useOnlineStatus } from './use-online-status';

export type MilestoneLifecycleAction =
   | 'activate'
   | 'complete'
   | 'reopen'
   | 'cancel'
   | 'archive'
   | 'restore';

type UnfinishedPolicy = 'KEEP' | 'MOVE' | 'UNASSIGN';

export function MilestoneLifecycleDialog({
   action,
   milestone,
   openMilestones,
   onChanged,
   onOpenChange,
}: {
   action: MilestoneLifecycleAction | null;
   milestone: TaskaraMilestone;
   openMilestones: TaskaraMilestone[];
   onChanged: (milestone: TaskaraMilestone) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const taskSync = useWorkspaceTaskSync();
   const [policy, setPolicy] = useState<UnfinishedPolicy | ''>('');
   const [targetMilestoneId, setTargetMilestoneId] = useState('');
   const [note, setNote] = useState('');
   const [submitting, setSubmitting] = useState(false);
   const [error, setError] = useState('');
   const online = useOnlineStatus();
   const unfinishedCount = Math.max(0, milestone.progress.eligibleTasks - milestone.progress.completedTasks);
   const isFinishAction = action === 'complete' || action === 'cancel';
   const moveTargets = useMemo(
      () => openMilestones.filter((item) =>
         item.id !== milestone.id &&
         item.projectId === milestone.projectId &&
         !item.archivedAt &&
         (item.status === 'PLANNED' || item.status === 'ACTIVE')
      ),
      [milestone.id, milestone.projectId, openMilestones]
   );

   useEffect(() => {
      if (!action) return;
      setPolicy('');
      setTargetMilestoneId('');
      setNote('');
      setError('');
   }, [action]);

   if (!action) return null;

   const actionName = action;
   const meta = lifecycleActionMeta(actionName, milestone);
   const canSubmit = !submitting && (
      !isFinishAction ||
      unfinishedCount === 0 ||
      Boolean(policy && (policy !== 'MOVE' || targetMilestoneId))
   );

   async function submit() {
      if (!canSubmit) return;
      setSubmitting(true);
      setError('');
      try {
         const body: TaskaraMilestoneLifecycleInput = isFinishAction
            ? {
                 ...(unfinishedCount > 0 ? { unfinishedTaskPolicy: policy as UnfinishedPolicy } : {}),
                 ...(policy === 'MOVE' ? { targetMilestoneId } : {}),
                 note: note.trim() || null,
              }
            : {};
         const updated = await taskSync.transitionMilestone(milestone, actionName, body);
         onChanged(updated);
         onOpenChange(false);
      } catch (submitError) {
         setError(submitError instanceof Error ? submitError.message : fa.milestone.lifecycleActionFailed);
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open onOpenChange={(next) => !submitting && onOpenChange(next)}>
         <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[620px] overflow-y-auto border-border bg-popover text-popover-foreground [direction:rtl]">
            <DialogHeader className="text-right">
               <DialogTitle className="flex items-center gap-2">
                  <span className={cn('inline-flex size-8 items-center justify-center rounded-lg', meta.tone)}>
                     <meta.icon className="size-4" />
                  </span>
                  {meta.title}
               </DialogTitle>
               <DialogDescription className="text-right leading-6">
                  {meta.description}
               </DialogDescription>
            </DialogHeader>

            {isFinishAction ? (
               <div className="space-y-4">
                  <div className="rounded-xl border border-border/70 bg-card/60 p-4">
                     <MilestoneProgress milestone={milestone} />
                     <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                        <LifecycleStat label={fa.milestone.unfinishedTasks} value={unfinishedCount} />
                        <LifecycleStat label={fa.milestone.blockedTasks} value={milestone.progress.blockedTasks} />
                        <LifecycleStat label={fa.milestone.overdueTasks} value={milestone.progress.overdueTasks} />
                     </div>
                  </div>

                  {unfinishedCount > 0 ? (
                     <fieldset className="space-y-2">
                        <legend className="mb-2 text-sm font-medium">{fa.milestone.chooseUnfinishedPolicy}</legend>
                        <PolicyCard
                           checked={policy === 'KEEP'}
                           description={fa.milestone.keepTasksDescription}
                           icon={Archive}
                           label={fa.milestone.keepTasks}
                           value="KEEP"
                           onChange={() => setPolicy('KEEP')}
                        />
                        <PolicyCard
                           checked={policy === 'MOVE'}
                           description={fa.milestone.moveTasksDescription}
                           disabled={moveTargets.length === 0}
                           icon={ArrowLeftRight}
                           label={fa.milestone.moveTasks}
                           value="MOVE"
                           onChange={() => setPolicy('MOVE')}
                        />
                        {policy === 'MOVE' ? (
                           <div className="mr-10 rounded-lg border border-border/70 bg-background/50 p-2">
                              {moveTargets.length ? (
                                 <Select value={targetMilestoneId} onValueChange={setTargetMilestoneId}>
                                    <SelectTrigger aria-label={fa.milestone.targetMilestone} className="h-9 bg-card">
                                       <SelectValue placeholder={fa.milestone.targetMilestone} />
                                    </SelectTrigger>
                                    <SelectContent className="[direction:rtl]">
                                       {moveTargets.map((target) => {
                                          const status = milestoneStatusMeta[target.status];
                                          return (
                                             <SelectItem key={target.id} value={target.id}>
                                                <span className="flex items-center gap-2">
                                                   <status.icon className="size-3.5" />
                                                   <span>{target.name}</span>
                                                   <span className="text-[10px] text-muted-foreground">{status.label}</span>
                                                </span>
                                             </SelectItem>
                                          );
                                       })}
                                    </SelectContent>
                                 </Select>
                              ) : (
                                 <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">گام باز دیگری در این پروژه وجود ندارد.</p>
                              )}
                           </div>
                        ) : null}
                        <PolicyCard
                           checked={policy === 'UNASSIGN'}
                           description={fa.milestone.unassignTasksDescription}
                           icon={Unlink}
                           label={fa.milestone.unassignTasks}
                           value="UNASSIGN"
                           onChange={() => setPolicy('UNASSIGN')}
                        />
                     </fieldset>
                  ) : (
                     <div className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/8 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">
                        <Check className="size-4" />
                        همه کارهای مشمول تکمیل شده‌اند؛ وضعیت کارها تغییر نمی‌کند.
                     </div>
                  )}

                  <label className="grid gap-1.5 text-xs text-muted-foreground">
                     {fa.milestone.completionNote}
                     <Textarea
                        className="min-h-24 resize-y bg-card text-sm text-foreground"
                        maxLength={5000}
                        placeholder={fa.milestone.completionNotePlaceholder}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                     />
                  </label>
               </div>
            ) : action === 'archive' ? (
               <div className="rounded-xl border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-sm leading-6 text-amber-700 dark:text-amber-200">
                  {fa.milestone.archiveDescription}
               </div>
            ) : null}

            {error ? (
               <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive-foreground" role="alert">
                  {error}
               </p>
            ) : null}
            {!online ? (
               <p className="rounded-lg border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-200" role="status">
                  آفلاین هستید. این تصمیم در صف امن همگام‌سازی می‌ماند و پس از اتصال روی سرور بررسی می‌شود.
               </p>
            ) : null}

            <DialogFooter className="flex-row justify-end gap-2 sm:justify-end">
               <Button disabled={submitting} type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  {fa.app.cancel}
               </Button>
               <Button
                  className={cn(meta.buttonTone)}
                  disabled={!canSubmit}
                  type="button"
                  onClick={() => void submit()}
               >
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : <meta.icon className="size-4" />}
                  {meta.confirmLabel}
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}

function PolicyCard({
   checked,
   description,
   disabled = false,
   icon: Icon,
   label,
   value,
   onChange,
}: {
   checked: boolean;
   description: string;
   disabled?: boolean;
   icon: typeof Archive;
   label: string;
   value: UnfinishedPolicy;
   onChange: () => void;
}) {
   return (
      <label className={cn(
         'flex min-h-16 cursor-pointer items-start gap-3 rounded-xl border p-3 transition focus-within:ring-2 focus-within:ring-indigo-400/60',
         checked ? 'border-indigo-400/35 bg-indigo-400/10' : 'border-border/70 bg-card/40 hover:bg-muted/60',
         disabled && 'cursor-not-allowed opacity-45'
      )}>
         <input
            checked={checked}
            className="mt-1 size-4 accent-indigo-500"
            disabled={disabled}
            name="unfinished-policy"
            type="radio"
            value={value}
            onChange={onChange}
         />
         <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
         <span className="min-w-0">
            <span className="block text-sm font-medium">{label}</span>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
         </span>
      </label>
   );
}

function LifecycleStat({ label, value }: { label: string; value: number }) {
   return (
      <div className="rounded-lg bg-muted/55 px-2 py-2">
         <strong className="block text-base tabular-nums">{value.toLocaleString('fa-IR')}</strong>
         <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{label}</span>
      </div>
   );
}

function lifecycleActionMeta(action: MilestoneLifecycleAction, milestone: TaskaraMilestone) {
   const isReactivate = action === 'activate' && milestone.status === 'CANCELED';
   const entries = {
      activate: {
         buttonTone: 'bg-indigo-500 text-white hover:bg-indigo-400',
         confirmLabel: isReactivate ? fa.milestone.reactivate : fa.milestone.activate,
         description: isReactivate
            ? 'گام به وضعیت فعال برمی‌گردد و تاریخ لغو پاک می‌شود.'
            : 'گام برای اجرای روزانه فعال می‌شود.',
         icon: RotateCcw,
         title: isReactivate ? fa.milestone.reactivate : fa.milestone.activate,
         tone: 'bg-indigo-400/10 text-indigo-600 dark:text-indigo-300',
      },
      complete: {
         buttonTone: 'bg-emerald-500 text-white hover:bg-emerald-400',
         confirmLabel: fa.milestone.complete,
         description: fa.milestone.finishDescription,
         icon: Check,
         title: fa.milestone.completeTitle,
         tone: 'bg-emerald-400/10 text-emerald-700 dark:text-emerald-300',
      },
      reopen: {
         buttonTone: 'bg-indigo-500 text-white hover:bg-indigo-400',
         confirmLabel: fa.milestone.reopen,
         description: 'گام تکمیل‌شده دوباره فعال می‌شود؛ پیوند کارها حفظ می‌شود.',
         icon: RotateCcw,
         title: fa.milestone.reopen,
         tone: 'bg-indigo-400/10 text-indigo-600 dark:text-indigo-300',
      },
      cancel: {
         buttonTone: 'bg-rose-500 text-white hover:bg-rose-400',
         confirmLabel: fa.milestone.cancelMilestone,
         description: fa.milestone.finishDescription,
         icon: Unlink,
         title: fa.milestone.cancelTitle,
         tone: 'bg-rose-400/10 text-rose-600 dark:text-rose-300',
      },
      archive: {
         buttonTone: 'bg-amber-500 text-amber-950 hover:bg-amber-400',
         confirmLabel: fa.milestone.archive,
         description: fa.milestone.archiveDescription,
         icon: Archive,
         title: fa.milestone.archive,
         tone: 'bg-amber-400/10 text-amber-700 dark:text-amber-300',
      },
      restore: {
         buttonTone: 'bg-indigo-500 text-white hover:bg-indigo-400',
         confirmLabel: fa.milestone.restore,
         description: 'گام به فهرست بازمی‌گردد و وضعیت قبلی آن حفظ می‌شود.',
         icon: RotateCcw,
         title: fa.milestone.restore,
         tone: 'bg-indigo-400/10 text-indigo-600 dark:text-indigo-300',
      },
   } as const;
   return entries[action];
}
