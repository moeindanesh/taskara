'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
   ArrowUpRight,
   Blocks,
   CalendarPlus,
   CheckCircle2,
   CircleDot,
   GitPullRequest,
   MessageSquarePlus,
   Plus,
   RefreshCw,
   SlidersHorizontal,
   Timer,
   UserRound,
   Users,
} from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
   LinearAvatar,
   ProjectGlyph,
   StatusIcon,
   linearPriorityMeta,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate, formatJalaliDateTime } from '@/lib/jalali';
import { dispatchWorkspaceRefresh, useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { isRetryableTaskSyncError, sendTaskSyncMutation } from '@/lib/task-sync';
import { taskaraRequest } from '@/lib/taskara-client';
import type {
   TaskaraCheckInMissingResponse,
   TaskaraOneOnOneSeries,
   TaskaraTask,
   WorkHealthPerson,
   WorkHealthSummary,
} from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

type PeopleFilter = 'risk' | 'all' | 'overloaded' | 'blocked' | 'review' | 'idle';

const numberFormatter = new Intl.NumberFormat('fa-IR');

export function PeopleWorkloadView() {
   const { orgId = 'taskara' } = useParams();
   const navigate = useNavigate();
   const [searchParams] = useSearchParams();
   const highlightedPersonId = searchParams.get('person') || '';
   const [filter, setFilter] = useState<PeopleFilter>('risk');
   const [summary, setSummary] = useState<WorkHealthSummary | null>(null);
   const [missingCheckIns, setMissingCheckIns] = useState<TaskaraCheckInMissingResponse | null>(null);
   const [oneOnOnes, setOneOnOnes] = useState<TaskaraOneOnOneSeries[]>([]);
   const [loading, setLoading] = useState(true);
   const [refreshing, setRefreshing] = useState(false);
   const [error, setError] = useState('');
   const [pendingOneOnOneUserId, setPendingOneOnOneUserId] = useState<string | null>(null);
   const requestRef = useRef(0);

   const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
      const requestId = ++requestRef.current;
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);
      setError('');

      const [summaryResult, missingResult, oneOnOneResult] = await Promise.allSettled([
         taskaraRequest<WorkHealthSummary>('/work-health/summary'),
         taskaraRequest<TaskaraCheckInMissingResponse>('/check-ins/missing').catch(() => null),
         taskaraRequest<{ items: TaskaraOneOnOneSeries[] }>('/one-on-ones?active=true&limit=100').catch(() => ({ items: [] })),
      ]);

      if (requestId !== requestRef.current) return;

      if (summaryResult.status === 'fulfilled') {
         setSummary(summaryResult.value);
         setMissingCheckIns(missingResult.status === 'fulfilled' ? missingResult.value : null);
         setOneOnOnes(oneOnOneResult.status === 'fulfilled' ? oneOnOneResult.value.items : []);
      } else {
         setError(summaryResult.reason instanceof Error ? summaryResult.reason.message : fa.peopleWorkload.loadFailed);
      }

      setLoading(false);
      setRefreshing(false);
   }, []);

   useEffect(() => {
      void load();
   }, [load]);

   useLiveRefresh(() => load('refresh'), {
      fireOnMount: false,
      workspaceEventFilter: peopleWorkloadRefreshSourceMatches,
   });

   const missingByUserId = useMemo(() => {
      const map = new Map<string, TaskaraCheckInMissingResponse['items'][number]>();
      for (const item of missingCheckIns?.items || []) map.set(item.user.id, item);
      return map;
   }, [missingCheckIns]);

   const oneOnOneByParticipantId = useMemo(() => {
      const map = new Map<string, TaskaraOneOnOneSeries>();
      for (const series of oneOnOnes) map.set(series.participantId, series);
      return map;
   }, [oneOnOnes]);

   const visiblePeople = useMemo(() => {
      const people = [...(summary?.people || [])]
         .filter((person) => matchesPeopleFilter(person, filter, missingByUserId, oneOnOneByParticipantId))
         .sort((left, right) => comparePeopleForManager(left, right, highlightedPersonId, missingByUserId, oneOnOneByParticipantId));
      return people;
   }, [filter, highlightedPersonId, missingByUserId, oneOnOneByParticipantId, summary?.people]);

   const metrics = useMemo(() => {
      const people = summary?.people || [];
      return {
         people: people.length,
         overloaded: people.filter((person) => person.status === 'overloaded').length,
         blocked: people.filter((person) => person.blockedCount > 0 || person.overdueCount > 0).length,
         review: people.filter((person) => person.reviewCount > 0).length,
         missingCheckIn: missingCheckIns?.total || 0,
      };
   }, [missingCheckIns?.total, summary?.people]);

   function openAssignedTaskComposer(person: WorkHealthPerson) {
      window.dispatchEvent(new CustomEvent('taskara:create-issue', { detail: { assigneeId: person.user.id } }));
   }

   async function createOrOpenOneOnOne(person: WorkHealthPerson) {
      const existing = oneOnOneByParticipantId.get(person.user.id);
      if (existing) {
         navigate(`/${orgId}/cockpit`);
         return;
      }

      setPendingOneOnOneUserId(person.user.id);
      try {
         const { entity: created } = await sendTaskSyncMutation<TaskaraOneOnOneSeries>(
            'one_on_one.create',
            { participantId: person.user.id, cadenceDays: 14 },
            undefined,
            undefined,
            { keepPendingOnRetryable: true }
         );
         if (!created) throw new Error(fa.peopleWorkload.oneOnOneFailed);
         setOneOnOnes((current) => [created, ...current.filter((item) => item.participantId !== created.participantId)]);
         dispatchWorkspaceRefresh({ source: 'one-on-one:create' });
         toast.success(fa.peopleWorkload.oneOnOneCreated);
      } catch (createError) {
         if (isRetryableTaskSyncError(createError)) {
            toast.message(fa.peopleWorkload.oneOnOneQueued);
            return;
         }
         toast.error(createError instanceof Error ? createError.message : fa.peopleWorkload.oneOnOneFailed);
      } finally {
         setPendingOneOnOneUserId(null);
      }
   }

   async function copyCheckInRequest(person: WorkHealthPerson) {
      const text = fa.peopleWorkload.checkInRequestText(person.user.mattermostUsername ? `@${person.user.mattermostUsername}` : person.user.name);
      try {
         await navigator.clipboard?.writeText(text);
         toast.success(fa.peopleWorkload.copiedCheckInRequest);
      } catch {
         toast.message(text, { description: fa.peopleWorkload.checkInCopyFailed });
      }
   }

   return (
      <div className="flex min-h-full flex-col bg-background text-zinc-900 dark:bg-[#101011] dark:text-zinc-100" data-testid="people-workload-screen">
         <div className="sticky top-0 z-10 border-b border-zinc-200 bg-background/95 px-4 py-3 backdrop-blur dark:border-white/8 dark:bg-[#101011]/95 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
               <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                     {summary?.generatedAt ? (
                        <span>{fa.peopleWorkload.generatedAt}: {formatJalaliDateTime(summary.generatedAt)}</span>
                     ) : (
                        <span>{fa.peopleWorkload.description}</span>
                     )}
                     {summary?.overview.truncated ? (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-amber-700 dark:text-amber-200">
                           {fa.peopleWorkload.truncated}
                        </span>
                     ) : null}
                  </div>
               </div>
               <div className="flex flex-wrap items-center gap-1.5">
                  <Button asChild size="xs" variant="outline" className="h-8 gap-1.5">
                     <Link to={`/${orgId}/capacity`}>
                        <SlidersHorizontal className="size-3.5" />
                        {fa.nav.capacitySettings}
                     </Link>
                  </Button>
                  <Button size="xs" variant="outline" className="h-8 gap-1.5" onClick={() => void load('refresh')} disabled={refreshing}>
                     <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                     {fa.peopleWorkload.refresh}
                  </Button>
               </div>
            </div>
         </div>

         <main className="space-y-4 p-4 sm:p-6">
            {error ? (
               <div className="rounded-md border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
                  {error}
               </div>
            ) : null}

            {loading && !summary ? (
               <PeopleWorkloadSkeleton />
            ) : summary ? (
               <>
                  <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                     <MetricTile icon={Users} label={fa.peopleWorkload.peopleMetric} value={metrics.people} />
                     <MetricTile icon={UserRound} label={fa.peopleWorkload.overloadedMetric} value={metrics.overloaded} tone={metrics.overloaded ? 'danger' : 'default'} />
                     <MetricTile icon={Blocks} label={fa.peopleWorkload.blockedMetric} value={metrics.blocked} tone={metrics.blocked ? 'danger' : 'default'} />
                     <MetricTile icon={GitPullRequest} label={fa.peopleWorkload.reviewMetric} value={metrics.review} tone={metrics.review ? 'warning' : 'default'} />
                     <MetricTile icon={Timer} label={fa.peopleWorkload.missingCheckInMetric} value={metrics.missingCheckIn} tone={metrics.missingCheckIn ? 'warning' : 'default'} />
                  </section>

                  <div className="flex flex-wrap gap-1.5">
                     {peopleFilters.map((item) => (
                        <button
                           key={item}
                           className={filterButtonClassName(filter === item)}
                           type="button"
                           onClick={() => setFilter(item)}
                        >
                           {peopleFilterLabel(item)}
                        </button>
                     ))}
                  </div>

                  {visiblePeople.length ? (
                     <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-white/8 dark:bg-[#161618]">
                        <div className="divide-y divide-zinc-200 dark:divide-white/7">
                           {visiblePeople.map((person) => (
                              <PersonWorkloadRow
                                 highlighted={person.user.id === highlightedPersonId}
                                 key={person.user.id}
                                 missingCheckIn={missingByUserId.get(person.user.id) || null}
                                 oneOnOne={oneOnOneByParticipantId.get(person.user.id) || null}
                                 orgId={orgId}
                                 pendingOneOnOne={pendingOneOnOneUserId === person.user.id}
                                 person={person}
                                 onAssignTask={() => openAssignedTaskComposer(person)}
                                 onCopyCheckIn={() => void copyCheckInRequest(person)}
                                 onCreateOrOpenOneOnOne={() => void createOrOpenOneOnOne(person)}
                              />
                           ))}
                        </div>
                     </section>
                  ) : (
                     <EmptyState
                        title={summary.people.length ? fa.peopleWorkload.noFilteredPeople : fa.peopleWorkload.noPeople}
                        description={summary.people.length ? fa.peopleWorkload.noFilteredPeopleDescription : fa.peopleWorkload.noPeopleDescription}
                     />
                  )}
               </>
            ) : (
               <EmptyState title={fa.peopleWorkload.noPeople} description={fa.peopleWorkload.noPeopleDescription} />
            )}
         </main>
      </div>
   );
}

function PersonWorkloadRow({
   highlighted,
   missingCheckIn,
   oneOnOne,
   onAssignTask,
   onCopyCheckIn,
   onCreateOrOpenOneOnOne,
   orgId,
   pendingOneOnOne,
   person,
}: {
   highlighted: boolean;
   missingCheckIn: TaskaraCheckInMissingResponse['items'][number] | null;
   oneOnOne: TaskaraOneOnOneSeries | null;
   onAssignTask: () => void;
   onCopyCheckIn: () => void;
   onCreateOrOpenOneOnOne: () => void;
   orgId: string;
   pendingOneOnOne: boolean;
   person: WorkHealthPerson;
}) {
   const loadPercent = person.capacity > 0 ? Math.round(person.loadRatio * 100) : person.activeWeight > 0 ? 100 : 0;
   const dueOneOnOne = oneOnOne && (!oneOnOne.nextScheduledAt || Date.parse(oneOnOne.nextScheduledAt) <= Date.now() + 7 * 24 * 60 * 60 * 1000);

   return (
      <article className={cn('grid gap-4 p-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1fr)_auto] lg:items-start', highlighted && 'bg-indigo-400/8 ring-1 ring-inset ring-indigo-400/25')}>
         <div className="min-w-0">
            <div className="flex min-w-0 items-start gap-3">
               <LinearAvatar name={person.user.name} src={person.user.avatarUrl} className="size-9 shrink-0" />
               <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{person.user.name}</div>
                  <div className="ltr truncate text-xs text-zinc-500">{person.user.email}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                     <span className={cn('rounded-full border px-2 py-0.5', workloadClassName(person.status))}>
                        {workloadLabel(person.status)}
                     </span>
                     {missingCheckIn ? (
                        <span className="rounded-full border border-amber-300/60 bg-amber-300/10 px-2 py-0.5 text-amber-700 dark:border-amber-400/20 dark:text-amber-200">
                           {missingCheckIn.hoursSinceLastCheckIn === null ? fa.peopleWorkload.noCheckInYet : fa.peopleWorkload.checkInAge(missingCheckIn.hoursSinceLastCheckIn)}
                        </span>
                     ) : null}
                     {dueOneOnOne ? (
                        <span className="rounded-full border border-sky-300/60 bg-sky-300/10 px-2 py-0.5 text-sky-700 dark:border-sky-400/20 dark:text-sky-200">
                           {fa.peopleWorkload.oneOnOneDue}
                        </span>
                     ) : null}
                  </div>
               </div>
            </div>

            <div className="mt-3">
               <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-zinc-500">
                  <span>{fa.peopleWorkload.capacityLoad(person.activeWeight, person.capacity)}</span>
                  <span>{fa.peopleWorkload.todayLoad(person.todayWeight)}</span>
               </div>
               <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/8">
                  <div
                     className={cn('h-full rounded-full', workloadBarClassName(person.status))}
                     style={{ width: `${Math.min(100, Math.max(person.activeWeight > 0 ? 3 : 0, loadPercent))}%` }}
                  />
               </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5 text-xs text-zinc-500">
               <DiagnosticPill label={fa.peopleWorkload.active} value={person.activeCount} />
               <DiagnosticPill label={fa.peopleWorkload.review} value={person.reviewCount} tone={person.reviewCount ? 'warning' : 'default'} />
               <DiagnosticPill label={fa.peopleWorkload.blocked} value={person.blockedCount} tone={person.blockedCount ? 'danger' : 'default'} />
               <DiagnosticPill label={fa.teamHealth.overdue} value={person.overdueCount} tone={person.overdueCount ? 'danger' : 'default'} />
               <DiagnosticPill label={fa.teamHealth.stale} value={person.staleCount} tone={person.staleCount ? 'warning' : 'default'} />
            </div>

            {oneOnOne?.nextScheduledAt ? (
               <div className="mt-2 text-xs text-zinc-500">
                  {fa.peopleWorkload.nextOneOnOne(formatJalaliDate(oneOnOne.nextScheduledAt))}
               </div>
            ) : null}
         </div>

         <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-500">
               <CircleDot className="size-3.5" />
               {fa.peopleWorkload.activeTasks}
            </div>
            {person.tasks.length ? (
               <div className="space-y-1.5">
                  {person.tasks.slice(0, 5).map((task) => (
                     <PersonTaskRow key={task.id} orgId={orgId} task={task} />
                  ))}
               </div>
            ) : (
               <div className="rounded-md border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500 dark:border-white/10">
                  {fa.peopleWorkload.noActiveTasks}
               </div>
            )}
         </div>

         <div className="flex flex-wrap items-center gap-1.5 lg:w-36 lg:flex-col lg:items-stretch">
            <Button size="xs" className="h-8 gap-1.5" onClick={onAssignTask}>
               <Plus className="size-3.5" />
               {fa.peopleWorkload.assignTask}
            </Button>
            <Button size="xs" variant="outline" className="h-8 gap-1.5" disabled={pendingOneOnOne} onClick={onCreateOrOpenOneOnOne}>
               {pendingOneOnOne ? <RefreshCw className="size-3.5 animate-spin" /> : <CalendarPlus className="size-3.5" />}
               {oneOnOne ? fa.peopleWorkload.openOneOnOne : fa.peopleWorkload.createOneOnOne}
            </Button>
            <Button asChild size="xs" variant="outline" className="h-8 gap-1.5">
               <Link to={`/${orgId}/meetings`}>
                  <MessageSquarePlus className="size-3.5" />
                  {fa.peopleWorkload.scheduleSync}
               </Link>
            </Button>
            <Button size="xs" variant="ghost" className="h-8 gap-1.5 text-zinc-500" onClick={onCopyCheckIn}>
               <MessageSquarePlus className="size-3.5" />
               {fa.peopleWorkload.requestCheckIn}
            </Button>
         </div>
      </article>
   );
}

function PersonTaskRow({ orgId, task }: { orgId: string; task: TaskaraTask }) {
   const PriorityIcon = linearPriorityMeta[task.priority]?.icon || CircleDot;

   return (
      <Link
         className="grid min-w-0 gap-2 rounded-md border border-zinc-200 px-2.5 py-2 text-xs transition hover:bg-zinc-100 dark:border-white/8 dark:hover:bg-white/6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
         to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}
      >
         <span className="min-w-0">
            <span className="mb-1 flex min-w-0 items-center gap-1.5">
               <StatusIcon status={task.status} className="size-3.5 shrink-0" />
               <span className="font-mono text-[11px] text-zinc-500">{task.key}</span>
               <span className="truncate text-zinc-900 dark:text-zinc-100">{task.title}</span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-zinc-500">
               {task.project ? (
                  <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                     <ProjectGlyph name={task.project.name} className="size-3.5 shrink-0 rounded-sm" iconClassName="size-2.5" />
                     <span className="truncate">{task.project.name}</span>
                  </span>
               ) : null}
               <span className="inline-flex items-center gap-1">
                  <PriorityIcon className={cn('size-3.5', linearPriorityMeta[task.priority]?.className || 'text-zinc-500')} />
                  {linearPriorityMeta[task.priority]?.label || task.priority}
               </span>
               <span>{linearStatusMeta[task.status]?.label || task.status}</span>
            </span>
         </span>
         <span className="inline-flex shrink-0 items-center gap-1 text-zinc-500">
            {task.dueAt ? formatJalaliDate(task.dueAt) : fa.app.noDate}
            <ArrowUpRight className="size-3.5" />
         </span>
      </Link>
   );
}

function MetricTile({
   icon: Icon,
   label,
   tone = 'default',
   value,
}: {
   icon: React.ComponentType<{ className?: string }>;
   label: string;
   tone?: 'default' | 'warning' | 'danger';
   value: number;
}) {
   return (
      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-3 shadow-sm dark:border-white/8 dark:bg-[#161618]">
         <div className="flex items-center justify-between gap-3">
            <span className={cn('inline-flex size-8 items-center justify-center rounded-md border', metricToneClassName(tone))}>
               <Icon className="size-4" />
            </span>
            <span className="text-xl font-semibold">{numberFormatter.format(value)}</span>
         </div>
         <div className="mt-2 truncate text-xs text-zinc-500">{label}</div>
      </div>
   );
}

function DiagnosticPill({ label, tone = 'default', value }: { label: string; tone?: 'default' | 'warning' | 'danger'; value: number }) {
   return (
      <span className={cn('rounded-full border px-2 py-0.5', pillToneClassName(tone))}>
         {label}: {numberFormatter.format(value)}
      </span>
   );
}

function EmptyState({ description, title }: { description: string; title: string }) {
   return (
      <div className="rounded-md border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-white/10">
         <CheckCircle2 className="mx-auto mb-2 size-5 text-emerald-500" />
         <div className="text-sm font-medium">{title}</div>
         <div className="mx-auto mt-1 max-w-md text-xs leading-5 text-zinc-500">{description}</div>
      </div>
   );
}

function PeopleWorkloadSkeleton() {
   return (
      <div className="space-y-4">
         <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
               <div key={index} className="h-24 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
            ))}
         </div>
         <div className="rounded-lg border border-zinc-200 bg-white dark:border-white/8 dark:bg-[#161618]">
            {Array.from({ length: 5 }).map((_, index) => (
               <div key={index} className="h-36 animate-pulse border-b border-zinc-200 bg-zinc-100 last:border-b-0 dark:border-white/7 dark:bg-white/5" />
            ))}
         </div>
      </div>
   );
}

const peopleFilters: PeopleFilter[] = ['risk', 'all', 'overloaded', 'blocked', 'review', 'idle'];

function peopleFilterLabel(filter: PeopleFilter): string {
   return {
      all: fa.peopleWorkload.all,
      blocked: fa.peopleWorkload.blocked,
      idle: fa.peopleWorkload.idle,
      overloaded: fa.peopleWorkload.overloaded,
      review: fa.peopleWorkload.review,
      risk: fa.peopleWorkload.risk,
   }[filter];
}

function matchesPeopleFilter(
   person: WorkHealthPerson,
   filter: PeopleFilter,
   missingByUserId: Map<string, TaskaraCheckInMissingResponse['items'][number]>,
   oneOnOneByParticipantId: Map<string, TaskaraOneOnOneSeries>
): boolean {
   if (filter === 'all') return true;
   if (filter === 'overloaded') return person.status === 'overloaded';
   if (filter === 'blocked') return person.blockedCount > 0 || person.overdueCount > 0;
   if (filter === 'review') return person.reviewCount > 0;
   if (filter === 'idle') return person.status === 'idle' || person.activeCount === 0;
   return personNeedsFollowUp(person, missingByUserId, oneOnOneByParticipantId);
}

function personNeedsFollowUp(
   person: WorkHealthPerson,
   missingByUserId: Map<string, TaskaraCheckInMissingResponse['items'][number]>,
   oneOnOneByParticipantId: Map<string, TaskaraOneOnOneSeries>
) {
   const oneOnOne = oneOnOneByParticipantId.get(person.user.id);
   const oneOnOneDue = oneOnOne && (!oneOnOne.nextScheduledAt || Date.parse(oneOnOne.nextScheduledAt) <= Date.now() + 7 * 24 * 60 * 60 * 1000);
   return (
      person.status === 'overloaded' ||
      person.blockedCount > 0 ||
      person.overdueCount > 0 ||
      person.reviewCount > 0 ||
      person.staleCount > 0 ||
      missingByUserId.has(person.user.id) ||
      Boolean(oneOnOneDue)
   );
}

function comparePeopleForManager(
   left: WorkHealthPerson,
   right: WorkHealthPerson,
   highlightedPersonId: string,
   missingByUserId: Map<string, TaskaraCheckInMissingResponse['items'][number]>,
   oneOnOneByParticipantId: Map<string, TaskaraOneOnOneSeries>
) {
   if (highlightedPersonId) {
      if (left.user.id === highlightedPersonId) return -1;
      if (right.user.id === highlightedPersonId) return 1;
   }
   const leftScore = personPresentationScore(left, missingByUserId, oneOnOneByParticipantId);
   const rightScore = personPresentationScore(right, missingByUserId, oneOnOneByParticipantId);
   if (leftScore !== rightScore) return rightScore - leftScore;
   return right.activeWeight - left.activeWeight;
}

function personPresentationScore(
   person: WorkHealthPerson,
   missingByUserId: Map<string, TaskaraCheckInMissingResponse['items'][number]>,
   oneOnOneByParticipantId: Map<string, TaskaraOneOnOneSeries>
) {
   const oneOnOne = oneOnOneByParticipantId.get(person.user.id);
   const oneOnOneDue = oneOnOne && (!oneOnOne.nextScheduledAt || Date.parse(oneOnOne.nextScheduledAt) <= Date.now() + 7 * 24 * 60 * 60 * 1000);
   return (
      (person.status === 'overloaded' ? 100 : 0) +
      person.overdueCount * 14 +
      person.blockedCount * 12 +
      person.reviewCount * 6 +
      person.staleCount * 4 +
      (missingByUserId.has(person.user.id) ? 10 : 0) +
      (oneOnOneDue ? 8 : 0)
   );
}

function workloadLabel(status: WorkHealthPerson['status']): string {
   return {
      balanced: fa.teamHealth.balanced,
      busy: fa.teamHealth.busy,
      idle: fa.teamHealth.idle,
      overloaded: fa.teamHealth.overloaded,
   }[status];
}

function filterButtonClassName(active: boolean) {
   return cn(
      'h-8 rounded-md border px-3 text-xs font-medium transition-colors',
      active
         ? 'border-zinc-300 bg-white text-zinc-950 shadow-sm dark:border-white/12 dark:bg-white/12 dark:text-zinc-100'
         : 'border-zinc-200 text-zinc-500 hover:text-zinc-900 dark:border-white/8 dark:hover:text-zinc-200'
   );
}

function metricToneClassName(tone: 'default' | 'warning' | 'danger') {
   if (tone === 'danger') return 'border-rose-300/70 bg-rose-300/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-200';
   if (tone === 'warning') return 'border-amber-300/70 bg-amber-300/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-200';
   return 'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-white/8 dark:bg-white/5 dark:text-zinc-300';
}

function pillToneClassName(tone: 'default' | 'warning' | 'danger') {
   if (tone === 'danger') return 'border-rose-300/60 bg-rose-300/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-200';
   if (tone === 'warning') return 'border-amber-300/60 bg-amber-300/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-200';
   return 'border-zinc-200 text-zinc-500 dark:border-white/8';
}

function workloadClassName(status: WorkHealthPerson['status']) {
   return {
      balanced: 'border-emerald-300/60 bg-emerald-300/10 text-emerald-700 dark:border-emerald-400/20 dark:text-emerald-200',
      busy: 'border-amber-300/60 bg-amber-300/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-200',
      idle: 'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-white/8 dark:bg-white/5 dark:text-zinc-300',
      overloaded: 'border-rose-300/60 bg-rose-300/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-200',
   }[status];
}

function workloadBarClassName(status: WorkHealthPerson['status']) {
   return {
      balanced: 'bg-emerald-500',
      busy: 'bg-amber-500',
      idle: 'bg-zinc-400',
      overloaded: 'bg-rose-500',
   }[status];
}

function peopleWorkloadRefreshSourceMatches(detail: WorkspaceRefreshDetail) {
   return (
      workspaceRefreshSourceMatches(detail, 'attention') ||
      workspaceRefreshSourceMatches(detail, 'check-in') ||
      workspaceRefreshSourceMatches(detail, 'meeting') ||
      workspaceRefreshSourceMatches(detail, 'project') ||
      workspaceRefreshSourceMatches(detail, 'review') ||
      workspaceRefreshSourceMatches(detail, 'task') ||
      workspaceRefreshSourceMatches(detail, 'task-sync-mutation') ||
      workspaceRefreshSourceMatches(detail, 'team') ||
      workspaceRefreshSourceMatches(detail, 'workspace')
   );
}
