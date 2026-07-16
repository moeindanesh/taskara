'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
   CheckCircle2,
   ChevronDown,
   Filter,
   Loader2,
   Plus,
   Search,
   X,
} from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LinearAvatar, ProjectGlyph } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   TaskaraMilestone,
   TaskaraMilestoneHealth,
   TaskaraMilestoneKind,
   TaskaraMilestoneListResponse,
   TaskaraMilestoneStatus,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';
import { EMPTY_SELECT_VALUE, fromSelectValue, toSelectValue } from '@/lib/select-utils';
import { openMilestoneCreate } from './milestone-dialog-host';
import { MilestoneDetail } from './milestone-detail';
import {
   isMilestoneOverdue,
   MilestoneEmptyState,
   MilestoneGlyph,
   MilestoneListSkeleton,
   MilestoneOverviewCard,
} from './primitives';

type HubSegment = 'open' | 'active' | 'planned' | 'completed' | 'all';
type ArchiveFilter = 'current' | 'include' | 'only';

const segmentStatuses: Record<HubSegment, TaskaraMilestoneStatus[] | null> = {
   open: ['PLANNED', 'ACTIVE'],
   active: ['ACTIVE'],
   planned: ['PLANNED'],
   completed: ['COMPLETED'],
   all: null,
};

const segmentOptions: Array<{ label: string; value: HubSegment }> = [
   { label: fa.milestone.all, value: 'all' },
   { label: fa.milestone.open, value: 'open' },
   { label: fa.milestone.active, value: 'active' },
   { label: fa.milestone.planned, value: 'planned' },
   { label: fa.milestone.completed, value: 'completed' },
];

export function MilestonesView() {
   const navigate = useNavigate();
   const { milestoneId, orgId } = useParams();
   const [searchParams, setSearchParams] = useSearchParams();
   const taskSync = useWorkspaceTaskSync();
   const [items, setItems] = useState<TaskaraMilestone[]>(() => taskSync.milestones);
   const [total, setTotal] = useState(taskSync.milestones.length);
   const [loadedServerCount, setLoadedServerCount] = useState(0);
   const [loading, setLoading] = useState(!taskSync.hasBootstrapped);
   const [refreshing, setRefreshing] = useState(false);
   const [loadingMore, setLoadingMore] = useState(false);
   const [error, setError] = useState('');
   const [showFilters, setShowFilters] = useState(false);
   const [searchDraft, setSearchDraft] = useState(searchParams.get('q') || '');
   const [isNavigating, startTransition] = useTransition();
   const requestRef = useRef(0);
   const itemsRef = useRef(items);
   const milestoneResourcesRef = useRef(taskSync.milestones);
   const workspaceSlug = orgId || 'taskara';
   const queryKey = searchParams.toString();
   const segment = parseSegment(searchParams.get('view'));
   const archiveFilter = parseArchiveFilter(searchParams.get('archive'));

   const updateParams = useCallback((patch: Record<string, string | null>, replace = true) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
         if (!value || isDefaultQueryValue(key, value)) next.delete(key);
         else next.set(key, value);
      }
      setSearchParams(next, { replace });
   }, [searchParams, setSearchParams]);

   useEffect(() => {
      const timer = window.setTimeout(() => {
         const current = searchParams.get('q') || '';
         const next = searchDraft.trim().slice(0, 200);
         if (next !== current) updateParams({ q: next || null });
      }, 250);
      return () => window.clearTimeout(timer);
   }, [searchDraft, searchParams, updateParams]);

   const load = useCallback(async (preserve = true, offset = 0) => {
      const requestId = ++requestRef.current;
      if (offset > 0) setLoadingMore(true);
      else if (preserve && itemsRef.current.length) setRefreshing(true);
      else setLoading(true);
      setError('');

      const query = buildMilestoneListQuery(new URLSearchParams(queryKey));
      query.set('offset', String(offset));
      try {
         const result = await taskaraRequest<TaskaraMilestoneListResponse | TaskaraMilestone[]>(
            `/milestones?${query.toString()}`
         );
         if (requestId !== requestRef.current) return;
         const normalized = normalizeMilestoneListResponse(result);
         const pendingResources = milestoneResourcesRef.current.filter(
            (milestone) => milestone.syncState === 'pending' && matchesClientFilters(milestone, new URLSearchParams(queryKey))
         );
         setItems((current) => {
            const serverItems = offset > 0 ? dedupeMilestones([...current, ...normalized.items]) : normalized.items;
            const pending = dedupeMilestones([
               ...current.filter((milestone) => milestone.syncState === 'pending'),
               ...pendingResources,
            ]);
            return pending.reduce(
               (next, milestone) => [milestone, ...next.filter((item) => item.id !== milestone.id)],
               serverItems
            );
         });
         const serverIds = new Set(normalized.items.map((milestone) => milestone.id));
         setTotal(normalized.total + pendingResources.filter((milestone) => !serverIds.has(milestone.id)).length);
         setLoadedServerCount(offset + normalized.items.length);
      } catch (loadError) {
         if (requestId !== requestRef.current) return;
         setError(loadError instanceof Error ? loadError.message : fa.milestone.loadingFailed);
      } finally {
         if (requestId === requestRef.current) {
            setLoading(false);
            setRefreshing(false);
            setLoadingMore(false);
         }
      }
   }, [queryKey]);

   useEffect(() => {
      itemsRef.current = items;
   }, [items]);

   useEffect(() => {
      void load(items.length > 0);
      return () => {
         requestRef.current += 1;
      };
      // The canonical query-string is the fetch key; cached item churn is merged separately.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [load, queryKey]);

   useEffect(() => {
      if (milestoneResourcesRef.current === taskSync.milestones) return;
      milestoneResourcesRef.current = taskSync.milestones;
      setItems((current) => mergeMilestoneResources(
         current,
         taskSync.milestones,
         (milestone) => matchesClientFilters(milestone, searchParams)
      ));
      void load(true);
   }, [load, queryKey, searchParams, taskSync.milestones]);

   useEffect(() => {
      const handleCreated = (event: Event) => {
         const milestone = event instanceof CustomEvent
            ? (event.detail as { milestone?: TaskaraMilestone } | undefined)?.milestone
            : undefined;
         if (!milestone) return;
         if (!matchesClientFilters(milestone, searchParams)) return;
         setItems((current) => {
            const exists = current.some((item) => item.id === milestone.id);
            if (!exists) setTotal((count) => count + 1);
            return [milestone, ...current.filter((item) => item.id !== milestone.id)];
         });
      };
      window.addEventListener('taskara:milestone-created', handleCreated);
      return () => window.removeEventListener('taskara:milestone-created', handleCreated);
   }, [searchParams]);

   const visibleItems = useMemo(
      () => items.filter((item) => matchesClientFilters(item, searchParams)).sort(compareMilestones),
      [items, searchParams]
   );
   const selectedSummary = useMemo(
      () => visibleItems.find((item) => item.id === milestoneId) ||
         items.find((item) => item.id === milestoneId) ||
         taskSync.milestones.find((item) => item.id === milestoneId) ||
         null,
      [items, milestoneId, taskSync.milestones, visibleItems]
   );
   const hasFilters = countActiveFilters(searchParams) > 0;
   const activeFilterCount = countActiveFilters(searchParams);
   const displayedTotal = total;

   function selectMilestone(id: string) {
      startTransition(() => {
         navigate(`/${workspaceSlug}/milestones/${encodeURIComponent(id)}?${searchParams.toString()}`);
      });
   }

   function handleChanged(milestone: TaskaraMilestone) {
      setItems((current) => {
         const index = current.findIndex((item) => item.id === milestone.id);
         const nowMatches = matchesClientFilters(milestone, searchParams);
         if (index === -1) {
            if (!nowMatches) return current;
            setTotal((count) => count + 1);
            return [milestone, ...current];
         }
         if (!nowMatches) {
            setTotal((count) => Math.max(0, count - 1));
            return current.filter((item) => item.id !== milestone.id);
         }
         return current.map((item) => item.id === milestone.id ? milestone : item);
      });
      void taskSync.refresh({ preserveVisibleState: true });
   }

   function clearFilters() {
      setSearchDraft('');
      setSearchParams(new URLSearchParams(), { replace: true });
   }

   if (milestoneId) {
      return (
         <section className="h-full min-h-0 bg-background text-foreground [direction:rtl]" data-testid="milestones-screen">
            <main className="h-full min-h-0">
               <MilestoneDetail
                  key={milestoneId}
                  milestoneId={milestoneId}
                  milestoneSummary={selectedSummary}
                  workspaceSlug={workspaceSlug}
                  onBack={() => navigate(`/${workspaceSlug}/milestones?${searchParams.toString()}`)}
                  onChanged={handleChanged}
               />
            </main>
         </section>
      );
   }

   return (
      <section className="h-full min-h-0 overflow-y-auto overscroll-contain bg-background text-foreground [direction:rtl]" data-testid="milestones-screen">
         <div className="mx-auto w-full max-w-[1480px] px-4 py-5 sm:px-6 lg:px-10 lg:py-8">
            <header className="relative overflow-hidden rounded-3xl border border-border/70 bg-card/65 px-5 py-5 sm:px-6 sm:py-6">
               <span aria-hidden="true" className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-indigo-400/10 blur-3xl" />
               <span aria-hidden="true" className="pointer-events-none absolute -bottom-28 left-1/4 size-48 rounded-full bg-violet-400/8 blur-3xl" />
               <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                     <MilestoneGlyph className="mt-0.5 size-11 rounded-2xl" />
                     <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                           <h1 className="text-xl leading-8">{fa.milestone.title}</h1>
                           <span className="rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground">
                              {displayedTotal.toLocaleString('fa-IR')} گام
                           </span>
                           {refreshing ? <Loader2 aria-label={fa.app.loading} className="size-3.5 animate-spin text-muted-foreground" /> : null}
                        </div>
                        <p className="mt-1.5 max-w-2xl text-xs leading-6 text-muted-foreground">{fa.pages.milestonesDescription}</p>
                     </div>
                  </div>
                  <Button
                     aria-label={fa.milestone.newMilestone}
                     className="h-10 shrink-0 rounded-full bg-indigo-500 px-4 text-white hover:bg-indigo-400"
                     size="sm"
                     onClick={() => openMilestoneCreate({
                        navigateOnCreate: true,
                        projectId: searchParams.get('projectId') || undefined,
                     })}
                  >
                     <Plus className="size-4" />
                     {fa.milestone.newMilestone}
                  </Button>
               </div>
            </header>

            <section className="mt-5 rounded-2xl border border-border/70 bg-card/45 p-2.5 sm:p-3" aria-label={fa.milestone.filters}>
               <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                  <div className="relative min-w-0 flex-1">
                     <Search className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                     <Input
                        aria-label={fa.milestone.searchPlaceholder}
                        className="h-10 border-border/70 bg-background/60 ps-10 pe-10 text-sm"
                        placeholder={fa.milestone.searchPlaceholder}
                        value={searchDraft}
                        onChange={(event) => setSearchDraft(event.target.value)}
                     />
                     {searchDraft ? (
                        <button
                           aria-label={fa.app.clear}
                           className="absolute left-1.5 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                           type="button"
                           onClick={() => setSearchDraft('')}
                        >
                           <X className="size-3.5" />
                        </button>
                     ) : null}
                  </div>
                  <button
                     aria-expanded={showFilters}
                     aria-label={fa.milestone.filters}
                     className={cn(
                        'relative inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-border/70 px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground',
                        (showFilters || activeFilterCount > 0) && 'border-indigo-400/30 bg-indigo-400/10 text-indigo-600 dark:text-indigo-300'
                     )}
                     type="button"
                     onClick={() => setShowFilters((current) => !current)}
                  >
                     <Filter className="size-4" />
                     <span>{fa.milestone.filters}</span>
                     {activeFilterCount > 0 ? (
                        <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-indigo-500 px-1 text-[9px] leading-4 text-white">
                           {activeFilterCount.toLocaleString('fa-IR')}
                        </span>
                     ) : null}
                  </button>
                  <div className="scrollbar-none flex min-w-0 gap-1 overflow-x-auto border-t border-border/60 pt-2 lg:border-t-0 lg:border-r lg:pr-2 lg:pt-0" role="tablist" aria-label={fa.milestone.status}>
                     {segmentOptions.map((option) => (
                        <button
                           aria-selected={segment === option.value}
                           className={cn(
                              'h-9 shrink-0 rounded-full px-3 text-xs transition',
                              segment === option.value
                                 ? 'bg-indigo-500 text-white'
                                 : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                           )}
                           key={option.value}
                           role="tab"
                           type="button"
                           onClick={() => updateParams({ view: option.value })}
                        >
                           {option.label}
                        </button>
                     ))}
                  </div>
               </div>

               {showFilters ? (
                  <MilestoneFilters
                     archiveFilter={archiveFilter}
                     health={searchParams.get('health') || ''}
                     kind={searchParams.get('kind') || ''}
                     overdue={searchParams.get('overdue') === 'true'}
                     ownerId={searchParams.get('ownerId') || ''}
                     projectId={searchParams.get('projectId') || ''}
                     projects={taskSync.projects}
                     teamId={searchParams.get('teamId') || ''}
                     teams={taskSync.teams}
                     users={taskSync.users}
                     onChange={(key, value) => {
                        if (key === 'archive' && value === 'only') {
                           updateParams({ archive: value, view: 'all' });
                           return;
                        }
                        updateParams({ [key]: value || null });
                     }}
                     onClear={clearFilters}
                  />
               ) : null}
            </section>

            {error ? (
               <div className="mt-4 flex items-start justify-between gap-3 rounded-2xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-xs text-destructive-foreground" role="alert">
                  <span className="min-w-0 leading-5">{error}</span>
                  <button className="shrink-0 underline underline-offset-2" type="button" onClick={() => void load(true)}>
                     {fa.milestone.retry}
                  </button>
               </div>
            ) : null}

            <MilestoneHubStats items={visibleItems} total={displayedTotal} />

            <div className="mt-7 flex flex-wrap items-end justify-between gap-3">
               <div>
                  <h2 className="text-base">مرور اهداف</h2>
                  <p className="mt-1 text-xs text-muted-foreground">برای مشاهده جزئیات، برنامه‌ریزی و ویرایش، یک گام را باز کنید.</p>
               </div>
               <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground">
                  {visibleItems.length.toLocaleString('fa-IR')} نمایش داده می‌شود
               </span>
            </div>

            <div className="mt-3" aria-busy={loading || refreshing}>
               {loading && !items.length ? (
                  <MilestoneListSkeleton />
               ) : visibleItems.length ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="list" aria-label={fa.milestone.title}>
                     {visibleItems.map((milestone) => (
                        <div key={milestone.id} role="listitem">
                           <MilestoneOverviewCard milestone={milestone} onSelect={() => selectMilestone(milestone.id)} />
                        </div>
                     ))}
                  </div>
               ) : (
                  <MilestoneEmptyState
                     action={hasFilters ? (
                        <Button className="rounded-full" size="sm" variant="secondary" onClick={clearFilters}>
                           {fa.milestone.clearFilters}
                        </Button>
                     ) : undefined}
                     description={hasFilters ? undefined : fa.milestone.noMilestonesDescription}
                  >
                     {hasFilters ? fa.milestone.noFilteredResults : fa.milestone.noMilestones}
                  </MilestoneEmptyState>
               )}
            </div>

            {loadedServerCount < total ? (
               <div className="flex justify-center py-7">
                  <Button
                     className="rounded-full"
                     disabled={loadingMore}
                     size="sm"
                     variant="secondary"
                     onClick={() => void load(true, loadedServerCount)}
                  >
                     {loadingMore ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                     نمایش گام‌های بیشتر
                  </Button>
               </div>
            ) : null}
            <div className="sr-only" aria-live="polite">
               {refreshing ? fa.app.loading : `${visibleItems.length.toLocaleString('fa-IR')} ${fa.milestone.title}`}
            </div>
         </div>
         {isNavigating ? <span className="sr-only" aria-live="polite">{fa.app.loading}</span> : null}
      </section>
   );
}

function MilestoneHubStats({
   items,
   total,
}: {
   items: TaskaraMilestone[];
   total: number;
}) {
   const attentionCount = items.filter(
      (milestone) =>
         isMilestoneOverdue(milestone) ||
         milestone.health === 'AT_RISK' ||
         milestone.health === 'OFF_TRACK' ||
         milestone.progress.blockedTasks > 0
   ).length;
   const stats = [
      { label: fa.milestone.all, value: total },
      { label: fa.milestone.active, value: items.filter((milestone) => milestone.status === 'ACTIVE').length },
      { label: fa.milestone.attention, value: attentionCount, tone: attentionCount ? 'text-amber-700 dark:text-amber-300' : undefined },
      { label: fa.milestone.completed, value: items.filter((milestone) => milestone.status === 'COMPLETED').length, tone: 'text-emerald-700 dark:text-emerald-300' },
   ];

   return (
      <dl className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="خلاصه گام‌ها">
         {stats.map((stat) => (
            <div className="rounded-2xl border border-border/65 bg-card/45 px-3 py-3" key={stat.label}>
               <dt className="text-[11px] text-muted-foreground">{stat.label}</dt>
               <dd className={cn('mt-1 text-lg tabular-nums text-foreground', stat.tone)}>{stat.value.toLocaleString('fa-IR')}</dd>
            </div>
         ))}
      </dl>
   );
}

function MilestoneFilters({
   archiveFilter,
   health,
   kind,
   overdue,
   ownerId,
   projectId,
   projects,
   teamId,
   teams,
   users,
   onChange,
   onClear,
}: {
   archiveFilter: ArchiveFilter;
   health: string;
   kind: string;
   overdue: boolean;
   ownerId: string;
   projectId: string;
   projects: ReturnType<typeof useWorkspaceTaskSync>['projects'];
   teamId: string;
   teams: ReturnType<typeof useWorkspaceTaskSync>['teams'];
   users: ReturnType<typeof useWorkspaceTaskSync>['users'];
   onChange: (key: string, value: string) => void;
   onClear: () => void;
}) {
   return (
      <div className="mt-3 rounded-xl border border-border/70 bg-background/70 p-3 shadow-sm">
         <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <FilterSelect
               ariaLabel={fa.milestone.project}
               value={projectId}
               placeholder={fa.milestone.project}
               onChange={(value) => onChange('projectId', value)}
            >
               {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                     <span className="flex min-w-0 items-center gap-2">
                        <ProjectGlyph className="size-4 rounded" iconClassName="size-3" name={project.name} />
                        <span className="truncate">{project.name}</span>
                     </span>
                  </SelectItem>
               ))}
            </FilterSelect>
            <FilterSelect
               ariaLabel={fa.milestone.team}
               value={teamId}
               placeholder={fa.milestone.team}
               onChange={(value) => onChange('teamId', value)}
            >
               {teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}
            </FilterSelect>
            <FilterSelect
               ariaLabel={fa.milestone.owner}
               value={ownerId}
               placeholder={fa.milestone.owner}
               onChange={(value) => onChange('ownerId', value)}
            >
               <SelectItem value="none">{fa.milestone.noOwner}</SelectItem>
               {users.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                     <span className="flex items-center gap-2">
                        <LinearAvatar className="size-4" name={user.name} src={user.avatarUrl} />
                        {user.name}
                     </span>
                  </SelectItem>
               ))}
            </FilterSelect>
            <FilterSelect
               ariaLabel={fa.milestone.kind}
               value={kind}
               placeholder={fa.milestone.kind}
               onChange={(value) => onChange('kind', value)}
            >
               <SelectItem value="FEATURE">{fa.milestone.feature}</SelectItem>
               <SelectItem value="PHASE">{fa.milestone.phase}</SelectItem>
               <SelectItem value="OTHER">{fa.milestone.other}</SelectItem>
            </FilterSelect>
            <FilterSelect
               ariaLabel={fa.milestone.health}
               value={health}
               placeholder={fa.milestone.health}
               onChange={(value) => onChange('health', value)}
            >
               <SelectItem value="none">{fa.milestone.noHealth}</SelectItem>
               <SelectItem value="ON_TRACK">{fa.milestone.healthOnTrack}</SelectItem>
               <SelectItem value="AT_RISK">{fa.milestone.healthAtRisk}</SelectItem>
               <SelectItem value="OFF_TRACK">{fa.milestone.healthOffTrack}</SelectItem>
            </FilterSelect>
            <FilterSelect
               ariaLabel={fa.milestone.archived}
               value={archiveFilter === 'current' ? '' : archiveFilter}
               placeholder={fa.milestone.archived}
               onChange={(value) => onChange('archive', value)}
            >
               <SelectItem value="include">{fa.milestone.includeArchived}</SelectItem>
               <SelectItem value="only">{fa.milestone.archived}</SelectItem>
            </FilterSelect>
         </div>
         <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <button
               aria-pressed={overdue}
               className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs transition',
                  overdue ? 'bg-rose-400/10 text-rose-600 dark:text-rose-300' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
               )}
               type="button"
               onClick={() => onChange('overdue', overdue ? '' : 'true')}
            >
               <CheckCircle2 className="size-3.5" />
               {fa.milestone.overdueOnly}
            </button>
            <button className="h-8 text-xs text-muted-foreground hover:text-foreground" type="button" onClick={onClear}>
               {fa.milestone.clearFilters}
            </button>
         </div>
      </div>
   );
}

function FilterSelect({
   ariaLabel,
   children,
   placeholder,
   value,
   onChange,
}: {
   ariaLabel: string;
   children: React.ReactNode;
   placeholder: string;
   value: string;
   onChange: (value: string) => void;
}) {
   return (
      <Select value={toSelectValue(value)} onValueChange={(next) => onChange(fromSelectValue(next))}>
         <SelectTrigger aria-label={ariaLabel} className="h-9 border-border/70 bg-card text-xs">
            <SelectValue placeholder={placeholder} />
         </SelectTrigger>
         <SelectContent className="max-h-72 rounded-xl [direction:rtl]">
            <SelectItem value={EMPTY_SELECT_VALUE}>{placeholder}: {fa.milestone.all}</SelectItem>
            {children}
         </SelectContent>
      </Select>
   );
}

function buildMilestoneListQuery(searchParams: URLSearchParams) {
   const segment = parseSegment(searchParams.get('view'));
   const archive = parseArchiveFilter(searchParams.get('archive'));
   const params = new URLSearchParams({ limit: '200', offset: '0' });
   const statuses = segmentStatuses[segment];
   if (statuses) params.set('status', statuses.join(','));
   for (const key of ['projectId', 'teamId', 'ownerId', 'kind', 'health', 'q'] as const) {
      const value = searchParams.get(key)?.trim();
      if (value) params.set(key, value);
   }
   if (searchParams.get('overdue') === 'true') params.set('overdue', 'true');
   if (archive !== 'current') params.set('includeArchived', 'true');
   if (archive === 'only') params.set('archivedOnly', 'true');
   return params;
}

function normalizeMilestoneListResponse(
   result: TaskaraMilestoneListResponse | TaskaraMilestone[]
): { items: TaskaraMilestone[]; total: number } {
   if (Array.isArray(result)) return { items: result, total: result.length };
   return {
      items: Array.isArray(result.items) ? result.items : [],
      total: Number.isFinite(result.total) ? result.total : result.items?.length || 0,
   };
}

function parseSegment(value: string | null): HubSegment {
   return value === 'open' || value === 'active' || value === 'planned' || value === 'completed' || value === 'all' ? value : 'all';
}

function parseArchiveFilter(value: string | null): ArchiveFilter {
   return value === 'include' || value === 'only' ? value : 'current';
}

function isDefaultQueryValue(key: string, value: string) {
   return key === 'view' && value === 'all' || key === 'archive' && value === 'current';
}

function countActiveFilters(searchParams: URLSearchParams) {
   return ['projectId', 'teamId', 'ownerId', 'kind', 'health', 'overdue', 'archive']
      .filter((key) => Boolean(searchParams.get(key))).length;
}

function matchesClientFilters(milestone: TaskaraMilestone, searchParams: URLSearchParams) {
   const archive = parseArchiveFilter(searchParams.get('archive'));
   if (archive === 'current' && milestone.archivedAt) return false;
   if (archive === 'only' && !milestone.archivedAt) return false;

   const statuses = segmentStatuses[parseSegment(searchParams.get('view'))];
   if (statuses && !statuses.includes(milestone.status)) return false;
   const projectId = searchParams.get('projectId');
   if (projectId && milestone.projectId !== projectId) return false;
   const teamId = searchParams.get('teamId');
   if (teamId && milestone.project.team?.id !== teamId && milestone.project.teamId !== teamId) return false;
   const ownerId = searchParams.get('ownerId');
   if (ownerId === 'none' && (milestone.ownerId || milestone.owner)) return false;
   if (ownerId && ownerId !== 'none' && milestone.ownerId !== ownerId && milestone.owner?.id !== ownerId) return false;
   const kind = searchParams.get('kind') as TaskaraMilestoneKind | null;
   if (kind && milestone.kind !== kind) return false;
   const health = searchParams.get('health') as TaskaraMilestoneHealth | 'none' | null;
   if (health === 'none' && milestone.health) return false;
   if (health && health !== 'none' && milestone.health !== health) return false;
   if (searchParams.get('overdue') === 'true' && !isMilestoneOverdue(milestone)) return false;
   const q = searchParams.get('q')?.trim().toLocaleLowerCase('fa');
   if (q && ![
      milestone.name,
      milestone.description || '',
      milestone.project.name,
      milestone.project.keyPrefix,
      milestone.project.team?.name || '',
      milestone.owner?.name || '',
   ].join(' ').toLocaleLowerCase('fa').includes(q)) return false;
   return true;
}

export function compareMilestones(left: TaskaraMilestone, right: TaskaraMilestone) {
   const overdueDifference = Number(isMilestoneOverdue(right)) - Number(isMilestoneOverdue(left));
   if (overdueDifference) return overdueDifference;
   const healthRank: Record<string, number> = { OFF_TRACK: 0, AT_RISK: 1, ON_TRACK: 2, '': 3 };
   const healthDifference = healthRank[left.health || ''] - healthRank[right.health || ''];
   if (healthDifference) return healthDifference;
   if (left.targetOn && right.targetOn && left.targetOn !== right.targetOn) return left.targetOn.localeCompare(right.targetOn);
   if (left.targetOn && !right.targetOn) return -1;
   if (!left.targetOn && right.targetOn) return 1;
   const projectDifference = left.project.name.localeCompare(right.project.name, 'fa');
   if (projectDifference) return projectDifference;
   if (left.projectId !== right.projectId) return left.projectId.localeCompare(right.projectId);
   if (left.position !== right.position) return left.position - right.position;
   const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
   return updatedDifference || left.id.localeCompare(right.id);
}

function mergeMilestoneResources(
   current: TaskaraMilestone[],
   resources: TaskaraMilestone[],
   shouldAdd: (milestone: TaskaraMilestone) => boolean
) {
   if (!current.length) return resources;
   const byId = new Map(resources.map((item) => [item.id, item]));
   const merged = current.map((item) => byId.get(item.id) || item);
   const currentIds = new Set(current.map((item) => item.id));
   for (const resource of resources) {
      if (!currentIds.has(resource.id) && shouldAdd(resource)) merged.push(resource);
   }
   return merged;
}

function dedupeMilestones(milestones: TaskaraMilestone[]) {
   return [...new Map(milestones.map((milestone) => [milestone.id, milestone])).values()];
}
