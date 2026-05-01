'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
   AlertTriangle,
   CheckCircle2,
   CircleDot,
   UserRound,
} from 'lucide-react';
import {
   LinearAvatar,
   LinearEmptyState,
   LinearPanel,
   ProjectGlyph,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDateTime } from '@/lib/jalali';
import type { TaskaraTask, TaskaraUser } from '@/lib/taskara-types';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { cn } from '@/lib/utils';

type HeartbeatIdleUser = Pick<TaskaraUser, 'id' | 'name' | 'email' | 'avatarUrl'> & {
   activeAssignedCount: number;
};
type HeartbeatTaskDateKind = 'done' | 'overdue' | 'progress';

const activeStatuses = new Set(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']);
const progressStatuses = ['IN_PROGRESS', 'IN_REVIEW'];
const relativeTimeFormatter = new Intl.RelativeTimeFormat('fa-IR', { numeric: 'auto' });

export function HeartbeatView() {
   const { orgId } = useParams();
   const { tasks, users, loading, error } = useWorkspaceTaskSync();
   const now = useNow();

   const activeTasks = useMemo(
      () =>
         tasks
            .filter((task) => activeStatuses.has(task.status))
            .sort((a, b) => taskTimestamp(b, 'updatedAt') - taskTimestamp(a, 'updatedAt')),
      [tasks]
   );
   const overdueTasks = useMemo(
      () =>
         activeTasks
            .filter((task) => isOverdue(task, now))
            .sort((a, b) => taskTimestamp(a, 'dueAt') - taskTimestamp(b, 'dueAt')),
      [activeTasks, now]
   );
   const inFlightTasks = useMemo(
      () => activeTasks.filter((task) => progressStatuses.includes(task.status)),
      [activeTasks]
   );
   const doneTasks = useMemo(
      () =>
         tasks
            .filter((task) => task.status === 'DONE' && isToday(task.completedAt || task.updatedAt, now))
            .sort((a, b) => taskTimestamp(b, 'completedAt') - taskTimestamp(a, 'completedAt')),
      [tasks, now]
   );
   const noInProgressUsers = useMemo(
      () => buildNoInProgressUsers(users, tasks),
      [tasks, users]
   );

   return (
      <div className="flex h-full flex-col bg-[#101011]" data-testid="heartbeat-screen">
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
               <div className="mx-auto max-w-[1440px]">
                  <section className="grid gap-4 xl:grid-cols-2">
                     <TaskListPanel
                        dateKind="overdue"
                        empty={fa.heartbeat.noOverdue}
                        orgId={orgId || 'taskara'}
                        now={now}
                        tasks={overdueTasks}
                        title={
                           <HeartbeatCardTitle
                              count={overdueTasks.length}
                              icon={AlertTriangle}
                              label={fa.heartbeat.overdue}
                              tone="amber"
                           />
                        }
                     />
                     <TaskListPanel
                        dateKind="progress"
                        empty={fa.heartbeat.noInProgress}
                        orgId={orgId || 'taskara'}
                        now={now}
                        tasks={inFlightTasks}
                        title={
                           <HeartbeatCardTitle
                              count={inFlightTasks.length}
                              icon={CircleDot}
                              label={fa.heartbeat.inProgressTasks}
                              tone="indigo"
                           />
                        }
                     />
                     <TaskListPanel
                        dateKind="done"
                        empty={fa.heartbeat.noDone}
                        orgId={orgId || 'taskara'}
                        now={now}
                        tasks={doneTasks}
                        title={
                           <HeartbeatCardTitle
                              count={doneTasks.length}
                              icon={CheckCircle2}
                              label={fa.heartbeat.doneTasks}
                              tone="emerald"
                           />
                        }
                     />
                     <NoInProgressUsersPanel users={noInProgressUsers} />
                  </section>
               </div>
            )}
         </div>
      </div>
   );
}

function HeartbeatCardTitle({
   count,
   icon: Icon,
   label,
   tone,
}: {
   count: number;
   icon: typeof CheckCircle2;
   label: string;
   tone: 'amber' | 'emerald' | 'indigo' | 'zinc';
}) {
   return (
      <div className="flex items-center justify-between gap-3">
         <span className="flex min-w-0 items-center gap-2">
            <span className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-md border', heartbeatCardToneClasses[tone])}>
               <Icon className="size-3.5" />
            </span>
            <span className="truncate">{label}</span>
         </span>
         <span className="shrink-0 rounded-full border border-white/8 bg-white/[0.035] px-2 py-0.5 text-[11px] text-zinc-400">
            {count.toLocaleString('fa-IR')}
         </span>
      </div>
   );
}

const heartbeatCardToneClasses = {
   amber: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
   emerald: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
   indigo: 'border-indigo-400/20 bg-indigo-400/10 text-indigo-200',
   zinc: 'border-zinc-400/15 bg-zinc-400/8 text-zinc-300',
};

function TaskListPanel({
   className,
   dateKind,
   empty,
   now,
   orgId,
   tasks,
   title,
}: {
   className?: string;
   dateKind: HeartbeatTaskDateKind;
   empty: string;
   now: number;
   orgId: string;
   tasks: TaskaraTask[];
   title: ReactNode;
}) {
   return (
      <LinearPanel title={title} className={cn('min-h-[360px] overflow-hidden', className)}>
         <div className="max-h-[560px] divide-y divide-white/6 overflow-y-auto">
            {tasks.length === 0 ? (
               <div className="p-4">
                  <LinearEmptyState>{empty}</LinearEmptyState>
               </div>
            ) : (
               tasks.map((task) => (
                  <TaskPulseRow
                     dateKind={dateKind}
                     key={task.id}
                     now={now}
                     orgId={orgId}
                     task={task}
                  />
               ))
            )}
         </div>
      </LinearPanel>
   );
}

function NoInProgressUsersPanel({ users }: { users: HeartbeatIdleUser[] }) {
   return (
      <LinearPanel
         title={
            <HeartbeatCardTitle
               count={users.length}
               icon={UserRound}
               label={fa.heartbeat.withoutInProgress}
               tone="zinc"
            />
         }
         className="min-h-[360px] overflow-hidden"
      >
         <div className="max-h-[560px] divide-y divide-white/6 overflow-y-auto">
            {users.length === 0 ? (
               <div className="p-4">
                  <LinearEmptyState>{fa.heartbeat.noIdlePeople}</LinearEmptyState>
               </div>
            ) : (
               users.map((user) => (
                  <div key={user.id} className="flex items-center justify-between gap-3 px-4 py-3">
                     <div className="flex min-w-0 items-center gap-3">
                        <LinearAvatar name={user.name} src={user.avatarUrl} className="size-7" />
                        <div className="min-w-0">
                           <div className="truncate text-sm font-medium text-zinc-200">{user.name}</div>
                           <div className="ltr mt-1 truncate text-xs text-zinc-500">{user.email}</div>
                        </div>
                     </div>
                     <div className="shrink-0 text-xs text-zinc-500">
                        {user.activeAssignedCount > 0
                           ? `${user.activeAssignedCount.toLocaleString('fa-IR')} ${fa.heartbeat.activeAssignedTasks}`
                           : fa.heartbeat.noActiveAssignedTasks}
                     </div>
                  </div>
               ))
            )}
         </div>
      </LinearPanel>
   );
}

function TaskPulseRow({
   dateKind,
   now,
   orgId,
   task,
}: {
   dateKind: HeartbeatTaskDateKind;
   now: number;
   orgId: string;
   task: TaskaraTask;
}) {
   const rowClassName =
      'block px-4 py-3 transition hover:bg-white/[0.018]';
   const content = <TaskPulseRowContent dateKind={dateKind} now={now} task={task} />;

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
   dateKind,
   now,
   task,
}: {
   dateKind: HeartbeatTaskDateKind;
   now: number;
   task: TaskaraTask;
}) {
   const relatedDate = taskRelatedDate(task, dateKind);
   const relatedDateLabel = relatedDate ? formatRelativeTime(relatedDate, now) : fa.app.noDate;

   return (
      <div className="flex min-w-0 items-center gap-3 [direction:rtl]">
         <span className="flex size-6 shrink-0 items-center justify-center">
            {task.assignee ? <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-6" /> : null}
         </span>
         <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
            {task.title}
         </span>
         <span className="hidden min-w-[96px] max-w-[132px] items-center gap-1.5 text-xs text-zinc-500 sm:flex">
            <ProjectGlyph name={task.project?.name} className="size-4 shrink-0 rounded-sm" iconClassName="size-3" />
            <span className="truncate">{task.project?.name || fa.app.unset}</span>
         </span>
         <span
            className={cn('shrink-0 text-xs font-medium', heartbeatTaskDateToneClasses[dateKind])}
            title={relatedDate ? formatJalaliDateTime(relatedDate) : undefined}
         >
            {relatedDateLabel}
         </span>
      </div>
   );
}

const heartbeatTaskDateToneClasses: Record<HeartbeatTaskDateKind, string> = {
   done: 'text-emerald-200/70',
   overdue: 'text-amber-200/80',
   progress: 'text-indigo-200/70',
};

function buildNoInProgressUsers(users: TaskaraUser[], tasks: TaskaraTask[]): HeartbeatIdleUser[] {
   const people = users.length > 0 ? users : uniqueTaskAssignees(tasks);
   const inProgressAssigneeIds = new Set(
      tasks
         .filter((task) => task.assignee && progressStatuses.includes(task.status))
         .map((task) => task.assignee?.id)
         .filter((id): id is string => Boolean(id))
   );
   const activeAssignments = new Map<string, number>();

   for (const task of tasks) {
      if (!task.assignee || !activeStatuses.has(task.status)) continue;
      activeAssignments.set(task.assignee.id, (activeAssignments.get(task.assignee.id) || 0) + 1);
   }

   return people
      .filter((user) => !inProgressAssigneeIds.has(user.id))
      .map((user) => {
         return {
            id: user.id,
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl,
            activeAssignedCount: activeAssignments.get(user.id) || 0,
         };
      })
      .sort((a, b) => {
         if (b.activeAssignedCount !== a.activeAssignedCount) return b.activeAssignedCount - a.activeAssignedCount;
         return a.name.localeCompare(b.name, 'fa');
      });
}

function uniqueTaskAssignees(tasks: TaskaraTask[]): Array<Pick<TaskaraUser, 'id' | 'name' | 'email' | 'avatarUrl'>> {
   const assignees = new Map<string, Pick<TaskaraUser, 'id' | 'name' | 'email' | 'avatarUrl'>>();

   for (const task of tasks) {
      if (!task.assignee || assignees.has(task.assignee.id)) continue;
      assignees.set(task.assignee.id, {
         id: task.assignee.id,
         name: task.assignee.name,
         email: task.assignee.email,
         avatarUrl: task.assignee.avatarUrl,
      });
   }

   return Array.from(assignees.values());
}

function useNow(intervalMs = 60_000) {
   const [now, setNow] = useState(() => Date.now());

   useEffect(() => {
      const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
      return () => window.clearInterval(timer);
   }, [intervalMs]);

   return now;
}

function taskRelatedDate(task: TaskaraTask, dateKind: HeartbeatTaskDateKind): string | null {
   if (dateKind === 'overdue') return task.dueAt || null;
   if (dateKind === 'done') return task.completedAt || task.updatedAt || null;
   return task.progressStartedAt || task.updatedAt || task.createdAt || null;
}

function formatRelativeTime(value: string, now: number): string {
   const time = new Date(value).getTime();
   if (!Number.isFinite(time)) return fa.app.noDate;

   const diffSeconds = Math.round((time - now) / 1000);
   const absoluteSeconds = Math.abs(diffSeconds);

   if (absoluteSeconds < 45) return relativeTimeFormatter.format(0, 'second');
   if (absoluteSeconds < 45 * 60) return relativeTimeFormatter.format(Math.round(diffSeconds / 60), 'minute');
   if (absoluteSeconds < 22 * 60 * 60) return relativeTimeFormatter.format(Math.round(diffSeconds / (60 * 60)), 'hour');
   if (absoluteSeconds < 26 * 24 * 60 * 60) return relativeTimeFormatter.format(Math.round(diffSeconds / (24 * 60 * 60)), 'day');
   if (absoluteSeconds < 11 * 7 * 24 * 60 * 60) return relativeTimeFormatter.format(Math.round(diffSeconds / (7 * 24 * 60 * 60)), 'week');
   if (absoluteSeconds < 320 * 24 * 60 * 60) return relativeTimeFormatter.format(Math.round(diffSeconds / (30 * 24 * 60 * 60)), 'month');
   return relativeTimeFormatter.format(Math.round(diffSeconds / (365 * 24 * 60 * 60)), 'year');
}

function taskTimestamp(task: TaskaraTask, key: 'createdAt' | 'updatedAt' | 'completedAt' | 'dueAt') {
   const value = key === 'completedAt' ? task.completedAt || task.updatedAt : task[key];
   return value ? new Date(value).getTime() || 0 : 0;
}

function isToday(value: string | null | undefined, now: number) {
   if (!value) return false;
   const time = new Date(value).getTime();
   if (!Number.isFinite(time)) return false;

   const startOfToday = new Date(now);
   startOfToday.setHours(0, 0, 0, 0);
   const startOfTomorrow = new Date(startOfToday);
   startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

   return time >= startOfToday.getTime() && time < startOfTomorrow.getTime();
}

function isOverdue(task: TaskaraTask, now: number) {
   if (!task.dueAt || !activeStatuses.has(task.status)) return false;
   const dueAt = new Date(task.dueAt).getTime();
   return Number.isFinite(dueAt) && dueAt < now;
}
