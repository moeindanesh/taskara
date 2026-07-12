'use client';

import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Sparkles } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { LinearAvatar, ProjectGlyph } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   TaskaraMilestone,
   TaskaraMilestoneHealth,
   TaskaraMilestoneKind,
   TaskaraProject,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { MilestoneDatePicker } from './milestone-date-picker';
import { MilestoneGlyph, milestoneHealthMeta, milestoneKindMeta } from './primitives';
import { useOnlineStatus } from './use-online-status';

type MilestoneCreateForm = {
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

function emptyForm(kind: TaskaraMilestoneKind = 'FEATURE'): MilestoneCreateForm {
   return {
      description: '',
      health: '',
      kind,
      name: '',
      ownerId: '',
      projectId: '',
      startsOn: '',
      status: 'PLANNED',
      targetOn: '',
   };
}

export function MilestoneCreateDialog({
   currentUserId,
   initialKind = 'FEATURE',
   initialProjectId,
   milestones,
   open,
   projects,
   onCreated,
   onOpenChange,
}: {
   currentUserId?: string | null;
   initialKind?: TaskaraMilestoneKind;
   initialProjectId?: string | null;
   milestones: TaskaraMilestone[];
   open: boolean;
   projects: TaskaraProject[];
   onCreated: (milestone: TaskaraMilestone) => void;
   onOpenChange: (open: boolean) => void;
}) {
   const taskSync = useWorkspaceTaskSync();
   const [form, setForm] = useState<MilestoneCreateForm>(() => emptyForm(initialKind));
   const [showMore, setShowMore] = useState(false);
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
               milestone.name.trim().toLocaleLowerCase('fa') === form.name.trim().toLocaleLowerCase('fa')
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
            ...emptyForm(initialKind),
            projectId,
            ownerId: project?.lead?.id || currentUserId || '',
         });
         setShowMore(false);
         setInlineError('');
      }
      wasOpenRef.current = open;
   }, [currentUserId, initialKind, initialProjectId, open, projects]);

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
                  if (current.ownerId && result.items.some((candidate) => candidate.id === current.ownerId)) return current;
                  const project = projects.find((item) => item.id === current.projectId);
                  const nextOwnerId = result.items.some((candidate) => candidate.id === project?.lead?.id)
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
            !current.ownerId || current.ownerId === previousProject?.lead?.id || current.ownerId === currentUserId
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
            status: form.status,
            ownerId: form.ownerId || null,
            description: form.description.trim() || null,
            health: form.health || null,
            startsOn: form.startsOn || null,
            targetOn: form.targetOn || null,
         });
         rememberLastProjectId(form.projectId);
         if (created.syncState === 'pending') toast.info('گام ساخته شد و پس از اتصال همگام می‌شود.');
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
         <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[760px] flex-col gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground shadow-2xl [direction:rtl]">
            <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 text-right">
               <DialogTitle className="flex items-center gap-2 text-sm">
                  <MilestoneGlyph className="size-6 rounded-md" />
                  {fa.milestone.newMilestone}
               </DialogTitle>
               <DialogDescription className="mt-1 text-xs leading-5 text-muted-foreground">
                  {fa.milestone.createDescription}
               </DialogDescription>
            </DialogHeader>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
               <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                  <div className="flex items-start gap-3">
                     <MilestoneGlyph className="mt-1 size-9" />
                     <div className="min-w-0 flex-1">
                        <Input
                           autoFocus
                           className="h-auto border-none bg-transparent px-0 text-xl font-semibold text-foreground shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
                           placeholder={fa.milestone.namePlaceholder}
                           value={form.name}
                           onChange={(event) => {
                              setForm((current) => ({ ...current, name: event.target.value }));
                              setInlineError('');
                           }}
                        />
                        {exactDuplicate ? (
                           <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{fa.milestone.duplicateName}</p>
                        ) : null}
                     </div>
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                     <FieldLabel label={fa.milestone.project}>
                        <Select value={form.projectId} onValueChange={handleProjectChange}>
                           <SelectTrigger className="h-9 border-border/70 bg-card text-foreground">
                              <SelectValue placeholder={fa.milestone.selectProject} />
                           </SelectTrigger>
                           <SelectContent className="rounded-xl border-border bg-popover text-popover-foreground [direction:rtl]">
                              {projects.map((project) => (
                                 <SelectItem className="rounded-lg" key={project.id} value={project.id}>
                                    <span className="flex min-w-0 items-center gap-2">
                                       <ProjectGlyph name={project.name} className="size-5 rounded" iconClassName="size-3.5" />
                                       <span className="truncate">{project.name}</span>
                                       <span className="ltr text-[10px] text-muted-foreground">{project.keyPrefix}</span>
                                    </span>
                                 </SelectItem>
                              ))}
                           </SelectContent>
                        </Select>
                     </FieldLabel>
                     <FieldLabel label={fa.milestone.kind}>
                        <Select
                           value={form.kind}
                           onValueChange={(kind) => setForm((current) => ({ ...current, kind: kind as TaskaraMilestoneKind }))}
                        >
                           <SelectTrigger className="h-9 border-border/70 bg-card text-foreground">
                              <SelectValue />
                           </SelectTrigger>
                           <SelectContent className="rounded-xl border-border bg-popover text-popover-foreground [direction:rtl]">
                              {(Object.entries(milestoneKindMeta) as Array<[TaskaraMilestoneKind, (typeof milestoneKindMeta)[TaskaraMilestoneKind]]>).map(([value, meta]) => {
                                 const Icon = meta.icon;
                                 return (
                                    <SelectItem className="rounded-lg" key={value} value={value}>
                                       <span className="flex items-center gap-2">
                                          <Icon className="size-3.5" />
                                          {meta.label}
                                       </span>
                                    </SelectItem>
                                 );
                              })}
                           </SelectContent>
                        </Select>
                     </FieldLabel>
                     <FieldLabel label={fa.milestone.owner}>
                        <Select
                           disabled={!form.projectId || ownersLoading}
                           value={toSelectValue(form.ownerId)}
                           onValueChange={(value) => setForm((current) => ({ ...current, ownerId: fromSelectValue(value) }))}
                        >
                           <SelectTrigger className="h-9 border-border/70 bg-card text-foreground">
                              <SelectValue placeholder={ownersLoading ? fa.app.loading : fa.milestone.noOwner} />
                           </SelectTrigger>
                           <SelectContent className="rounded-xl border-border bg-popover text-popover-foreground [direction:rtl]">
                              <SelectItem className="rounded-lg" value={EMPTY_SELECT_VALUE}>{fa.milestone.noOwner}</SelectItem>
                              {ownerCandidates.map((candidate) => (
                                 <SelectItem className="rounded-lg" key={candidate.id} value={candidate.id}>
                                    <span className="flex items-center gap-2">
                                       <LinearAvatar className="size-5" name={candidate.name} src={candidate.avatarUrl} />
                                       <span>{candidate.name}</span>
                                    </span>
                                 </SelectItem>
                              ))}
                           </SelectContent>
                        </Select>
                     </FieldLabel>
                     <FieldLabel label={fa.milestone.targetDate}>
                        <MilestoneDatePicker
                           ariaLabel={fa.milestone.targetDate}
                           placeholder={fa.milestone.noTarget}
                           value={form.targetOn}
                           onChange={(targetOn) => {
                              setForm((current) => ({ ...current, targetOn: targetOn || '' }));
                              setInlineError('');
                           }}
                        />
                     </FieldLabel>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-1 rounded-lg border border-border/70 bg-muted/30 p-1">
                     {(['PLANNED', 'ACTIVE'] as const).map((status) => (
                        <button
                           key={status}
                           aria-pressed={form.status === status}
                           className={cn(
                              'h-8 flex-1 rounded-md px-3 text-xs transition focus-visible:border-indigo-400',
                              form.status === status
                                 ? 'bg-background text-foreground shadow-sm'
                                 : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                           )}
                           type="button"
                           onClick={() => setForm((current) => ({ ...current, status }))}
                        >
                           {status === 'PLANNED' ? fa.milestone.planned : fa.milestone.active}
                        </button>
                     ))}
                  </div>

                  <button
                     aria-expanded={showMore}
                     className="mt-4 flex h-8 w-full items-center justify-between rounded-lg px-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:border focus-visible:border-indigo-400/50"
                     type="button"
                     onClick={() => setShowMore((current) => !current)}
                  >
                     <span className="flex items-center gap-2">
                        <Sparkles className="size-3.5" />
                        {fa.milestone.progressiveFields}
                     </span>
                     <ChevronDown className={cn('size-4 transition-transform', showMore && 'rotate-180')} />
                  </button>

                  {showMore ? (
                     <div className="mt-3 space-y-4 rounded-xl border border-border/70 bg-card/50 p-4">
                        <FieldLabel label={fa.milestone.description}>
                           <Textarea
                              className="min-h-28 resize-y border-border/70 bg-background/50 text-sm leading-6 text-foreground placeholder:text-muted-foreground/60"
                              placeholder={fa.milestone.descriptionPlaceholder}
                              value={form.description}
                              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                           />
                        </FieldLabel>
                        <div className="grid gap-3 sm:grid-cols-2">
                           <FieldLabel label={fa.milestone.startDate}>
                              <MilestoneDatePicker
                                 ariaLabel={fa.milestone.startDate}
                                 value={form.startsOn}
                                 onChange={(startsOn) => {
                                    setForm((current) => ({ ...current, startsOn: startsOn || '' }));
                                    setInlineError('');
                                 }}
                              />
                           </FieldLabel>
                           <FieldLabel label={fa.milestone.health}>
                              <Select
                                 value={toSelectValue(form.health)}
                                 onValueChange={(value) =>
                                    setForm((current) => ({
                                       ...current,
                                       health: fromSelectValue(value) as TaskaraMilestoneHealth | '',
                                    }))
                                 }
                              >
                                 <SelectTrigger className="h-9 border-border/70 bg-card text-foreground">
                                    <SelectValue />
                                 </SelectTrigger>
                                 <SelectContent className="rounded-xl border-border bg-popover text-popover-foreground [direction:rtl]">
                                    <SelectItem className="rounded-lg" value={EMPTY_SELECT_VALUE}>{fa.milestone.noHealth}</SelectItem>
                                    {(Object.entries(milestoneHealthMeta) as Array<[TaskaraMilestoneHealth, (typeof milestoneHealthMeta)[TaskaraMilestoneHealth]]>).map(([value, meta]) => {
                                       const Icon = meta.icon;
                                       return (
                                          <SelectItem className="rounded-lg" key={value} value={value}>
                                             <span className="flex items-center gap-2">
                                                <Icon className="size-3.5" />
                                                {meta.label}
                                             </span>
                                          </SelectItem>
                                       );
                                    })}
                                 </SelectContent>
                              </Select>
                           </FieldLabel>
                        </div>
                     </div>
                  ) : null}

                  {invalidDates || inlineError ? (
                     <p className="mt-4 rounded-lg border border-rose-400/25 bg-rose-400/8 px-3 py-2 text-xs leading-5 text-rose-700 dark:text-rose-200" role="alert">
                        {invalidDates ? fa.milestone.invalidDates : inlineError}
                     </p>
                  ) : null}
                  {!projects.length ? (
                     <p className="mt-4 rounded-lg border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-200">
                        {fa.issue.projectRequired}
                     </p>
                  ) : null}
                  {!online ? (
                     <p className="mt-4 rounded-lg border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-200" role="status">
                        آفلاین هستید. گام اکنون در دستگاه ساخته و پس از اتصال به‌طور خودکار همگام می‌شود.
                     </p>
                  ) : null}
                  {selectedProject ? (
                     <p className="mt-4 text-[11px] text-muted-foreground">
                        {selectedProject.team?.name || fa.project.unassignedProjects} • {selectedProject.keyPrefix}
                     </p>
                  ) : null}
               </div>
               <DialogFooter className="shrink-0 flex-row justify-end gap-2 border-t border-border/60 px-5 py-3 sm:justify-end">
                  <Button
                     className="rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                     disabled={submitting}
                     type="button"
                     variant="secondary"
                     onClick={() => onOpenChange(false)}
                  >
                     {fa.app.cancel}
                  </Button>
                  <Button
                     className="min-w-28 rounded-full bg-indigo-500 px-5 text-white hover:bg-indigo-400"
                     disabled={submitting || !projects.length || invalidDates}
                     type="submit"
                  >
                     {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                     {submitting ? fa.milestone.saving : fa.milestone.create}
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
