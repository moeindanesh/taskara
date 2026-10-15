'use client';

import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CircleDot, Loader2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { LinearAvatar, ProjectGlyph } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   GoalPeriod,
   TaskaraMilestone,
   TaskaraMilestoneHealth,
   TaskaraMilestoneKind,
   TaskaraProject,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { MilestoneDatePicker } from './milestone-date-picker';
import { MilestoneGlyph } from './primitives';
import { goalPeriodLabels, goalPeriodRange } from './goal-period';
import { useOnlineStatus } from './use-online-status';

type MilestoneCreateForm = {
   period: GoalPeriod;
   description: string;
   health: TaskaraMilestoneHealth | '';
   kind: TaskaraMilestoneKind;
   name: string;
   ownerId: string;
   projectId: string;
   startsOn: string;
   status: 'PLANNED' | 'ACTIVE';
   targetOn: string;
};

type MilestoneOwnerCandidate = {
   avatarUrl?: string | null;
   email: string;
   id: string;
   name: string;
};

function emptyForm(
   kind: TaskaraMilestoneKind = 'FEATURE',
   period: GoalPeriod = 'WEEKLY'
): MilestoneCreateForm {
   return {
      period,
      description: '',
      health: '',
      kind,
      name: '',
      ownerId: '',
      projectId: '',
      startsOn: goalPeriodRange(period).startsOn,
      status: 'PLANNED',
      targetOn: goalPeriodRange(period).targetOn,
   };
}

export function MilestoneCreateDialog({
   currentUserId,
   initialKind = 'FEATURE',
   initialPeriod = 'WEEKLY',
   initialStartsOn,
   initialTargetOn,
   initialProjectId,
   milestones,
   open,
   projects,
   onCreated,
   onOpenChange,
}: {
   currentUserId?: string | null;
   initialKind?: TaskaraMilestoneKind;
   initialPeriod?: GoalPeriod;
   initialStartsOn?: string;
   initialTargetOn?: string;
   initialProjectId?: string | null;
   milestones: TaskaraMilestone[];
   open: boolean;
   projects: TaskaraProject[];
   onCreated: (milestone: TaskaraMilestone) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const taskSync = useWorkspaceTaskSync();
   const [form, setForm] = useState<MilestoneCreateForm>(() =>
      emptyForm(initialKind, initialPeriod)
   );
   const [submitting, setSubmitting] = useState(false);
   const [ownerCandidates, setOwnerCandidates] = useState<MilestoneOwnerCandidate[]>([]);
   const [ownersLoading, setOwnersLoading] = useState(false);
   const [inlineError, setInlineError] = useState('');
   const online = useOnlineStatus();
   const wasOpenRef = useRef(false);
   const selectedProject = projects.find((project) => project.id === form.projectId) || null;
   const exactDuplicate = useMemo(
      () =>
         milestones.find(
            (milestone) =>
               milestone.projectId === form.projectId &&
               milestone.name.trim().toLocaleLowerCase('fa') ===
                  form.name.trim().toLocaleLowerCase('fa')
         ) || null,
      [form.name, form.projectId, milestones]
   );
   const invalidDates = Boolean(form.startsOn && form.targetOn && form.targetOn < form.startsOn);

   useEffect(() => {
      if (open && !wasOpenRef.current) {
         const sessionProjectId = readLastProjectId();
         const projectId = projects.some((project) => project.id === initialProjectId)
            ? initialProjectId || ''
            : projects.some((project) => project.id === sessionProjectId)
              ? sessionProjectId
              : projects[0]?.id || '';
         const project = projects.find((item) => item.id === projectId) || null;
         setForm({
            ...emptyForm(initialKind, initialPeriod),
            ...(initialStartsOn && initialTargetOn
               ? { startsOn: initialStartsOn, targetOn: initialTargetOn }
               : {}),
            projectId,
            ownerId: project?.lead?.id || currentUserId || '',
         });
         setInlineError('');
      }
      wasOpenRef.current = open;
   }, [
      currentUserId,
      initialKind,
      initialPeriod,
      initialStartsOn,
      initialTargetOn,
      initialProjectId,
      open,
      projects,
   ]);

   useEffect(() => {
      if (!open || !form.projectId) {
         setOwnerCandidates([]);
         return;
      }
      let canceled = false;
      setOwnersLoading(true);
      const params = new URLSearchParams({ projectId: form.projectId, limit: '200' });
      void taskaraRequest<{ items: MilestoneOwnerCandidate[]; total: number }>(
         `/milestones/owner-candidates?${params.toString()}`
      )
         .then((result) => {
            if (!canceled) {
               setOwnerCandidates(result.items);
               setForm((current) => {
                  if (current.projectId !== form.projectId) return current;
                  if (
                     current.ownerId &&
                     result.items.some((candidate) => candidate.id === current.ownerId)
                  )
                     return current;
                  const project = projects.find((item) => item.id === current.projectId);
                  const nextOwnerId = result.items.some(
                     (candidate) => candidate.id === project?.lead?.id
                  )
                     ? project?.lead?.id || ''
                     : result.items.some((candidate) => candidate.id === currentUserId)
                       ? currentUserId || ''
                       : '';
                  return { ...current, ownerId: nextOwnerId };
               });
            }
         })
         .catch(() => {
            if (!canceled) setOwnerCandidates([]);
         })
         .finally(() => {
            if (!canceled) setOwnersLoading(false);
         });

      return () => {
         canceled = true;
      };
   }, [currentUserId, form.projectId, open, projects]);

   function handleProjectChange(projectId: string) {
      const previousProject = projects.find((project) => project.id === form.projectId);
      const project = projects.find((item) => item.id === projectId);
      setForm((current) => ({
         ...current,
         projectId,
         ownerId:
            !current.ownerId ||
            current.ownerId === previousProject?.lead?.id ||
            current.ownerId === currentUserId
               ? project?.lead?.id || currentUserId || ''
               : current.ownerId,
      }));
      setInlineError('');
   }

   async function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!form.name.trim() || !form.projectId || !form.kind) {
         setInlineError(fa.milestone.nameRequired);
         return;
      }
      if (invalidDates) {
         setInlineError(fa.milestone.invalidDates);
         return;
      }

      setSubmitting(true);
      setInlineError('');
      try {
         const created = await taskSync.createMilestone({
            projectId: form.projectId,
            name: form.name.trim(),
            kind: form.kind,
            period: form.period,
            status: form.status,
            ownerId: form.ownerId || null,
            description: form.description.trim() || null,
            health: form.health || null,
            startsOn: form.startsOn || null,
            targetOn: form.targetOn || null,
         });
         rememberLastProjectId(form.projectId);
         if (created.syncState === 'pending')
            toast.info('هدف ساخته شد و پس از اتصال همگام می‌شود.');
         else toast.success(fa.milestone.created);
         onCreated(created);
         onOpenChange(false);
      } catch (error) {
         const message = error instanceof Error ? error.message : fa.milestone.createFailed;
         setInlineError(message);
         toast.error(fa.milestone.createFailed);
      } finally {
         setSubmitting(false);
      }
   }

   return (
      <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
         <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[920px] flex-col gap-0 overflow-hidden rounded-2xl border-border bg-popover p-0 text-popover-foreground shadow-2xl [direction:rtl]">
            <DialogHeader className="shrink-0 px-5 py-5 pe-12 text-right sm:px-8 sm:pe-12">
               <DialogTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
                  <ProjectGlyph
                     name={selectedProject?.name || 'پروژه'}
                     className="size-5 rounded"
                  />
                  <span className="min-w-0 truncate">{selectedProject?.name || 'پروژه'}</span>
                  <span>/</span>
                  <span className="shrink-0">هدف جدید</span>
               </DialogTitle>
               <DialogDescription className="sr-only">
                  یک نتیجه هفتگی یا ماهانه برای تیم تعریف کنید و کارها را زیر آن قرار دهید.
               </DialogDescription>
            </DialogHeader>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
               <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-3 sm:px-8">
                  <MilestoneGlyph className="mb-5 size-11 rounded-xl bg-muted text-foreground dark:text-foreground [&>svg]:size-6" />
                  <Input
                     autoFocus
                     aria-label={fa.milestone.name}
                     maxLength={160}
                     className="h-auto rounded-none border-0 bg-transparent px-0 text-2xl font-semibold shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 sm:text-3xl"
                     placeholder="چه نتیجه‌ای می‌خواهیم؟"
                     value={form.name}
                     onChange={(event) => {
                        setForm((current) => ({ ...current, name: event.target.value }));
                        setInlineError('');
                     }}
                  />
                  {exactDuplicate ? (
                     <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        {fa.milestone.duplicateName}
                     </p>
                  ) : null}
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                     نتیجه‌ای مشخص که در پایان دوره بتوانیم درباره‌اش گزارش بدهیم.
                  </p>

                  <div
                     className="mt-7 flex flex-wrap items-center gap-2"
                     aria-label="ویژگی‌های هدف جدید"
                  >
                     <Select value={form.projectId} onValueChange={handleProjectChange}>
                        <SelectTrigger
                           aria-label={fa.milestone.project}
                           className="h-9 w-auto max-w-full rounded-full bg-muted/40 text-xs"
                        >
                           <SelectValue placeholder={fa.milestone.selectProject} />
                        </SelectTrigger>
                        <SelectContent className="[direction:rtl]">
                           {projects.map((project) => (
                              <SelectItem key={project.id} value={project.id}>
                                 {project.name}
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                     <Select
                        value={form.status}
                        onValueChange={(status) =>
                           setForm((current) => ({
                              ...current,
                              status: status as 'PLANNED' | 'ACTIVE',
                           }))
                        }
                     >
                        <SelectTrigger
                           aria-label={fa.milestone.status}
                           className="h-9 w-auto rounded-full bg-muted/40 text-xs"
                        >
                           <CircleDot className="size-3.5 text-amber-500" />
                           <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="[direction:rtl]">
                           <SelectItem value="PLANNED">{fa.milestone.planned}</SelectItem>
                           <SelectItem value="ACTIVE">{fa.milestone.active}</SelectItem>
                        </SelectContent>
                     </Select>
                     <Select
                        disabled={!form.projectId || ownersLoading}
                        value={toSelectValue(form.ownerId)}
                        onValueChange={(value) =>
                           setForm((current) => ({ ...current, ownerId: fromSelectValue(value) }))
                        }
                     >
                        <SelectTrigger
                           aria-label={fa.milestone.owner}
                           className="h-9 w-auto max-w-full rounded-full bg-muted/40 text-xs"
                        >
                           <UserRound className="size-3.5" />
                           <SelectValue placeholder={fa.milestone.noOwner} />
                        </SelectTrigger>
                        <SelectContent className="[direction:rtl]">
                           <SelectItem value={EMPTY_SELECT_VALUE}>
                              {fa.milestone.noOwner}
                           </SelectItem>
                           {ownerCandidates.map((candidate) => (
                              <SelectItem key={candidate.id} value={candidate.id}>
                                 <span className="flex items-center gap-2">
                                    <LinearAvatar
                                       className="size-5"
                                       name={candidate.name}
                                       src={candidate.avatarUrl}
                                    />
                                    {candidate.name}
                                 </span>
                              </SelectItem>
                           ))}
                        </SelectContent>
                     </Select>
                  </div>

                  <div className="my-6 rounded-xl border border-border/70 bg-muted/20 p-4">
                     <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                           <CalendarDays className="size-4" />
                           دوره هدف
                        </span>
                        <div className="flex flex-wrap gap-1" role="group" aria-label="دوره هدف">
                           {(Object.entries(goalPeriodLabels) as Array<[GoalPeriod, string]>).map(
                              ([period, label]) => (
                                 <button
                                    type="button"
                                    key={period}
                                    aria-pressed={form.period === period}
                                    className={cn(
                                       'min-h-9 rounded-lg px-3 text-xs transition',
                                       form.period === period
                                          ? 'bg-foreground text-background'
                                          : 'text-muted-foreground hover:bg-muted'
                                    )}
                                    onClick={() =>
                                       setForm((current) => ({
                                          ...current,
                                          period,
                                          ...(period === 'CUSTOM' ? {} : goalPeriodRange(period)),
                                       }))
                                    }
                                 >
                                    {label}
                                 </button>
                              )
                           )}
                        </div>
                     </div>
                     <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <FieldLabel label={fa.milestone.startDate}>
                           <MilestoneDatePicker
                              ariaLabel={fa.milestone.startDate}
                              value={form.startsOn}
                              onChange={(startsOn) =>
                                 setForm((current) => ({ ...current, startsOn: startsOn || '' }))
                              }
                           />
                        </FieldLabel>
                        <FieldLabel label={fa.milestone.targetDate}>
                           <MilestoneDatePicker
                              ariaLabel={fa.milestone.targetDate}
                              value={form.targetOn}
                              onChange={(targetOn) =>
                                 setForm((current) => ({ ...current, targetOn: targetOn || '' }))
                              }
                           />
                        </FieldLabel>
                     </div>
                  </div>
                  <Textarea
                     aria-label="نتیجه مورد انتظار"
                     maxLength={15000}
                     className="min-h-40 resize-y rounded-none border-0 bg-transparent px-0 text-sm leading-7 shadow-none focus-visible:ring-0"
                     placeholder="نتیجه مورد انتظار، معیار موفقیت و نکاتی که تیم باید بداند…"
                     value={form.description}
                     onChange={(event) =>
                        setForm((current) => ({ ...current, description: event.target.value }))
                     }
                  />
                  <p className="flex items-center gap-2 border-t border-border/60 pt-4 text-xs leading-6 text-muted-foreground">
                     <MilestoneGlyph className="size-5 shrink-0" />
                     بعد از ساخت هدف، کارهای تیم را به آن اضافه کنید.
                  </p>
                  {invalidDates || inlineError ? (
                     <p role="alert" className="mt-3 text-xs text-destructive">
                        {inlineError || fa.milestone.invalidDates}
                     </p>
                  ) : null}
                  {!online ? (
                     <p className="mt-3 text-xs text-muted-foreground">
                        هدف پس از اتصال همگام می‌شود.
                     </p>
                  ) : null}
               </div>
               <DialogFooter className="shrink-0 flex-row border-t border-border/70 bg-muted/15 px-6 py-4 sm:px-8">
                  <Button
                     type="button"
                     variant="ghost"
                     disabled={submitting}
                     onClick={() => onOpenChange(false)}
                  >
                     {fa.app.cancel}
                  </Button>
                  <Button
                     type="submit"
                     disabled={submitting || !form.name.trim() || !form.projectId || invalidDates}
                     className="rounded-full bg-indigo-600 px-5 text-white hover:bg-indigo-500"
                  >
                     {submitting ? <Loader2 className="size-4 animate-spin" /> : null}ساخت هدف
                  </Button>
               </DialogFooter>
            </form>
         </DialogContent>
      </Dialog>
   );
}

function FieldLabel({ children, label }: { children: React.ReactNode; label: string }) {
   return (
      <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
         <span>{label}</span>
         {children}
      </label>
   );
}

const lastProjectSessionKey = 'taskara:milestones:last-project';

function readLastProjectId() {
   try {
      return window.sessionStorage.getItem(lastProjectSessionKey) || '';
   } catch {
      return '';
   }
}

function rememberLastProjectId(projectId: string) {
   try {
      window.sessionStorage.setItem(lastProjectSessionKey, projectId);
   } catch {
      // Session-only convenience must never block milestone creation.
   }
}
