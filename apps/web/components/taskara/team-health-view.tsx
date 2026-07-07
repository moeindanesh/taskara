'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
   AlertTriangle,
   Blocks,
   CheckCircle2,
   CircleDot,
   ClipboardList,
   Gauge,
   GitPullRequest,
   RefreshCw,
   Route,
   Timer,
   Users,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { LinearAvatar, linearStatusMeta } from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate, formatJalaliDateTime } from '@/lib/jalali';
import { useLiveRefresh, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraTask, WorkHealthPerson, WorkHealthProject, WorkHealthSummary } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

const statusOrder = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] as const;
const riskQueueOrder = ['overdue', 'blocked', 'review', 'stale', 'unassigned', 'backlog'] as const;

type RiskQueueKey = typeof riskQueueOrder[number];

export function TeamHealthView() {
   const { orgId = 'taskara' } = useParams();
   const [summary, setSummary] = useState<WorkHealthSummary | null>(null);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const requestRef = useRef(0);

   const load = useCallback(async () => {
      const requestId = ++requestRef.current;
      setError('');
      setLoading(true);

      try {
         const result = await taskaraRequest<WorkHealthSummary>('/work-health/summary');
         if (requestId !== requestRef.current) return;
         setSummary(result);
      } catch (loadError) {
         if (requestId === requestRef.current) {
            setError(loadError instanceof Error ? loadError.message : fa.teamHealth.loadFailed);
         }
      } finally {
         if (requestId === requestRef.current) setLoading(false);
      }
   }, []);

   useEffect(() => {
      void load();
   }, [load]);

   useLiveRefresh(load, {
      fireOnMount: false,
      workspaceEventFilter: teamHealthRefreshSourceMatches,
   });

   const healthState = useMemo(() => summary ? deriveHealthState(summary) : null, [summary]);

   return (
      <div className="flex min-h-full flex-col bg-background text-zinc-900 dark:bg-[#101011] dark:text-zinc-100" data-testid="team-health-screen">
         <div className="sticky top-0 z-10 border-b border-zinc-200 bg-background/95 px-4 py-3 backdrop-blur dark:border-white/8 dark:bg-[#101011]/95 sm:px-6">
            <div className="flex flex-wrap items-center gap-3">
               <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                     {summary?.generatedAt ? (
                        <span>{fa.teamHealth.generatedAt}: {formatJalaliDateTime(summary.generatedAt)}</span>
                     ) : (
                        <span>{fa.teamHealth.diagnosticSurface}</span>
                     )}
                     {summary?.overview.truncated ? (
                        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-amber-700 dark:text-amber-200">
                           {fa.teamHealth.truncated}
                        </span>
                     ) : null}
                  </div>
               </div>
               <Button size="xs" variant="outline" className="h-8 gap-1.5" onClick={() => void load()} disabled={loading}>
                  <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                  {fa.teamHealth.refresh}
               </Button>
            </div>
         </div>

         <main className="space-y-4 p-4 sm:p-6">
            {error ? (
               <div className="rounded-md border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
                  {error}
               </div>
            ) : null}

            {loading && !summary ? (
               <TeamHealthSkeleton />
            ) : summary && healthState ? (
               <>
                  <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
                     <MetricTile icon={CircleDot} label={fa.teamHealth.activeWork} value={summary.overview.activeTasks} />
                     <MetricTile icon={AlertTriangle} label={fa.teamHealth.overdue} value={summary.overview.overdueTasks} tone={summary.overview.overdueTasks ? 'danger' : 'default'} />
                     <MetricTile icon={Blocks} label={fa.teamHealth.blocked} value={summary.overview.blockedTasks} tone={summary.overview.blockedTasks ? 'danger' : 'default'} />
                     <MetricTile icon={GitPullRequest} label={fa.teamHealth.review} value={summary.overview.reviewTasks} tone={summary.overview.reviewTasks ? 'warning' : 'default'} />
                     <MetricTile icon={Timer} label={fa.teamHealth.stale} value={summary.overview.staleTasks} tone={summary.overview.staleTasks ? 'warning' : 'default'} />
                     <MetricTile icon={Users} label={fa.teamHealth.overloaded} value={summary.overview.overloadedPeople} tone={summary.overview.overloadedPeople ? 'danger' : 'default'} />
                     <MetricTile icon={ClipboardList} label={fa.teamHealth.unassigned} value={summary.overview.unassignedActiveTasks} tone={summary.overview.unassignedActiveTasks ? 'warning' : 'default'} />
                     <MetricTile icon={Route} label={fa.teamHealth.projectRisk} value={healthState.riskyProjects} tone={healthState.riskyProjects ? 'danger' : 'default'} />
                  </section>

                  <section className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
                     <div className="space-y-4">
                        <FlowPanel summary={summary} />
                        <PeoplePanel orgId={orgId} people={summary.people} />
                     </div>
                     <div className="space-y-4">
                        <BottleneckPanel summary={summary} orgId={orgId} />
                        <ProjectRiskPanel projects={summary.projects} />
                     </div>
                  </section>
               </>
            ) : (
               <EmptyPanel title={fa.teamHealth.emptyTitle} description={fa.teamHealth.emptyDescription} />
            )}
         </main>
      </div>
   );
}

function FlowPanel({ summary }: { summary: WorkHealthSummary }) {
   const counts = summary.overview.statusCounts;
   const total = Math.max(statusOrder.reduce((sum, status) => sum + counts[status], 0), 1);

   return (
      <Panel
         icon={Gauge}
         title={fa.teamHealth.flowTitle}
         description={fa.teamHealth.flowDescription}
      >
         <div className="space-y-3">
            {statusOrder.map((status) => {
               const meta = linearStatusMeta[status];
               const value = counts[status];
               const percent = Math.round((value / total) * 100);
               const Icon = meta?.icon || CircleDot;

               return (
                  <div key={status} className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_70px] sm:items-center">
                     <div className="flex min-w-0 items-center gap-2 text-sm">
                        <Icon className={cn('size-4 shrink-0', meta?.iconClassName)} />
                        <span className="truncate">{meta?.label || status}</span>
                     </div>
                     <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/8" aria-hidden="true">
                        <div
                           className={cn('h-full rounded-full', statusBarClassName(status))}
                           style={{ width: `${Math.max(percent, value ? 4 : 0)}%` }}
                        />
                     </div>
                     <div className="flex items-center justify-between gap-2 text-xs text-zinc-500 sm:justify-end">
                        <span>{formatNumber(value)}</span>
                        <span>{formatNumber(percent)}%</span>
                     </div>
                  </div>
               );
            })}
         </div>
      </Panel>
   );
}

function BottleneckPanel({ summary, orgId }: { summary: WorkHealthSummary; orgId: string }) {
   const queues = riskQueueOrder
      .map((key) => ({
         key,
         label: riskQueueLabel(key),
         tasks: summary.queues[key],
         total: queueTotal(summary, key),
      }))
      .filter((queue) => queue.total > 0);

   return (
      <Panel icon={AlertTriangle} title={fa.teamHealth.bottlenecksTitle} description={fa.teamHealth.bottlenecksDescription}>
         {queues.length ? (
            <div className="divide-y divide-zinc-200 dark:divide-white/7">
               {queues.map((queue) => (
                  <div key={queue.key} className="py-3 first:pt-0 last:pb-0">
                     <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="min-w-0 text-sm font-medium">{queue.label}</div>
                        <span className="shrink-0 rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 dark:border-white/10">
                           {formatNumber(queue.total)}
                        </span>
                     </div>
                     <div className="space-y-1.5">
                        {queue.tasks.slice(0, 4).map((task) => (
                           <TaskRiskRow key={`${queue.key}-${task.id}`} task={task} orgId={orgId} />
                        ))}
                     </div>
                  </div>
               ))}
            </div>
         ) : (
            <EmptyPanel title={fa.teamHealth.noBottlenecks} description={fa.teamHealth.noBottlenecksDescription} compact />
         )}
      </Panel>
   );
}

function PeoplePanel({ orgId, people }: { orgId: string; people: WorkHealthPerson[] }) {
   const visiblePeople = people.filter((person) =>
      person.status !== 'idle' ||
      person.activeCount > 0 ||
      person.blockedCount > 0 ||
      person.reviewCount > 0 ||
      person.overdueCount > 0
   );

   return (
      <Panel icon={Users} title={fa.teamHealth.peopleTitle} description={fa.teamHealth.peopleDescription}>
         {visiblePeople.length ? (
            <div className="divide-y divide-zinc-200 dark:divide-white/7">
               {visiblePeople.slice(0, 18).map((person) => (
                  <PersonHealthRow key={person.user.id} orgId={orgId} person={person} />
               ))}
            </div>
         ) : (
            <EmptyPanel title={fa.teamHealth.noPeopleRisk} description={fa.teamHealth.noPeopleRiskDescription} compact />
         )}
      </Panel>
   );
}

function ProjectRiskPanel({ projects }: { projects: WorkHealthProject[] }) {
   const visibleProjects = projects.filter((item) => item.health !== 'healthy' || item.activeCount > 0);

   return (
      <Panel icon={Route} title={fa.teamHealth.projectsTitle} description={fa.teamHealth.projectsDescription}>
         {visibleProjects.length ? (
            <div className="divide-y divide-zinc-200 dark:divide-white/7">
               {visibleProjects.slice(0, 12).map((item) => (
                  <ProjectHealthRow key={item.project.id} item={item} />
               ))}
            </div>
         ) : (
            <EmptyPanel title={fa.teamHealth.noProjectRisk} description={fa.teamHealth.noProjectRiskDescription} compact />
         )}
      </Panel>
   );
}

function PersonHealthRow({ orgId, person }: { orgId: string; person: WorkHealthPerson }) {
   const ratio = person.capacity > 0 ? Math.min(100, Math.round(person.loadRatio * 100)) : person.activeWeight > 0 ? 100 : 0;

   return (
      <Link className="grid gap-3 py-3 first:pt-0 last:pb-0 hover:bg-zinc-50 dark:hover:bg-white/[0.025] md:grid-cols-[minmax(180px,1fr)_minmax(180px,0.9fr)_minmax(180px,1fr)] md:items-center" to={`/${orgId}/people?person=${encodeURIComponent(person.user.id)}`}>
         <div className="flex min-w-0 items-center gap-3 px-1">
            <LinearAvatar name={person.user.name} src={person.user.avatarUrl} className="size-8 shrink-0" />
            <div className="min-w-0">
               <div className="truncate text-sm font-medium">{person.user.name}</div>
               <div className="ltr truncate text-xs text-zinc-500">{person.user.email}</div>
            </div>
         </div>
         <div className="min-w-0 px-1">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
               <span className={cn('rounded-full border px-2 py-0.5', workloadClassName(person.status))}>
                  {workloadLabel(person.status)}
               </span>
               <span className="text-zinc-500">
                  {fa.teamHealth.weightOfCapacity(person.activeWeight, person.capacity)}
               </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/8" aria-hidden="true">
               <div className={cn('h-full rounded-full', workloadBarClassName(person.status))} style={{ width: `${ratio}%` }} />
            </div>
         </div>
         <div className="flex min-w-0 flex-wrap gap-1.5 px-1 text-xs text-zinc-500">
            <DiagnosticPill label={fa.teamHealth.active} value={person.activeCount} />
            <DiagnosticPill label={fa.teamHealth.review} value={person.reviewCount} />
            <DiagnosticPill label={fa.teamHealth.blocked} value={person.blockedCount} tone={person.blockedCount ? 'danger' : 'default'} />
            <DiagnosticPill label={fa.teamHealth.overdue} value={person.overdueCount} tone={person.overdueCount ? 'danger' : 'default'} />
            <DiagnosticPill label={fa.teamHealth.stale} value={person.staleCount} tone={person.staleCount ? 'warning' : 'default'} />
         </div>
      </Link>
   );
}

function ProjectHealthRow({ item }: { item: WorkHealthProject }) {
   const latestUpdate = item.project.healthUpdates?.[0] || null;

   return (
      <div className="space-y-2 py-3 first:pt-0 last:pb-0">
         <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
               <div className="truncate text-sm font-medium">{item.project.name}</div>
               <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>{item.project.team?.name || fa.app.unset}</span>
                  <span>{item.project.lead?.name ? fa.teamHealth.lead(item.project.lead.name) : fa.teamHealth.noLead}</span>
               </div>
            </div>
            <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs', projectHealthClassName(item.health))}>
               {projectHealthLabel(item.health)}
            </span>
         </div>
         {latestUpdate?.summary ? (
            <p className="line-clamp-2 text-xs leading-5 text-zinc-500">{latestUpdate.summary}</p>
         ) : null}
         <div className="flex flex-wrap gap-1.5 text-xs text-zinc-500">
            <DiagnosticPill label={fa.teamHealth.active} value={item.activeCount} />
            <DiagnosticPill label={fa.teamHealth.blocked} value={item.blockedCount} tone={item.blockedCount ? 'danger' : 'default'} />
            <DiagnosticPill label={fa.teamHealth.overdue} value={item.overdueCount} tone={item.overdueCount ? 'danger' : 'default'} />
            <DiagnosticPill label={fa.teamHealth.review} value={item.reviewCount} />
            <DiagnosticPill label={fa.teamHealth.unassigned} value={item.unassignedCount} tone={item.unassignedCount ? 'warning' : 'default'} />
            {latestUpdate?.nextUpdateDueAt ? (
               <span className="rounded-full border border-zinc-300 px-2 py-0.5 dark:border-white/10">
                  {fa.teamHealth.nextUpdate}: {formatJalaliDate(latestUpdate.nextUpdateDueAt)}
               </span>
            ) : null}
         </div>
      </div>
   );
}

function TaskRiskRow({ task, orgId }: { task: TaskaraTask; orgId: string }) {
   const meta = linearStatusMeta[task.status];
   const Icon = meta?.icon || CircleDot;

   return (
      <Link
         to={`/${orgId}/issue/${task.key}`}
         className="grid min-w-0 gap-2 rounded-md px-2 py-1.5 text-xs transition hover:bg-zinc-100 dark:hover:bg-white/6 sm:grid-cols-[92px_minmax(0,1fr)_auto] sm:items-center"
      >
         <span className="flex min-w-0 items-center gap-1.5 text-zinc-500">
            <Icon className={cn('size-3.5 shrink-0', meta?.iconClassName)} />
            <span className="truncate">{task.key}</span>
         </span>
         <span className="min-w-0 truncate text-zinc-800 dark:text-zinc-200">{task.title}</span>
         <span className="shrink-0 text-zinc-500">{task.dueAt ? formatJalaliDate(task.dueAt) : fa.app.noDate}</span>
      </Link>
   );
}

function MetricTile({
   icon: Icon,
   label,
   value,
   tone = 'default',
}: {
   icon: React.ComponentType<{ className?: string }>;
   label: string;
   value: number;
   tone?: 'default' | 'warning' | 'danger';
}) {
   return (
      <div className={cn('rounded-md border px-3 py-2', metricTileClassName(tone))}>
         <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-zinc-500 dark:text-zinc-400">{label}</span>
            <Icon className="size-3.5 shrink-0 opacity-70" />
         </div>
         <div className="text-xl font-semibold tabular-nums">{formatNumber(value)}</div>
      </div>
   );
}

function Panel({
   icon: Icon,
   title,
   description,
   children,
}: {
   icon: React.ComponentType<{ className?: string }>;
   title: string;
   description: string;
   children: React.ReactNode;
}) {
   return (
      <section className="rounded-md border border-zinc-200 bg-white dark:border-white/8 dark:bg-[#171719]">
         <div className="border-b border-zinc-200 px-4 py-3 dark:border-white/7">
            <div className="flex items-start gap-2">
               <Icon className="mt-0.5 size-4 shrink-0 text-zinc-500" />
               <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">{title}</h2>
                  <p className="mt-0.5 text-xs leading-5 text-zinc-500">{description}</p>
               </div>
            </div>
         </div>
         <div className="p-4">{children}</div>
      </section>
   );
}

function EmptyPanel({ title, description, compact = false }: { title: string; description: string; compact?: boolean }) {
   return (
      <div className={cn('rounded-md border border-dashed border-zinc-300 text-center dark:border-white/10', compact ? 'px-3 py-4' : 'px-4 py-12')}>
         <CheckCircle2 className="mx-auto mb-2 size-5 text-emerald-500" />
         <div className="text-sm font-medium">{title}</div>
         <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-zinc-500">{description}</p>
      </div>
   );
}

function DiagnosticPill({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'warning' | 'danger' }) {
   return (
      <span className={cn('rounded-full border px-2 py-0.5', diagnosticPillClassName(tone))}>
         {label}: {formatNumber(value)}
      </span>
   );
}

function TeamHealthSkeleton() {
   return (
      <div className="space-y-4">
         <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            {Array.from({ length: 8 }, (_, index) => (
               <div key={index} className="h-20 animate-pulse rounded-md border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
            ))}
         </div>
         <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
            <div className="h-80 animate-pulse rounded-md border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
            <div className="h-80 animate-pulse rounded-md border border-zinc-200 bg-zinc-100 dark:border-white/8 dark:bg-white/5" />
         </div>
      </div>
   );
}

function teamHealthRefreshSourceMatches(detail: WorkspaceRefreshDetail) {
   return (
      workspaceRefreshSourceMatches(detail, 'attention') ||
      workspaceRefreshSourceMatches(detail, 'check-in') ||
      workspaceRefreshSourceMatches(detail, 'meeting') ||
      workspaceRefreshSourceMatches(detail, 'project') ||
      workspaceRefreshSourceMatches(detail, 'task') ||
      workspaceRefreshSourceMatches(detail, 'task-sync-mutation') ||
      workspaceRefreshSourceMatches(detail, 'team') ||
      workspaceRefreshSourceMatches(detail, 'workspace')
   );
}

function deriveHealthState(summary: WorkHealthSummary) {
   return {
      riskyProjects: summary.projects.filter((project) => project.health !== 'healthy').length,
   };
}

function queueTotal(summary: WorkHealthSummary, key: RiskQueueKey): number {
   if (key === 'overdue') return summary.overview.overdueTasks;
   if (key === 'blocked') return summary.overview.blockedTasks;
   if (key === 'review') return summary.overview.reviewTasks;
   if (key === 'stale') return summary.overview.staleTasks;
   if (key === 'unassigned') return summary.overview.unassignedActiveTasks;
   return summary.overview.backlogTasks;
}

function riskQueueLabel(key: RiskQueueKey): string {
   return {
      overdue: fa.teamHealth.overdueQueue,
      blocked: fa.teamHealth.blockedQueue,
      review: fa.teamHealth.reviewQueue,
      stale: fa.teamHealth.staleQueue,
      unassigned: fa.teamHealth.unassignedQueue,
      backlog: fa.teamHealth.backlogQueue,
   }[key];
}

function workloadLabel(status: WorkHealthPerson['status']): string {
   return {
      idle: fa.teamHealth.idle,
      balanced: fa.teamHealth.balanced,
      busy: fa.teamHealth.busy,
      overloaded: fa.teamHealth.overloaded,
   }[status];
}

function projectHealthLabel(health: WorkHealthProject['health']): string {
   return {
      healthy: fa.teamHealth.healthy,
      needs_attention: fa.teamHealth.needsAttention,
      at_risk: fa.teamHealth.atRisk,
   }[health];
}

function metricTileClassName(tone: 'default' | 'warning' | 'danger') {
   if (tone === 'danger') return 'border-red-400/25 bg-red-400/8 text-red-800 dark:text-red-100';
   if (tone === 'warning') return 'border-amber-400/25 bg-amber-400/8 text-amber-800 dark:text-amber-100';
   return 'border-zinc-200 bg-white dark:border-white/8 dark:bg-[#171719]';
}

function diagnosticPillClassName(tone: 'default' | 'warning' | 'danger') {
   if (tone === 'danger') return 'border-red-400/25 bg-red-400/8 text-red-700 dark:text-red-200';
   if (tone === 'warning') return 'border-amber-400/25 bg-amber-400/8 text-amber-700 dark:text-amber-200';
   return 'border-zinc-300 text-zinc-500 dark:border-white/10';
}

function workloadClassName(status: WorkHealthPerson['status']) {
   return {
      idle: 'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300',
      balanced: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200',
      busy: 'border-amber-400/25 bg-amber-400/10 text-amber-700 dark:text-amber-200',
      overloaded: 'border-red-400/25 bg-red-400/10 text-red-700 dark:text-red-200',
   }[status];
}

function workloadBarClassName(status: WorkHealthPerson['status']) {
   return {
      idle: 'bg-zinc-400',
      balanced: 'bg-emerald-500',
      busy: 'bg-amber-500',
      overloaded: 'bg-red-500',
   }[status];
}

function projectHealthClassName(health: WorkHealthProject['health']) {
   return {
      healthy: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200',
      needs_attention: 'border-amber-400/25 bg-amber-400/10 text-amber-700 dark:text-amber-200',
      at_risk: 'border-red-400/25 bg-red-400/10 text-red-700 dark:text-red-200',
   }[health];
}

function statusBarClassName(status: typeof statusOrder[number]) {
   return {
      BACKLOG: 'bg-zinc-500',
      TODO: 'bg-sky-500',
      IN_PROGRESS: 'bg-yellow-500',
      IN_REVIEW: 'bg-violet-500',
      BLOCKED: 'bg-red-500',
   }[status];
}

function formatNumber(value: number) {
   return value.toLocaleString('fa-IR');
}
