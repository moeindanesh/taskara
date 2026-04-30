'use client';

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
   Activity,
   ArrowLeft,
   CheckCircle2,
   GitPullRequestDraft,
   RefreshCw,
   TimerReset,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
   LinearAvatar,
   LinearEmptyState,
   LinearPanel,
   PriorityIcon,
   ProjectGlyph,
   StatusIcon,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDateTime } from '@/lib/jalali';
import type { TaskaraTask, TaskaraTeam } from '@/lib/taskara-types';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { cn } from '@/lib/utils';

type HeartbeatWindow = '7d' | '14d' | '30d' | 'all';
type TeamHeartbeat = {
   id: string;
   slug: string;
   name: string;
   tasks: TaskaraTask[];
   statusCounts: Record<string, number>;
   activeCount: number;
   blockedCount: number;
   completedInWindow: number;
   inProgressCount: number;
   updatedInWindow: number;
   overdueCount: number;
   staleCount: number;
   latestActivityAt: string | null;
   health: 'onTrack' | 'watch' | 'atRisk' | 'quiet';
};

const heartbeatWindows: Array<{ value: HeartbeatWindow; label: string }> = [
   { value: '7d', label: '۷ روز' },
   { value: '14d', label: '۱۴ روز' },
   { value: '30d', label: '۳۰ روز' },
   { value: 'all', label: 'همه' },
];

const activeStatuses = new Set(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']);
const progressStatuses = ['IN_PROGRESS', 'IN_REVIEW'];
const riskStatuses = new Set(['BLOCKED']);
const statusOrder = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELED'];
const staleActiveTaskMs = 7 * 24 * 60 * 60 * 1000;

const relativeFormatter = new Intl.RelativeTimeFormat('fa-IR', { numeric: 'auto' });

export function HeartbeatView() {
   const { orgId } = useParams();
   const [windowValue, setWindowValue] = useState<HeartbeatWindow>('7d');
   const [teamFilter, setTeamFilter] = useState('all');
   const { tasks, teams, loading, error, refresh } = useWorkspaceTaskSync();
   const now = Date.now();
   const windowMs = windowToMs(windowValue);

   const teamOptions = useMemo(() => buildTeamOptions(teams, tasks), [teams, tasks]);
   const visibleTeamOptions = useMemo(
      () => (teamFilter === 'all' ? teamOptions : teamOptions.filter((team) => team.id === teamFilter)),
      [teamFilter, teamOptions]
   );
   const filteredTasks = useMemo(
      () => (teamFilter === 'all' ? tasks : tasks.filter((task) => taskTeamId(task) === teamFilter)),
      [tasks, teamFilter]
   );
   const teamsHeartbeat = useMemo(
      () => buildTeamHeartbeats(visibleTeamOptions, filteredTasks, windowMs, now),
      [filteredTasks, now, visibleTeamOptions, windowMs]
   );
   const activeTasks = useMemo(
      () =>
         filteredTasks
            .filter((task) => activeStatuses.has(task.status))
            .sort((a, b) => taskTimestamp(b, 'updatedAt') - taskTimestamp(a, 'updatedAt')),
      [filteredTasks]
   );
   const inFlightTasks = useMemo(
      () => activeTasks.filter((task) => progressStatuses.includes(task.status)).slice(0, 6),
      [activeTasks]
   );
   const doneTasks = useMemo(
      () =>
         filteredTasks
            .filter((task) => task.status === 'DONE' && isWithinWindow(task.completedAt || task.updatedAt, windowMs, now))
            .sort((a, b) => taskTimestamp(b, 'completedAt') - taskTimestamp(a, 'completedAt'))
            .slice(0, 6),
      [filteredTasks, now, windowMs]
   );
   const riskTasksAll = useMemo(
      () =>
         activeTasks
            .filter((task) => riskStatuses.has(task.status) || isOverdue(task, now) || isStale(task, now))
            .sort((a, b) => riskScore(b, now) - riskScore(a, now)),
      [activeTasks, now]
   );
   const riskTasks = useMemo(() => riskTasksAll.slice(0, 6), [riskTasksAll]);

   const summary = useMemo(() => {
      const completed = filteredTasks.filter(
         (task) => task.status === 'DONE' && isWithinWindow(task.completedAt || task.updatedAt, windowMs, now)
      ).length;

      return {
         active: activeTasks.length,
         inProgress: activeTasks.filter((task) => progressStatuses.includes(task.status)).length,
         completed,
         risks: riskTasksAll.length,
      };
   }, [activeTasks, filteredTasks, now, riskTasksAll.length, windowMs]);

   return (
      <div className="flex h-full flex-col bg-[#101011]" data-testid="heartbeat-screen">
         <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-white/6 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
               {heartbeatWindows.map((item) => (
                  <HeartbeatChip key={item.value} active={windowValue === item.value} onClick={() => setWindowValue(item.value)}>
                     {item.label}
                  </HeartbeatChip>
               ))}
               <label className="relative">
                  <span className="sr-only">{fa.heartbeat.teamFilter}</span>
                  <select
                     className="h-8 rounded-full border border-white/8 bg-white/[0.035] px-3 text-xs text-zinc-300 outline-none transition hover:bg-white/[0.06] focus:border-indigo-400/45 focus:ring-2 focus:ring-indigo-400/20"
                     value={teamFilter}
                     onChange={(event) => setTeamFilter(event.target.value)}
                  >
                     <option value="all">{fa.heartbeat.allTeams}</option>
                     {teamOptions.map((team) => (
                        <option key={team.id} value={team.id}>
                           {team.name}
                        </option>
                     ))}
                  </select>
               </label>
            </div>
            <Button
               size="xs"
               variant="ghost"
               className="h-8 rounded-full border border-white/8 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100"
               onClick={() => void refresh()}
            >
               <RefreshCw className="size-3.5" />
               {fa.heartbeat.refresh}
            </Button>
         </div>

         <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
            {error ? (
               <p className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                  {error}
               </p>
            ) : null}

            {loading ? (
               <div className="p-4 text-sm text-zinc-500">{fa.app.loading}</div>
            ) : tasks.length === 0 ? (
               <LinearEmptyState>{fa.heartbeat.empty}</LinearEmptyState>
            ) : (
               <div className="mx-auto max-w-[1440px] space-y-4">
                  <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                     <MetricTile
                        icon={Activity}
                        label={fa.heartbeat.inProgress}
                        tone="indigo"
                        value={summary.inProgress}
                        caption={fa.heartbeat.startedOrReview}
                     />
                     <MetricTile
                        icon={CheckCircle2}
                        label={fa.heartbeat.doneInWindow}
                        tone="emerald"
                        value={summary.completed}
                        caption={windowLabel(windowValue)}
                     />
                     <MetricTile
                        icon={TimerReset}
                        label={fa.heartbeat.needsAttention}
                        tone="rose"
                        value={summary.risks}
                        caption={fa.heartbeat.blockedOverdueStale}
                     />
                     <MetricTile
                        icon={GitPullRequestDraft}
                        label={fa.heartbeat.activeNow}
                        tone="orange"
                        value={summary.active}
                        caption={fa.heartbeat.workInSystem}
                     />
                  </section>

                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
                     <LinearPanel title={fa.heartbeat.teamHealth}>
                        <div className="overflow-x-auto">
                           <div className="min-w-[720px]">
                              <div className="hidden grid-cols-[minmax(220px,1fr)_88px_88px_88px_88px_120px] gap-3 border-b border-white/6 px-4 py-2 text-[11px] text-zinc-600 lg:grid">
                                 <span>{fa.heartbeat.teams}</span>
                                 <span>{fa.heartbeat.active}</span>
                                 <span>{fa.heartbeat.inProgress}</span>
                                 <span>{fa.heartbeat.done}</span>
                                 <span>{fa.status.BLOCKED}</span>
                                 <span>{fa.heartbeat.latest}</span>
                              </div>
                              <div className="divide-y divide-white/6">
                                 {teamsHeartbeat.length === 0 ? (
                                    <div className="p-4">
                                       <LinearEmptyState>{fa.heartbeat.noTeamData}</LinearEmptyState>
                                    </div>
                                 ) : (
                                    teamsHeartbeat.map((team) => (
                                       <TeamHeartbeatRow key={team.id} orgId={orgId || 'taskara'} team={team} />
                                    ))
                                 )}
                              </div>
                           </div>
                        </div>
                     </LinearPanel>

                     <TaskListPanel
                        empty={fa.heartbeat.noRisks}
                        orgId={orgId || 'taskara'}
                        riskList
                        tasks={riskTasks}
                        title={fa.heartbeat.needsAttention}
                     />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                     <TaskListPanel
                        empty={fa.heartbeat.noInProgress}
                        orgId={orgId || 'taskara'}
                        tasks={inFlightTasks}
                        title={fa.heartbeat.inProgressTasks}
                     />
                     <TaskListPanel
                        empty={fa.heartbeat.noDone}
                        orgId={orgId || 'taskara'}
                        tasks={doneTasks}
                        title={fa.heartbeat.doneTasks}
                     />
                  </div>
               </div>
            )}
         </div>
      </div>
   );
}

function HeartbeatChip({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
   return (
      <button
         className={cn(
            'inline-flex h-8 items-center rounded-full border px-3 text-xs transition',
            active
               ? 'border-indigo-400/35 bg-indigo-400/14 text-indigo-100'
               : 'border-white/8 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
         )}
         type="button"
         onClick={onClick}
      >
         {children}
      </button>
   );
}

function MetricTile({
   caption,
   icon: Icon,
   label,
   tone,
   value,
}: {
   caption: string;
   icon: typeof Activity;
   label: string;
   tone: 'indigo' | 'amber' | 'emerald' | 'sky' | 'rose' | 'orange';
   value: number;
}) {
   return (
      <div className="rounded-lg border border-white/8 bg-[#19191b] px-4 py-3 shadow-sm">
         <div className="flex items-center justify-between gap-3">
            <span className="truncate text-xs text-zinc-500">{label}</span>
            <span className={cn('inline-flex size-7 items-center justify-center rounded-md border', metricToneClasses[tone])}>
               <Icon className="size-3.5" />
            </span>
         </div>
         <div className="mt-3 text-2xl font-semibold text-zinc-100">{value.toLocaleString('fa-IR')}</div>
         <div className="mt-1 truncate text-xs text-zinc-500">{caption}</div>
      </div>
   );
}

const metricToneClasses = {
   indigo: 'border-indigo-400/20 bg-indigo-400/10 text-indigo-200',
   amber: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
   emerald: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
   sky: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
   rose: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
   orange: 'border-orange-400/20 bg-orange-400/10 text-orange-200',
};

function TeamHeartbeatRow({ orgId, team }: { orgId: string; team: TeamHeartbeat }) {
   const destination = team.slug === 'unassigned' ? `/${orgId}/projects` : `/${orgId}/team/${team.slug}/all`;
   const latest = team.latestActivityAt ? relativeDate(team.latestActivityAt) : '-';

   return (
      <Link
         className="grid gap-3 px-4 py-3 transition hover:bg-white/[0.018] lg:grid-cols-[minmax(220px,1fr)_88px_88px_88px_88px_120px] lg:items-center"
         to={destination}
      >
         <div className="flex min-w-0 items-center gap-3">
            <HealthDot health={team.health} />
            <div className="min-w-0">
               <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-zinc-200">
                  <span className="truncate">{team.name}</span>
                  <ArrowLeft className="size-3.5 shrink-0 text-zinc-600" />
               </div>
               <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{healthLabel(team.health)}</span>
                  <div className="hidden h-1.5 w-40 overflow-hidden rounded-full bg-white/[0.05] sm:flex">
                     {statusOrder.map((status) => {
                        const count = team.statusCounts[status] || 0;
                        if (count === 0) return null;
                        return (
                           <div
                              key={status}
                              className={cn('min-w-[3px]', statusBarClassName(status))}
                              style={{ width: `${percentage(count, team.tasks.length)}%` }}
                           />
                        );
                     })}
                  </div>
               </div>
            </div>
         </div>

         <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5 lg:contents">
            <TeamNumber label={fa.heartbeat.active} value={team.activeCount} />
            <TeamNumber label={fa.heartbeat.inProgress} value={team.inProgressCount} />
            <TeamNumber label={fa.heartbeat.done} value={team.completedInWindow} />
            <TeamNumber danger={team.blockedCount > 0} label={fa.status.BLOCKED} value={team.blockedCount} />
            <TeamNumber
               danger={team.overdueCount > 0 || team.staleCount > 0}
               label={fa.heartbeat.latest}
               value={latest}
            />
         </div>
      </Link>
   );
}

function TeamNumber({
   danger,
   label,
   value,
}: {
   danger?: boolean;
   label: string;
   value: number | string;
}) {
   return (
      <div className="min-w-0 rounded-md bg-white/[0.025] px-2 py-1.5 lg:bg-transparent lg:px-0 lg:py-0">
         <div className="truncate text-[11px] text-zinc-600 lg:hidden">{label}</div>
         <div className={cn('mt-1 truncate text-xs text-zinc-300 lg:mt-0', danger && 'text-rose-200')}>
            {typeof value === 'number' ? value.toLocaleString('fa-IR') : value}
         </div>
      </div>
   );
}

function TaskListPanel({
   empty,
   orgId,
   riskList,
   tasks,
   title,
}: {
   empty: string;
   orgId: string;
   riskList?: boolean;
   tasks: TaskaraTask[];
   title: string;
}) {
   return (
      <LinearPanel title={title}>
         <div className="divide-y divide-white/6">
            {tasks.length === 0 ? (
               <div className="p-4">
                  <LinearEmptyState>{empty}</LinearEmptyState>
               </div>
            ) : (
               tasks.map((task) => (
                  <TaskPulseRow
                     key={task.id}
                     orgId={orgId}
                     riskList={riskList}
                     task={task}
                     timestamp={task.completedAt || task.updatedAt || task.createdAt}
                  />
               ))
            )}
         </div>
      </LinearPanel>
   );
}

function TaskPulseRow({
   orgId,
   riskList,
   task,
   timestamp,
}: {
   orgId: string;
   riskList?: boolean;
   task: TaskaraTask;
   timestamp?: string;
}) {
   const teamName = task.project?.team?.name || fa.heartbeat.unassignedTeam;
   const rowClassName =
      'grid gap-2 px-4 py-3 transition hover:bg-white/[0.018] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center';
   const content = (
      <TaskPulseRowContent riskList={riskList} task={task} teamName={teamName} timestamp={timestamp} />
   );

   if (task.syncState === 'pending') {
      return (
         <div className={rowClassName} title={fa.issue.pendingSync}>
            {content}
         </div>
      );
   }

   return (
      <Link
         className={rowClassName}
         to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}
      >
         {content}
      </Link>
   );
}

function TaskPulseRowContent({
   riskList,
   task,
   teamName,
   timestamp,
}: {
   riskList?: boolean;
   task: TaskaraTask;
   teamName: string;
   timestamp?: string;
}) {
   return (
      <>
         <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
               <PriorityIcon priority={task.priority} className="size-3.5" />
               <StatusIcon status={task.status} className="size-3.5" />
            </span>
            <div className="min-w-0">
               <div className="flex min-w-0 items-center gap-2">
                  <span className="ltr shrink-0 text-xs font-medium text-zinc-500">{task.key}</span>
                  <span className="truncate text-sm text-zinc-200">{task.title}</span>
               </div>
               <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                  <span className="flex min-w-0 items-center gap-1.5">
                     <ProjectGlyph name={task.project?.name || teamName} className="size-4 rounded-sm" iconClassName="size-3" />
                     <span className="truncate">{task.project?.name || fa.app.unset}</span>
                  </span>
                  <span>{teamName}</span>
                  {riskList ? <RiskLabel task={task} /> : null}
               </div>
            </div>
         </div>
         <div className="flex items-center gap-2 justify-self-start sm:justify-self-end">
            {task.assignee ? <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-6" /> : null}
            <span className="text-xs text-zinc-500" title={timestamp ? formatJalaliDateTime(timestamp) : undefined}>
               {timestamp ? relativeDate(timestamp) : '-'}
            </span>
         </div>
      </>
   );
}

function RiskLabel({ task }: { task: TaskaraTask }) {
   const now = Date.now();

   if (task.status === 'BLOCKED') return <span className="text-rose-300">{fa.status.BLOCKED}</span>;
   if (isOverdue(task, now)) return <span className="text-orange-300">{fa.heartbeat.overdue}</span>;
   if (isStale(task, now)) return <span className="text-amber-300">{fa.heartbeat.stale}</span>;
   return null;
}

function HealthDot({ health }: { health: TeamHeartbeat['health'] }) {
   return (
      <span
         className={cn(
            'size-2.5 shrink-0 rounded-full',
            health === 'onTrack' && 'bg-emerald-400 shadow-[0_0_0_4px_rgb(52_211_153/0.08)]',
            health === 'watch' && 'bg-amber-400 shadow-[0_0_0_4px_rgb(251_191_36/0.08)]',
            health === 'atRisk' && 'bg-rose-400 shadow-[0_0_0_4px_rgb(251_113_133/0.08)]',
            health === 'quiet' && 'bg-zinc-500 shadow-[0_0_0_4px_rgb(113_113_122/0.08)]'
         )}
      />
   );
}

function buildTeamOptions(teams: TaskaraTeam[], tasks: TaskaraTask[]) {
   const options = teams.map((team) => ({ id: team.id, slug: team.slug, name: team.name }));
   const hasUnassigned = tasks.some((task) => taskTeamId(task) === 'unassigned');
   if (hasUnassigned) options.push({ id: 'unassigned', slug: 'unassigned', name: fa.heartbeat.unassignedTeam });
   return options.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
}

function buildTeamHeartbeats(
   teamOptions: Array<{ id: string; slug: string; name: string }>,
   tasks: TaskaraTask[],
   windowMs: number | null,
   now: number
): TeamHeartbeat[] {
   return teamOptions
      .map((team) => {
         const teamTasks = tasks.filter((task) => taskTeamId(task) === team.id);
         const statusCounts = countStatuses(teamTasks);
         const activeCount = teamTasks.filter((task) => activeStatuses.has(task.status)).length;
         const blockedCount = statusCounts.BLOCKED || 0;
         const inProgressCount = teamTasks.filter((task) => progressStatuses.includes(task.status)).length;
         const completedInWindow = teamTasks.filter(
            (task) => task.status === 'DONE' && isWithinWindow(task.completedAt || task.updatedAt, windowMs, now)
         ).length;
         const updatedInWindow = teamTasks.filter((task) => isWithinWindow(task.updatedAt || task.createdAt, windowMs, now)).length;
         const overdueCount = teamTasks.filter((task) => activeStatuses.has(task.status) && isOverdue(task, now)).length;
         const staleCount = teamTasks.filter((task) => activeStatuses.has(task.status) && isStale(task, now)).length;
         const latestActivityAt = latestTimestamp(teamTasks);

         return {
            id: team.id,
            slug: team.slug,
            name: team.name,
            tasks: teamTasks,
            statusCounts,
            activeCount,
            blockedCount,
            completedInWindow,
            inProgressCount,
            updatedInWindow,
            overdueCount,
            staleCount,
            latestActivityAt,
            health: heartbeatHealth({ activeCount, blockedCount, completedInWindow, overdueCount, staleCount, updatedInWindow }),
         };
      })
      .filter((team) => team.tasks.length > 0 || team.id !== 'unassigned')
      .sort((a, b) => {
         const healthRank = healthSortValue(b.health) - healthSortValue(a.health);
         if (healthRank !== 0) return healthRank;
         return (b.latestActivityAt || '').localeCompare(a.latestActivityAt || '');
      });
}

function countStatuses(tasks: TaskaraTask[]): Record<string, number> {
   const counts: Record<string, number> = {};
   for (const status of statusOrder) counts[status] = 0;
   for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
   return counts;
}

function heartbeatHealth(input: {
   activeCount: number;
   blockedCount: number;
   completedInWindow: number;
   overdueCount: number;
   staleCount: number;
   updatedInWindow: number;
}): TeamHeartbeat['health'] {
   if (input.activeCount === 0 && input.completedInWindow === 0 && input.updatedInWindow === 0) return 'quiet';
   if (input.blockedCount > 0 || input.overdueCount > 0) return 'atRisk';
   if (input.staleCount > 0) return 'watch';
   return 'onTrack';
}

function healthLabel(health: TeamHeartbeat['health']) {
   if (health === 'atRisk') return fa.heartbeat.atRisk;
   if (health === 'watch') return fa.heartbeat.watch;
   if (health === 'onTrack') return fa.heartbeat.onTrack;
   return fa.heartbeat.quiet;
}

function healthSortValue(health: TeamHeartbeat['health']) {
   if (health === 'atRisk') return 3;
   if (health === 'watch') return 2;
   if (health === 'onTrack') return 1;
   return 0;
}

function taskTeamId(task: TaskaraTask) {
   return task.project?.team?.id || 'unassigned';
}

function taskTimestamp(task: TaskaraTask, key: 'createdAt' | 'updatedAt' | 'completedAt') {
   const value = key === 'completedAt' ? task.completedAt || task.updatedAt : task[key];
   return value ? new Date(value).getTime() || 0 : 0;
}

function latestTimestamp(tasks: TaskaraTask[]) {
   let latest: string | null = null;
   let latestMs = 0;

   for (const task of tasks) {
      const candidate = task.updatedAt || task.completedAt || task.createdAt;
      if (!candidate) continue;

      const candidateMs = new Date(candidate).getTime();
      if (candidateMs > latestMs) {
         latest = candidate;
         latestMs = candidateMs;
      }
   }

   return latest;
}

function windowToMs(value: HeartbeatWindow) {
   if (value === 'all') return null;
   const days = value === '7d' ? 7 : value === '14d' ? 14 : 30;
   return days * 24 * 60 * 60 * 1000;
}

function isWithinWindow(value: string | null | undefined, windowMs: number | null, now: number) {
   if (!value) return false;
   if (windowMs === null) return true;
   const time = new Date(value).getTime();
   return Number.isFinite(time) && now - time <= windowMs;
}

function isOverdue(task: TaskaraTask, now: number) {
   if (!task.dueAt || !activeStatuses.has(task.status)) return false;
   const dueAt = new Date(task.dueAt).getTime();
   return Number.isFinite(dueAt) && dueAt < now;
}

function isStale(task: TaskaraTask, now: number) {
   if (!activeStatuses.has(task.status)) return false;
   const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
   return updatedAt > 0 && now - updatedAt > staleActiveTaskMs;
}

function riskScore(task: TaskaraTask, now: number) {
   let score = 0;
   if (task.status === 'BLOCKED') score += 100;
   if (isOverdue(task, now)) score += 50;
   if (isStale(task, now)) score += 25;
   return score + taskTimestamp(task, 'updatedAt') / 100000000000;
}

function percentage(count: number, total: number) {
   if (total <= 0) return 0;
   return Math.max(0, Math.min(100, Math.round((count / total) * 100)));
}

function relativeDate(value: string) {
   const date = new Date(value);
   const diffMs = date.getTime() - Date.now();
   const abs = Math.abs(diffMs);
   if (abs < 60 * 1000) return relativeFormatter.format(0, 'minute');
   if (abs < 60 * 60 * 1000) return relativeFormatter.format(Math.round(diffMs / (60 * 1000)), 'minute');
   if (abs < 24 * 60 * 60 * 1000) return relativeFormatter.format(Math.round(diffMs / (60 * 60 * 1000)), 'hour');
   if (abs < 45 * 24 * 60 * 60 * 1000) return relativeFormatter.format(Math.round(diffMs / (24 * 60 * 60 * 1000)), 'day');
   if (abs < 12 * 30 * 24 * 60 * 60 * 1000) return relativeFormatter.format(Math.round(diffMs / (30 * 24 * 60 * 60 * 1000)), 'month');
   return relativeFormatter.format(Math.round(diffMs / (365 * 24 * 60 * 60 * 1000)), 'year');
}

function statusBarClassName(status: string) {
   if (status === 'BACKLOG') return 'bg-zinc-500/70';
   if (status === 'TODO') return 'bg-sky-400/75';
   if (status === 'IN_PROGRESS') return 'bg-amber-400/85';
   if (status === 'IN_REVIEW') return 'bg-violet-400/80';
   if (status === 'BLOCKED') return 'bg-rose-400/85';
   if (status === 'DONE') return 'bg-emerald-400/80';
   return 'bg-zinc-600/75';
}

function windowLabel(value: HeartbeatWindow) {
   if (value === 'all') return fa.heartbeat.allTime;
   return `${fa.heartbeat.last} ${heartbeatWindows.find((item) => item.value === value)?.label || ''}`;
}
