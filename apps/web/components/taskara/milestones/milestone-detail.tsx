'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
   Activity,
   AlertTriangle,
   Archive,
   ArrowRight,
   CalendarDays,
   Check,
   CheckCircle2,
   ChevronDown,
   ChevronUp,
   CircleDot,
   Flag,
   ListTodo,
   Loader2,
   MoreHorizontal,
   Pencil,
   RotateCcw,
   Save,
   ShieldAlert,
   Sparkles,
   Unlink,
   UserRound,
   X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DescriptionEditor } from '@/components/taskara/description-editor';
import { LinearAvatar, ProjectGlyph } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDateTime } from '@/lib/jalali';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';
import { TaskSyncMutationError } from '@/lib/task-sync';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   TaskaraActivity,
   TaskaraMilestone,
   TaskaraMilestoneHealth,
   TaskaraMilestoneKind,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { MilestoneDatePicker } from './milestone-date-picker';
import {
   type MilestoneLifecycleAction,
   MilestoneLifecycleDialog,
} from './milestone-lifecycle-dialog';
import { MilestoneTasksPanel } from './milestone-tasks-panel';
import {
   formatMilestoneDateOnly,
   isMilestoneOverdue,
   MilestoneBadge,
   MilestoneDetailSkeleton,
   MilestoneEmptyState,
   MilestoneGlyph,
   MilestoneProgress,
   milestoneHealthMeta,
   milestoneKindMeta,
   milestoneStatusMeta,
} from './primitives';
import { useOnlineStatus } from './use-online-status';

type DetailTab = 'overview' | 'work' | 'activity';
type OwnerCandidate = { avatarUrl?: string | null; email: string; id: string; name: string };

export function MilestoneDetail({
   milestoneId,
   milestoneSummary,
   workspaceSlug,
   onBack,
   onChanged,
}: {
   milestoneId: string;
   milestoneSummary: TaskaraMilestone | null;
   workspaceSlug: string;
   onBack: () => void;
   onChanged: (milestone: TaskaraMilestone) => void;
}) {
   const taskSync = useWorkspaceTaskSync();
   const online = useOnlineStatus();
   const [milestone, setMilestone] = useState<TaskaraMilestone | null>(milestoneSummary);
   const milestoneRef = useRef<TaskaraMilestone | null>(milestoneSummary);
   const [loading, setLoading] = useState(!milestoneSummary);
   const [refreshing, setRefreshing] = useState(Boolean(milestoneSummary));
   const [error, setError] = useState('');
   const [tab, setTab] = useState<DetailTab>('overview');
   const [lifecycleAction, setLifecycleAction] = useState<MilestoneLifecycleAction | null>(null);
   const [savingField, setSavingField] = useState<string | null>(null);
   const [reordering, setReordering] = useState(false);
   const [owners, setOwners] = useState<OwnerCandidate[]>([]);
   const [ownersLoading, setOwnersLoading] = useState(false);
   const [nameDraft, setNameDraft] = useState(milestoneSummary?.name || '');
   const [descriptionDraft, setDescriptionDraft] = useState(milestoneSummary?.description || '');
   const [datesDraft, setDatesDraft] = useState({
      startsOn: milestoneSummary?.startsOn || '',
      targetOn: milestoneSummary?.targetOn || '',
   });
   const requestRef = useRef(0);

   useEffect(() => {
      milestoneRef.current = milestone;
   }, [milestone]);

   const load = useCallback(async (preserve = true) => {
      const requestId = ++requestRef.current;
      if (preserve && milestoneRef.current) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
         const [summary, activity] = await Promise.all([
            taskaraRequest<TaskaraMilestone>(`/milestones/${encodeURIComponent(milestoneId)}`),
            taskaraRequest<TaskaraActivity[]>(`/milestones/${encodeURIComponent(milestoneId)}/activity`).catch(() => []),
         ]);
         if (requestId !== requestRef.current) return;
         const detail = { ...summary, activity };
         setMilestone(detail);
         milestoneRef.current = detail;
         syncDrafts(detail, setNameDraft, setDescriptionDraft, setDatesDraft);
         onChanged(detail);
      } catch (loadError) {
         if (requestId !== requestRef.current) return;
         setError(loadError instanceof Error ? loadError.message : fa.milestone.detailLoadingFailed);
      } finally {
         if (requestId === requestRef.current) {
            setLoading(false);
            setRefreshing(false);
         }
      }
   }, [milestoneId, onChanged]);

   useEffect(() => {
      setMilestone(milestoneSummary);
      milestoneRef.current = milestoneSummary;
      if (milestoneSummary) syncDrafts(milestoneSummary, setNameDraft, setDescriptionDraft, setDatesDraft);
      setTab('overview');
      if (milestoneSummary?.syncState === 'pending' && !online) {
         setLoading(false);
         setRefreshing(false);
         setError('');
      } else {
         void load(Boolean(milestoneSummary));
      }
      return () => {
         requestRef.current += 1;
      };
      // ID changes are the detail-load boundary; summary changes are merged below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [milestoneId]);

   useEffect(() => {
      if (!milestoneSummary || milestoneSummary.id !== milestoneId) return;
      setMilestone((current) => current ? mergeDetailResponse(current, milestoneSummary) : milestoneSummary);
   }, [milestoneId, milestoneSummary]);

   useEffect(() => {
      if (!milestone?.projectId || milestone.canManage === false || milestone.archivedAt) {
         setOwners([]);
         return;
      }
      const controller = new AbortController();
      setOwnersLoading(true);
      const params = new URLSearchParams({ projectId: milestone.projectId, limit: '200' });
      void taskaraRequest<{ items: OwnerCandidate[]; total: number }>(
         `/milestones/owner-candidates?${params.toString()}`,
         { signal: controller.signal }
      )
         .then((result) => setOwners(result.items))
         .catch(() => {
            if (!controller.signal.aborted) setOwners([]);
         })
         .finally(() => {
            if (!controller.signal.aborted) setOwnersLoading(false);
         });
      return () => controller.abort();
   }, [milestone?.archivedAt, milestone?.canManage, milestone?.projectId]);

   const saveMetadata = useCallback(async (
      patch: Partial<Pick<TaskaraMilestone, 'description' | 'health' | 'kind' | 'name' | 'ownerId' | 'startsOn' | 'targetOn'>>,
      field: string
   ) => {
      const current = milestoneRef.current;
      if (!current || current.archivedAt || current.canManage === false || savingField) return false;
      const effectiveStartsOn = Object.prototype.hasOwnProperty.call(patch, 'startsOn') ? patch.startsOn : current.startsOn;
      const effectiveTargetOn = Object.prototype.hasOwnProperty.call(patch, 'targetOn') ? patch.targetOn : current.targetOn;
      if (effectiveStartsOn && effectiveTargetOn && effectiveTargetOn < effectiveStartsOn) {
         toast.error(fa.milestone.invalidDates);
         return false;
      }

      setSavingField(field);
      setMilestone({ ...current, ...patch });
      try {
         const updated = await taskSync.updateMilestone(current, patch);
         const merged = mergeDetailResponse(current, updated);
         setMilestone(merged);
         milestoneRef.current = merged;
         syncDrafts(merged, setNameDraft, setDescriptionDraft, setDatesDraft);
         onChanged(merged);
         if (updated.syncState === 'pending') toast.info(fa.sync.mutationQueued);
         else toast.success(fa.milestone.updated);
         if (updated.syncState !== 'pending') void load(true);
         return true;
      } catch (saveError) {
         if (saveError instanceof TaskSyncMutationError && saveError.failure?.status === 'conflict') {
            try {
               const latest = await taskaraRequest<TaskaraMilestone>(
                  `/milestones/${encodeURIComponent(current.id)}`
               );
               const merged = mergeDetailResponse(current, latest);
               setMilestone({ ...merged, ...patch });
               milestoneRef.current = merged;
               syncDrafts(merged, setNameDraft, setDescriptionDraft, setDatesDraft);
               if (patch.name !== undefined) setNameDraft(patch.name);
               if (patch.description !== undefined) setDescriptionDraft(patch.description || '');
               if (patch.startsOn !== undefined || patch.targetOn !== undefined) {
                  setDatesDraft({
                     startsOn: patch.startsOn === undefined ? merged.startsOn || '' : patch.startsOn || '',
                     targetOn: patch.targetOn === undefined ? merged.targetOn || '' : patch.targetOn || '',
                  });
               }
               onChanged(merged);
               toast.error(fa.milestone.versionConflict, {
                  description: fa.milestone.conflictDraftRetained,
                  action: {
                     label: fa.milestone.retry,
                     onClick: () => void saveMetadata(patch, field),
                  },
               });
            } catch {
               setMilestone({ ...current, ...patch });
               milestoneRef.current = current;
               toast.error(fa.milestone.versionConflict, {
                  description: fa.milestone.conflictDraftRetained,
               });
            }
         } else {
            setMilestone(current);
            milestoneRef.current = current;
            toast.error(saveError instanceof Error ? saveError.message : fa.milestone.updateFailed);
         }
         return false;
      } finally {
         setSavingField(null);
      }
   }, [load, onChanged, savingField, taskSync]);

   const reorder = useCallback(async (direction: 'up' | 'down') => {
      const current = milestoneRef.current;
      if (!current || current.archivedAt || current.canManage === false || reordering) return;
      setReordering(true);
      try {
         let siblings = taskSync.milestones.filter((item) => item.projectId === current.projectId);
         if (online) {
            try {
               siblings = await loadProjectMilestones(current.projectId);
            } catch {
               // The sync cache remains usable during a transient list failure.
            }
         }
         if (!siblings.some((item) => item.id === current.id)) siblings = [...siblings, current];
         const ordered = siblings
            .filter((item) => !item.archivedAt)
            .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
         const index = ordered.findIndex((item) => item.id === current.id);
         const targetIndex = direction === 'up' ? index - 1 : index + 1;
         if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) {
            toast.info(direction === 'up' ? 'این گام در ابتدای ترتیب پروژه است.' : 'این گام در انتهای ترتیب پروژه است.');
            return;
         }
         const desired = [...ordered];
         const [moving] = desired.splice(index, 1);
         desired.splice(targetIndex, 0, moving);
         const beforeId = desired[targetIndex - 1]?.id || null;
         const afterId = desired[targetIndex + 1]?.id || null;
         const updated = await taskSync.reorderMilestone(current, { beforeId, afterId });
         const merged = mergeDetailResponse(current, updated);
         setMilestone(merged);
         milestoneRef.current = merged;
         onChanged(merged);
         if (updated.syncState === 'pending') toast.info(fa.sync.mutationQueued);
         else toast.success('ترتیب گام به‌روز شد.');
         if (updated.syncState !== 'pending') void load(true);
      } catch (reorderError) {
         if (reorderError instanceof TaskSyncMutationError && reorderError.failure?.status === 'conflict') {
            toast.error(fa.milestone.versionConflict);
            void load(true);
         } else {
            toast.error(reorderError instanceof Error ? reorderError.message : fa.milestone.updateFailed);
         }
      } finally {
         setReordering(false);
      }
   }, [load, onChanged, online, reordering, taskSync]);

   if (loading && !milestone) return <MilestoneDetailSkeleton />;

   if (!milestone) {
      return (
         <div className="flex h-full flex-col p-4">
            <button className="mb-4 inline-flex h-9 w-fit items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted md:hidden" type="button" onClick={onBack}>
               <ArrowRight className="size-4" />
               {fa.app.back}
            </button>
            <MilestoneEmptyState
               action={error ? <Button variant="secondary" onClick={() => void load(false)}>{fa.milestone.retry}</Button> : undefined}
               description={error || undefined}
            >
               {fa.milestone.noAccess}
            </MilestoneEmptyState>
         </div>
      );
   }

   const canManage = milestone.canManage !== false;
   const readOnly = Boolean(milestone.archivedAt || !canManage);
   const nameChanged = nameDraft.trim() !== milestone.name;
   const descriptionChanged = descriptionDraft !== (milestone.description || '');
   const datesChanged = datesDraft.startsOn !== (milestone.startsOn || '') || datesDraft.targetOn !== (milestone.targetOn || '');
   const invalidDates = Boolean(datesDraft.startsOn && datesDraft.targetOn && datesDraft.targetOn < datesDraft.startsOn);
   const primaryAction = primaryLifecycleAction(milestone);
   const kindMeta = milestoneKindMeta[milestone.kind];
   const statusMeta = milestoneStatusMeta[milestone.status];
   const healthMeta = milestone.health ? milestoneHealthMeta[milestone.health] : null;

   function handleLifecycleChanged(updated: TaskaraMilestone) {
      const merged = mergeDetailResponse(milestoneRef.current || updated, updated);
      setMilestone(merged);
      milestoneRef.current = merged;
      syncDrafts(merged, setNameDraft, setDescriptionDraft, setDatesDraft);
      onChanged(merged);
      if (updated.syncState === 'pending') toast.info('تصمیم شما ذخیره شد و پس از اتصال همگام می‌شود.');
      else {
         toast.success(fa.milestone.lifecycleUpdated);
         void load(true);
      }
   }

   return (
      <div className="flex h-full min-h-0 flex-col bg-background [direction:rtl]">
         <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-2">
               <button
                  aria-label={fa.app.back}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
                  type="button"
                  onClick={onBack}
               >
                  <ArrowRight className="size-4" />
               </button>
               <MilestoneGlyph className="size-8" />
               <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{milestone.name}</p>
                  <Link
                     className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                     to={`/${workspaceSlug}/milestones?projectId=${encodeURIComponent(milestone.projectId)}`}
                  >
                     <ProjectGlyph className="size-3.5 rounded-sm" iconClassName="size-2.5" name={milestone.project.name} />
                     <span className="truncate">{milestone.project.name}</span>
                     <span className="ltr">{milestone.project.keyPrefix}</span>
                  </Link>
               </div>
               {refreshing ? <Loader2 aria-label={fa.app.loading} className="size-3.5 animate-spin text-muted-foreground" /> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
               {!readOnly && primaryAction ? (
                  <Button
                     aria-label={lifecycleLabel(primaryAction, milestone)}
                     className="h-9 rounded-full"
                     size="sm"
                     variant="secondary"
                     onClick={() => setLifecycleAction(primaryAction)}
                  >
                     <LifecycleIcon action={primaryAction} />
                     <span className="hidden sm:inline">{lifecycleLabel(primaryAction, milestone)}</span>
                  </Button>
               ) : null}
               <LifecycleMenu
                  milestone={milestone}
                  readOnly={!canManage}
                  reordering={reordering}
                  onAction={setLifecycleAction}
                  onReorder={(direction) => void reorder(direction)}
               />
            </div>
         </header>

         {error ? (
            <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground" role="alert">
               <span>{error}</span>
               <button className="underline" type="button" onClick={() => void load(true)}>{fa.milestone.retry}</button>
            </div>
         ) : null}
         {milestone.archivedAt ? (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-200">
               <Archive className="size-4 shrink-0" />
               {fa.milestone.readOnlyArchived}
            </div>
         ) : !canManage ? (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
               <ShieldAlert className="size-4 shrink-0" />
               شما دسترسی مشاهده دارید؛ تغییر گام به مجوز برنامه‌ریزی پروژه نیاز دارد.
            </div>
         ) : milestone.syncState === 'pending' ? (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-indigo-400/20 bg-indigo-400/8 px-3 py-2 text-xs text-indigo-700 dark:text-indigo-200" role="status">
               <ShieldAlert className="size-4 shrink-0" />
               این گام یک تغییر همگام‌نشده دارد؛ ویرایش شما امن است و پس از اتصال تأیید می‌شود.
            </div>
         ) : !online ? (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-200" role="status">
               <ShieldAlert className="size-4 shrink-0" />
               آفلاین هستید. تغییرهای گام روی دستگاه ذخیره و پس از اتصال همگام می‌شوند.
            </div>
         ) : null}

         <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border/60 px-3 sm:px-5">
               <div aria-label={fa.milestone.title} className="flex h-10 items-center" role="tablist">
                  <DetailTabTrigger active={tab === 'overview'} icon={Sparkles} label={fa.milestone.overview} value="overview" onSelect={setTab} />
                  <DetailTabTrigger active={tab === 'work'} icon={ListTodo} label={fa.milestone.work} value="work" count={milestone.progress.totalTasks} onSelect={setTab} />
                  <DetailTabTrigger active={tab === 'activity'} icon={Activity} label={fa.milestone.activity} value="activity" onSelect={setTab} />
               </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
               {tab === 'overview' ? (
               <div role="tabpanel">
                  <div className="mx-auto grid w-full max-w-[1120px] gap-8 px-4 py-6 sm:px-7 xl:grid-cols-[minmax(0,1fr)_280px] xl:px-9">
                     <div className="min-w-0 space-y-7">
                        <section aria-labelledby="milestone-title-heading">
                           <div className="flex items-start gap-3">
                              <MilestoneGlyph className="mt-1 size-10 rounded-xl" />
                              <div className="min-w-0 flex-1">
                                 {readOnly ? (
                                    <h1 className="break-words text-2xl font-semibold leading-9" id="milestone-title-heading">{milestone.name}</h1>
                                 ) : (
                                    <div className="flex items-start gap-2">
                                       <Input
                                          aria-label={fa.milestone.name}
                                          className="h-auto min-w-0 flex-1 border-transparent bg-transparent px-0 text-2xl font-semibold leading-9 shadow-none focus-visible:border-border focus-visible:px-2 focus-visible:ring-0"
                                          maxLength={160}
                                          value={nameDraft}
                                          onChange={(event) => setNameDraft(event.target.value)}
                                          onKeyDown={(event) => {
                                             if (event.key === 'Enter' && nameChanged && nameDraft.trim()) {
                                                event.preventDefault();
                                                void saveMetadata({ name: nameDraft.trim() }, 'name');
                                             }
                                             if (event.key === 'Escape') setNameDraft(milestone.name);
                                          }}
                                       />
                                       {nameChanged ? (
                                          <InlineSaveControls
                                             disabled={!nameDraft.trim() || savingField === 'name'}
                                             saving={savingField === 'name'}
                                             onCancel={() => setNameDraft(milestone.name)}
                                             onSave={() => void saveMetadata({ name: nameDraft.trim() }, 'name')}
                                          />
                                       ) : null}
                                    </div>
                                 )}
                                 <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <MilestoneBadge {...kindMeta} />
                                    <MilestoneBadge {...statusMeta} />
                                    {healthMeta ? <MilestoneBadge {...healthMeta} /> : null}
                                    {milestone.targetOn ? (
                                       <span className={cn('inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[11px] text-muted-foreground', isMilestoneOverdue(milestone) && 'border-rose-400/25 text-rose-600 dark:text-rose-300')}>
                                          <CalendarDays className="size-3" />
                                          {formatMilestoneDateOnly(milestone.targetOn)}
                                       </span>
                                    ) : null}
                                 </div>
                              </div>
                           </div>
                        </section>

                        <section aria-labelledby="milestone-description-heading">
                           <div className="mb-2 flex items-center justify-between gap-3">
                              <h2 className="text-sm font-semibold" id="milestone-description-heading">{fa.milestone.description}</h2>
                              {!readOnly && descriptionChanged ? (
                                 <InlineSaveControls
                                    disabled={savingField === 'description'}
                                    saving={savingField === 'description'}
                                    onCancel={() => setDescriptionDraft(milestone.description || '')}
                                    onSave={() => void saveMetadata({ description: descriptionDraft.trim() || null }, 'description')}
                                 />
                              ) : null}
                           </div>
                           {readOnly ? (
                              <p className="min-h-20 whitespace-pre-wrap rounded-xl border border-border/60 bg-card/30 p-4 text-sm leading-7 text-muted-foreground">
                                 {descriptionToPlainText(milestone.description) || fa.milestone.descriptionPlaceholder}
                              </p>
                           ) : (
                              <DescriptionEditor
                                 ariaLabel={fa.milestone.description}
                                 className="min-h-36 bg-card/25"
                                 contentClassName="min-h-28 px-4 py-3 text-sm leading-7"
                                 placeholder={fa.milestone.descriptionPlaceholder}
                                 showToolbar
                                 value={descriptionDraft}
                                 onChange={setDescriptionDraft}
                              />
                           )}
                        </section>

                        <ProgressOverview milestone={milestone} />
                        <AttentionOverview milestone={milestone} />
                        <LatestActivity activity={milestone.activity || []} />
                     </div>

                     <aside className="min-w-0 space-y-4 xl:sticky xl:top-6 xl:self-start" aria-label="ویژگی‌های گام">
                        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/35">
                           <PropertyRow icon={ProjectGlyphProxy} label={fa.milestone.project}>
                              <Link className="truncate text-xs hover:text-indigo-600 dark:hover:text-indigo-300" to={`/${workspaceSlug}/milestones?projectId=${encodeURIComponent(milestone.projectId)}`}>
                                 {milestone.project.name}
                              </Link>
                           </PropertyRow>
                           <PropertyRow icon={Flag} label={fa.milestone.kind}>
                              {readOnly ? (
                                 <span className="text-xs">{kindMeta.label}</span>
                              ) : (
                                 <Select
                                    disabled={Boolean(savingField)}
                                    value={milestone.kind}
                                    onValueChange={(kind) => void saveMetadata({ kind: kind as TaskaraMilestoneKind }, 'kind')}
                                 >
                                    <PropertySelectTrigger label={kindMeta.label} />
                                    <SelectContent className="[direction:rtl]">
                                       {(Object.entries(milestoneKindMeta) as Array<[TaskaraMilestoneKind, typeof kindMeta]>).map(([value, meta]) => (
                                          <SelectItem key={value} value={value}>{meta.label}</SelectItem>
                                       ))}
                                    </SelectContent>
                                 </Select>
                              )}
                           </PropertyRow>
                           <PropertyRow icon={CircleDot} label={fa.milestone.status}>
                              <span className="text-xs">{statusMeta.label}</span>
                           </PropertyRow>
                           <PropertyRow icon={UserRound} label={fa.milestone.owner}>
                              {readOnly ? (
                                 <OwnerValue milestone={milestone} />
                              ) : (
                                 <Select
                                    disabled={ownersLoading || Boolean(savingField)}
                                    value={toSelectValue(milestone.ownerId || milestone.owner?.id || '')}
                                    onValueChange={(value) => void saveMetadata({ ownerId: fromSelectValue(value) || null }, 'owner')}
                                 >
                                    <PropertySelectTrigger label={milestone.owner?.name || fa.milestone.noOwner} loading={ownersLoading} />
                                    <SelectContent className="max-h-72 [direction:rtl]">
                                       <SelectItem value={EMPTY_SELECT_VALUE}>{fa.milestone.noOwner}</SelectItem>
                                       {owners.map((owner) => (
                                          <SelectItem key={owner.id} value={owner.id}>
                                             <span className="flex items-center gap-2">
                                                <LinearAvatar className="size-5" name={owner.name} src={owner.avatarUrl} />
                                                {owner.name}
                                             </span>
                                          </SelectItem>
                                       ))}
                                    </SelectContent>
                                 </Select>
                              )}
                           </PropertyRow>
                           <PropertyRow icon={ShieldAlert} label={fa.milestone.health}>
                              {readOnly ? (
                                 <span className="text-xs">{healthMeta?.label || fa.milestone.noHealth}</span>
                              ) : (
                                 <Select
                                    disabled={Boolean(savingField)}
                                    value={toSelectValue(milestone.health || '')}
                                    onValueChange={(value) => void saveMetadata({ health: (fromSelectValue(value) || null) as TaskaraMilestoneHealth | null }, 'health')}
                                 >
                                    <PropertySelectTrigger label={healthMeta?.label || fa.milestone.noHealth} />
                                    <SelectContent className="[direction:rtl]">
                                       <SelectItem value={EMPTY_SELECT_VALUE}>{fa.milestone.noHealth}</SelectItem>
                                       {(Object.entries(milestoneHealthMeta) as Array<[TaskaraMilestoneHealth, NonNullable<typeof healthMeta>]>).map(([value, meta]) => (
                                          <SelectItem key={value} value={value}>{meta.label}</SelectItem>
                                       ))}
                                    </SelectContent>
                                 </Select>
                              )}
                           </PropertyRow>
                        </div>

                        <div className="rounded-2xl border border-border/70 bg-card/35 p-4">
                           <div className="mb-3 flex items-center justify-between gap-2">
                              <h2 className="text-xs font-semibold">زمان‌بندی</h2>
                              {!readOnly && datesChanged ? (
                                 <InlineSaveControls
                                    disabled={invalidDates || Boolean(savingField)}
                                    saving={savingField === 'dates'}
                                    onCancel={() => setDatesDraft({ startsOn: milestone.startsOn || '', targetOn: milestone.targetOn || '' })}
                                    onSave={() => void saveMetadata({
                                       startsOn: datesDraft.startsOn || null,
                                       targetOn: datesDraft.targetOn || null,
                                    }, 'dates')}
                                 />
                              ) : null}
                           </div>
                           {readOnly ? (
                              <div className="space-y-3 text-xs">
                                 <DateReadOnly label={fa.milestone.startDate} value={milestone.startsOn} />
                                 <DateReadOnly label={fa.milestone.targetDate} value={milestone.targetOn} />
                              </div>
                           ) : (
                              <div className="space-y-3">
                                 <label className="grid gap-1.5 text-[11px] text-muted-foreground">
                                    {fa.milestone.startDate}
                                    <MilestoneDatePicker ariaLabel={fa.milestone.startDate} disabled={Boolean(savingField)} value={datesDraft.startsOn} onChange={(startsOn) => setDatesDraft((current) => ({ ...current, startsOn: startsOn || '' }))} />
                                 </label>
                                 <label className="grid gap-1.5 text-[11px] text-muted-foreground">
                                    {fa.milestone.targetDate}
                                    <MilestoneDatePicker ariaLabel={fa.milestone.targetDate} disabled={Boolean(savingField)} placeholder={fa.milestone.noTarget} value={datesDraft.targetOn} onChange={(targetOn) => setDatesDraft((current) => ({ ...current, targetOn: targetOn || '' }))} />
                                 </label>
                                 {invalidDates ? <p className="text-[11px] leading-5 text-rose-600 dark:text-rose-300" role="alert">{fa.milestone.invalidDates}</p> : null}
                              </div>
                           )}
                        </div>
                     </aside>
                  </div>
               </div>
               ) : null}

               {tab === 'work' ? (
               <div role="tabpanel">
                  <div className="mx-auto w-full max-w-[1020px] px-4 py-6 sm:px-7">
                     <MilestoneTasksPanel milestone={milestone} workspaceSlug={workspaceSlug} onMilestoneRefresh={() => void load(true)} />
                  </div>
               </div>
               ) : null}

               {tab === 'activity' ? (
               <div role="tabpanel">
                  <div className="mx-auto w-full max-w-[760px] px-4 py-6 sm:px-7">
                     <ActivityTimeline activity={milestone.activity || []} />
                  </div>
               </div>
               ) : null}
            </div>
         </div>

         <MilestoneLifecycleDialog
            action={lifecycleAction}
            milestone={milestone}
            openMilestones={taskSync.milestones}
            onChanged={handleLifecycleChanged}
            onOpenChange={(open) => !open && setLifecycleAction(null)}
         />
      </div>
   );
}

function LifecycleMenu({
   milestone,
   readOnly,
   reordering,
   onAction,
   onReorder,
}: {
   milestone: TaskaraMilestone;
   readOnly: boolean;
   reordering: boolean;
   onAction: (action: MilestoneLifecycleAction) => void;
   onReorder: (direction: 'up' | 'down') => void;
}) {
   const actions = allowedLifecycleActions(milestone);
   if (readOnly || !actions.length) return null;
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <button aria-label="اقدام‌های گام" className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-indigo-400/60" type="button">
               <MoreHorizontal className="size-4" />
            </button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="w-52 [direction:rtl]">
            {!milestone.archivedAt ? (
               <>
                  <DropdownMenuItem disabled={reordering} onSelect={() => onReorder('up')}>
                     {reordering ? <Loader2 className="size-4 animate-spin" /> : <ChevronUp className="size-4" />}
                     انتقال یک جایگاه بالاتر
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={reordering} onSelect={() => onReorder('down')}>
                     <ChevronDown className="size-4" />
                     انتقال یک جایگاه پایین‌تر
                  </DropdownMenuItem>
                  {actions.length ? <DropdownMenuSeparator /> : null}
               </>
            ) : null}
            {actions.map((action, index) => (
               <div key={action}>
                  {index > 0 && action === 'archive' ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem variant={action === 'cancel' ? 'destructive' : 'default'} onSelect={() => onAction(action)}>
                     <LifecycleIcon action={action} />
                     {lifecycleLabel(action, milestone)}
                  </DropdownMenuItem>
               </div>
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

function DetailTabTrigger({
   active,
   count,
   icon: Icon,
   label,
   value,
   onSelect,
}: {
   active: boolean;
   count?: number;
   icon: typeof Activity;
   label: string;
   value: DetailTab;
   onSelect: (value: DetailTab) => void;
}) {
   return (
      <button
         aria-selected={active}
         className={cn(
            'inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent px-3 text-xs font-medium text-muted-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60',
            active && 'border-indigo-400 text-foreground'
         )}
         role="tab"
         type="button"
         onClick={() => onSelect(value)}
      >
         <Icon className="size-3.5" />
         {label}
         {count !== undefined ? <span className="rounded-full bg-muted px-1.5 text-[10px]">{count.toLocaleString('fa-IR')}</span> : null}
      </button>
   );
}

function ProgressOverview({ milestone }: { milestone: TaskaraMilestone }) {
   const progress = milestone.progress;
   return (
      <section className="rounded-2xl border border-border/70 bg-card/35 p-5" aria-labelledby="milestone-progress-heading">
         <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold" id="milestone-progress-heading">{fa.milestone.progress}</h2>
            {milestone.readyToComplete || progress.percentage === 100 && milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELED' ? (
               <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-200">
                  <CheckCircle2 className="size-3" />
                  {fa.milestone.readyToComplete}
               </span>
            ) : null}
         </div>
         <div className="mt-4"><MilestoneProgress milestone={milestone} /></div>
         <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ProgressStat label="کل کارها" value={progress.totalTasks} />
            <ProgressStat label="تکمیل‌شده" value={progress.completedTasks} tone="text-emerald-700 dark:text-emerald-300" />
            <ProgressStat label="مسدود" value={progress.blockedTasks} tone={progress.blockedTasks ? 'text-amber-700 dark:text-amber-300' : undefined} />
            <ProgressStat label="لغوشده" value={progress.canceledTasks} />
         </div>
         {progress.totalWeight > 0 ? (
            <p className="mt-4 text-[11px] text-muted-foreground">
               وزن تکمیل‌شده: {progress.completedWeight.toLocaleString('fa-IR')} از {progress.totalWeight.toLocaleString('fa-IR')}
            </p>
         ) : null}
      </section>
   );
}

function AttentionOverview({ milestone }: { milestone: TaskaraMilestone }) {
   const reasons = milestoneAttentionReasons(milestone);
   return (
      <section aria-labelledby="milestone-attention-heading">
         <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold" id="milestone-attention-heading">{fa.milestone.attention}</h2>
            {milestone.health ? (
               <span className="text-[11px] text-muted-foreground">سلامت دستی: {milestoneHealthMeta[milestone.health].label}</span>
            ) : null}
         </div>
         {reasons.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
               {reasons.map((reason) => (
                  <div className={cn('flex min-h-12 items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-5', reason.className)} key={reason.key}>
                     <reason.icon className="mt-0.5 size-4 shrink-0" />
                     {reason.label}
                  </div>
               ))}
            </div>
         ) : (
            <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/25 px-3 py-3 text-xs text-muted-foreground">
               <Check className="size-4" />
               {fa.milestone.noAttention}
            </div>
         )}
      </section>
   );
}

function LatestActivity({ activity }: { activity: TaskaraActivity[] }) {
   const latest = activity.slice(0, 4);
   return (
      <section aria-labelledby="milestone-latest-activity-heading">
         <h2 className="mb-2 text-sm font-semibold" id="milestone-latest-activity-heading">آخرین فعالیت</h2>
         {latest.length ? <ActivityItems activity={latest} /> : <p className="rounded-xl border border-border/60 bg-card/25 p-4 text-xs text-muted-foreground">{fa.milestone.noActivity}</p>}
      </section>
   );
}

function ActivityTimeline({ activity }: { activity: TaskaraActivity[] }) {
   return (
      <section aria-labelledby="milestone-activity-heading">
         <h2 className="mb-4 text-sm font-semibold" id="milestone-activity-heading">{fa.milestone.activity}</h2>
         {activity.length ? <ActivityItems activity={activity} /> : (
            <MilestoneEmptyState description="تغییرات ویژگی‌ها، وضعیت و دامنه کارها در اینجا ثبت می‌شود.">{fa.milestone.noActivity}</MilestoneEmptyState>
         )}
      </section>
   );
}

function ActivityItems({ activity }: { activity: TaskaraActivity[] }) {
   return (
      <ol className="relative space-y-1 before:absolute before:bottom-5 before:right-[17px] before:top-5 before:w-px before:bg-border">
         {activity.map((item) => (
            <li className="relative flex gap-3 rounded-xl px-1 py-3 hover:bg-card/35" key={item.id}>
               {item.actor ? (
                  <LinearAvatar className="relative z-10 size-8 shrink-0 ring-4 ring-background" name={item.actor.name} src={item.actor.avatarUrl} />
               ) : (
                  <span className="relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-4 ring-background">
                     <Activity className="size-4" />
                  </span>
               )}
               <div className="min-w-0 flex-1">
                  <p className="text-xs leading-5 text-foreground">
                     {item.actor?.name ? <strong className="font-medium">{item.actor.name} </strong> : null}
                     {activityLabel(item)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{formatJalaliDateTime(item.createdAt)}</p>
               </div>
            </li>
         ))}
      </ol>
   );
}

function PropertyRow({ children, icon: Icon, label }: { children: React.ReactNode; icon: React.ComponentType<{ className?: string }>; label: string }) {
   return (
      <div className="grid min-h-11 grid-cols-[92px_minmax(0,1fr)] items-center gap-2 border-b border-border/50 px-3 last:border-b-0">
         <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><Icon className="size-3.5" />{label}</span>
         <div className="min-w-0 text-left">{children}</div>
      </div>
   );
}

function PropertySelectTrigger({ label, loading = false }: { label: string; loading?: boolean }) {
   return (
      <SelectTrigger className="h-8 w-full border-transparent bg-transparent px-1 text-xs shadow-none hover:bg-muted focus:ring-0">
         {loading ? <Loader2 className="size-3.5 animate-spin" /> : <span className="truncate">{label}</span>}
         <ChevronDown className="size-3.5 text-muted-foreground" />
      </SelectTrigger>
   );
}

function InlineSaveControls({
   disabled,
   saving,
   onCancel,
   onSave,
}: {
   disabled: boolean;
   saving: boolean;
   onCancel: () => void;
   onSave: () => void;
}) {
   return (
      <div className="flex shrink-0 items-center gap-1">
         <button aria-label={fa.app.cancel} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted" disabled={saving} type="button" onClick={onCancel}><X className="size-3.5" /></button>
         <button aria-label={fa.milestone.saved} className="inline-flex size-8 items-center justify-center rounded-lg bg-indigo-500 text-white hover:bg-indigo-400 disabled:opacity-50" disabled={disabled} type="button" onClick={onSave}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
         </button>
      </div>
   );
}

function OwnerValue({ milestone }: { milestone: TaskaraMilestone }) {
   return milestone.owner ? (
      <span className="flex min-w-0 items-center justify-end gap-2 text-xs">
         <span className="truncate">{milestone.owner.name}</span>
         <LinearAvatar className="size-5" name={milestone.owner.name} src={milestone.owner.avatarUrl} />
      </span>
   ) : <span className="text-xs text-muted-foreground">{fa.milestone.noOwner}</span>;
}

function DateReadOnly({ label, value }: { label: string; value?: string | null }) {
   return (
      <div className="flex items-center justify-between gap-3">
         <span className="text-muted-foreground">{label}</span>
         <span>{value ? formatMilestoneDateOnly(value) : fa.app.noDate}</span>
      </div>
   );
}

function ProgressStat({ label, tone, value }: { label: string; tone?: string; value: number }) {
   return (
      <div className="rounded-xl bg-muted/45 px-3 py-3">
         <strong className={cn('block text-lg font-semibold tabular-nums', tone)}>{value.toLocaleString('fa-IR')}</strong>
         <span className="mt-1 block text-[10px] text-muted-foreground">{label}</span>
      </div>
   );
}

function LifecycleIcon({ action }: { action: MilestoneLifecycleAction }) {
   if (action === 'complete') return <CheckCircle2 className="size-4" />;
   if (action === 'cancel') return <Unlink className="size-4" />;
   if (action === 'archive') return <Archive className="size-4" />;
   return <RotateCcw className="size-4" />;
}

function ProjectGlyphProxy({ className }: { className?: string }) {
   return <ProjectGlyph className={cn('rounded-sm', className)} iconClassName="size-3" name="پروژه" />;
}

export function primaryLifecycleAction(milestone: TaskaraMilestone): MilestoneLifecycleAction | null {
   if (milestone.archivedAt) return 'restore';
   if (milestone.status === 'PLANNED') return 'activate';
   if (milestone.status === 'ACTIVE') return 'complete';
   if (milestone.status === 'COMPLETED') return 'reopen';
   if (milestone.status === 'CANCELED') return 'activate';
   return null;
}

export function allowedLifecycleActions(milestone: TaskaraMilestone): MilestoneLifecycleAction[] {
   if (milestone.archivedAt) return ['restore'];
   if (milestone.status === 'PLANNED') return ['activate', 'complete', 'cancel'];
   if (milestone.status === 'ACTIVE') return ['complete', 'cancel'];
   if (milestone.status === 'COMPLETED') return ['reopen', 'archive'];
   if (milestone.status === 'CANCELED') return ['activate', 'archive'];
   return [];
}

function lifecycleLabel(action: MilestoneLifecycleAction, milestone: TaskaraMilestone) {
   if (action === 'activate') return milestone.status === 'CANCELED' ? fa.milestone.reactivate : fa.milestone.activate;
   if (action === 'complete') return fa.milestone.complete;
   if (action === 'reopen') return fa.milestone.reopen;
   if (action === 'cancel') return fa.milestone.cancelMilestone;
   if (action === 'archive') return fa.milestone.archive;
   return fa.milestone.restore;
}

function milestoneAttentionReasons(milestone: TaskaraMilestone) {
   const reasons: Array<{ className: string; icon: typeof AlertTriangle; key: string; label: string }> = [];
   if (isMilestoneOverdue(milestone)) reasons.push({ className: 'border-rose-400/25 bg-rose-400/8 text-rose-700 dark:text-rose-200', icon: AlertTriangle, key: 'target-overdue', label: fa.milestone.overdue });
   if (milestone.progress.blockedTasks > 0) reasons.push({ className: 'border-amber-400/25 bg-amber-400/8 text-amber-700 dark:text-amber-200', icon: ShieldAlert, key: 'blocked', label: fa.milestone.blockedCount(milestone.progress.blockedTasks) });
   if (milestone.progress.overdueTasks > 0) reasons.push({ className: 'border-amber-400/25 bg-amber-400/8 text-amber-700 dark:text-amber-200', icon: CalendarDays, key: 'task-overdue', label: fa.milestone.overdueCount(milestone.progress.overdueTasks) });
   if (!milestone.owner) reasons.push({ className: 'border-border/70 bg-card/35 text-muted-foreground', icon: UserRound, key: 'owner', label: fa.milestone.missingOwner });
   if (!milestone.targetOn) reasons.push({ className: 'border-border/70 bg-card/35 text-muted-foreground', icon: CalendarDays, key: 'target', label: fa.milestone.missingTarget });
   if (milestone.progress.percentage === 100 && milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELED') reasons.push({ className: 'border-emerald-400/25 bg-emerald-400/8 text-emerald-700 dark:text-emerald-200', icon: CheckCircle2, key: 'ready', label: fa.milestone.readyToComplete });
   return reasons;
}

function activityLabel(activity: TaskaraActivity) {
   const labels: Record<string, string> = {
      CREATE: 'گام را ساخت.',
      CREATED: 'گام را ساخت.',
      UPDATE: `گام را به‌روز کرد${changedFieldSummary(activity)}.`,
      UPDATED: `گام را به‌روز کرد${changedFieldSummary(activity)}.`,
      ACTIVATE: 'گام را فعال کرد.',
      ACTIVATED: 'گام را فعال کرد.',
      COMPLETE: 'گام را تکمیل کرد.',
      COMPLETED: 'گام را تکمیل کرد.',
      REOPEN: 'گام را بازگشایی کرد.',
      REOPENED: 'گام را بازگشایی کرد.',
      CANCEL: 'گام را لغو کرد.',
      CANCELED: 'گام را لغو کرد.',
      ARCHIVE: 'گام را آرشیو کرد.',
      ARCHIVED: 'گام را آرشیو کرد.',
      RESTORE: 'گام را بازگرداند.',
      RESTORED: 'گام را بازگرداند.',
      REORDER: 'ترتیب گام را تغییر داد.',
      REORDERED: 'ترتیب گام را تغییر داد.',
      TASKS_UPDATED: 'دامنه کارهای گام را تغییر داد.',
   };
   const normalized = activity.action.toUpperCase().replace(/^MILESTONE[._]/, '').replace(/[.]/g, '_');
   return labels[normalized] || 'گام را تغییر داد.';
}

function changedFieldSummary(activity: TaskaraActivity) {
   if (!activity.before || !activity.after) return '';
   const labels: Record<string, string> = {
      description: 'توضیح',
      health: 'سلامت',
      kind: 'نوع',
      name: 'نام',
      ownerId: 'مالک',
      startsOn: 'تاریخ شروع',
      targetOn: 'تاریخ هدف',
   };
   const fields = Object.keys(activity.after).filter((key) => activity.before?.[key] !== activity.after?.[key] && labels[key]).map((key) => labels[key]);
   return fields.length ? ` (${fields.join('، ')})` : '';
}

function mergeDetailResponse(previous: TaskaraMilestone, updated: TaskaraMilestone): TaskaraMilestone {
   const merged = {
      ...previous,
      ...updated,
      activity: updated.activity || previous.activity,
      tasks: updated.tasks || previous.tasks,
   };
   if (!updated.syncState) {
      delete merged.syncState;
      delete merged.syncMutationId;
   }
   return merged;
}

async function loadProjectMilestones(projectId: string) {
   const items: TaskaraMilestone[] = [];
   let offset = 0;
   let total = Number.POSITIVE_INFINITY;
   while (offset < total) {
      const params = new URLSearchParams({ projectId, limit: '200', offset: String(offset) });
      const page = await taskaraRequest<{ items: TaskaraMilestone[]; total: number }>(`/milestones?${params.toString()}`);
      items.push(...page.items);
      total = page.total;
      if (!page.items.length) break;
      offset += page.items.length;
   }
   return dedupeMilestoneList(items);
}

function dedupeMilestoneList(milestones: TaskaraMilestone[]) {
   return [...new Map(milestones.map((milestone) => [milestone.id, milestone])).values()];
}

function syncDrafts(
   milestone: TaskaraMilestone,
   setName: (value: string) => void,
   setDescription: (value: string) => void,
   setDates: (value: { startsOn: string; targetOn: string }) => void
) {
   setName(milestone.name);
   setDescription(milestone.description || '');
   setDates({ startsOn: milestone.startsOn || '', targetOn: milestone.targetOn || '' });
}

function descriptionToPlainText(value?: string | null) {
   if (!value) return '';
   try {
      const parsed = JSON.parse(value) as unknown;
      const text: string[] = [];
      collectText(parsed, text);
      return text.join(' ').replace(/\s+/g, ' ').trim();
   } catch {
      return value;
   }
}

function collectText(value: unknown, output: string[]) {
   if (!value || typeof value !== 'object') return;
   if ('text' in value && typeof (value as { text?: unknown }).text === 'string') {
      output.push((value as { text: string }).text);
   }
   if ('children' in value && Array.isArray((value as { children?: unknown }).children)) {
      for (const child of (value as { children: unknown[] }).children) collectText(child, output);
   }
   if ('root' in value) collectText((value as { root?: unknown }).root, output);
}
