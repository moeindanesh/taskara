'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
   AlertTriangle,
   CalendarCheck2,
   CheckCircle2,
   CircleDot,
   UserRound,
} from 'lucide-react';
import {
   LinearAvatar,
   LinearEmptyState,
   LinearPanel,
   ProjectGlyph,
   StatusIcon,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { IssueTitleTooltip } from '@/components/taskara/issue-title-tooltip';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate, formatJalaliDateTime } from '@/lib/jalali';
import type { TaskaraTask, TaskaraUser } from '@/lib/taskara-types';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { cn } from '@/lib/utils';

type HeartbeatIdleUser = Pick<TaskaraUser, 'id' | 'name' | 'email' | 'avatarUrl'> & {
   activeAssignedCount: number;
};
type TodayPlanUser = Pick<TaskaraUser, 'id' | 'name' | 'email' | 'avatarUrl'> & {
   tasks: TaskaraTask[];
   totalWeight: number;
};
type TodayPlanSyntheticUser = Pick<TaskaraUser, 'id' | 'name' | 'avatarUrl'> & {
   email?: string | null;
   tasks: TaskaraTask[];
   totalWeight: number;
};
type HeartbeatTaskDateKind = 'done' | 'overdue' | 'progress';

const dailyWeightLimit = 8;
const activeStatuses = new Set(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']);
const progressStatuses = ['IN_PROGRESS', 'IN_REVIEW'];
const relativeTimeFormatter = new Intl.RelativeTimeFormat('fa-IR', { numeric: 'auto' });

export function HeartbeatView() {
   const { orgId } = useParams();
   const { tasks, users, loading, error } = useWorkspaceTaskSync();
   const now = useNow();
   const todayEnd = useMemo(() => endOfTodayTimestamp(now), [now]);

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
   const todayPlanTasks = useMemo(
      () =>
         tasks
            .filter((task) => isTodayPlanTask(task, todayEnd, now))
            .sort((a, b) => compareTodayPlanTasks(a, b)),
      [now, tasks, todayEnd]
   );
   const userPlans = useMemo(
      () => buildUserPlans(users, todayPlanTasks),
      [todayPlanTasks, users]
   );
   const unassignedTodayPlanTasks = useMemo(
      () => todayPlanTasks.filter((task) => !task.assignee),
      [todayPlanTasks]
   );
   const noInProgressUsers = useMemo(
      () => buildNoInProgressUsers(users, tasks),
      [tasks, users]
   );

   return (
      <div className="flex h-full flex-col bg-background dark:bg-[#101011]" data-testid="heartbeat-screen">
         <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
            {error ? (
               <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
                  {error}
               </p>
            ) : null}

            {loading ? (
               <div className="p-4 text-sm text-zinc-500">{fa.app.loading}</div>
            ) : tasks.length === 0 ? (
               <LinearEmptyState>{fa.heartbeat.empty}</LinearEmptyState>
            ) : (
               <div className="mx-auto max-w-[1440px]">
                  <TodayPlanPanel
                     orgId={orgId || 'taskara'}
                     tasks={todayPlanTasks}
                     unassignedTasks={unassignedTodayPlanTasks}
                     users={userPlans}
                  />

                  <section className="mt-4 grid gap-4 xl:grid-cols-2">
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

function TodayPlanPanel({
   orgId,
   tasks,
   unassignedTasks,
   users,
}: {
   orgId: string;
   tasks: TaskaraTask[];
   unassignedTasks: TaskaraTask[];
   users: TodayPlanUser[];
}) {
   const panelUsers: TodayPlanSyntheticUser[] = [
      ...users,
      ...(unassignedTasks.length
         ? [{
              id: 'unassigned',
              name: fa.todayPlan.unassignedTasks,
              email: null,
              avatarUrl: null,
              tasks: unassignedTasks,
              totalWeight: unassignedTasks.reduce((sum, task) => sum + taskWeight(task), 0),
           }]
         : []),
   ];

   return (
      <LinearPanel
         title={
            <HeartbeatCardTitle
               count={tasks.length}
               icon={CalendarCheck2}
               label={fa.todayPlan.peopleWorkload}
               tone="indigo"
            />
         }
         className="overflow-hidden"
      >
         <div className="border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500 dark:border-white/6">
            {fa.todayPlan.capacityLabel(dailyWeightLimit)}
         </div>
         <div className="max-h-[420px] divide-y divide-zinc-100 overflow-y-auto dark:divide-white/6">
            {panelUsers.length === 0 ? (
               <div className="p-4">
                  <LinearEmptyState>{fa.todayPlan.noUsers}</LinearEmptyState>
               </div>
            ) : (
               panelUsers.map((user) => (
                  <TodayPlanUserRow
                     key={user.id}
                     orgId={orgId}
                     user={user}
                  />
               ))
            )}
         </div>
      </LinearPanel>
   );
}

function TodayPlanUserRow({ orgId, user }: { orgId: string; user: TodayPlanSyntheticUser }) {
   const overload = Math.max(user.totalWeight - dailyWeightLimit, 0);
   const progress = Math.min((user.totalWeight / dailyWeightLimit) * 100, 100);

   return (
      <div className="grid gap-3 px-3 py-2.5 lg:grid-cols-[minmax(210px,260px)_minmax(0,1fr)]">
         <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
               <LinearAvatar name={user.name} src={user.avatarUrl} className="size-7" />
               <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-200">{user.name}</div>
                  {user.email ? <div className="ltr truncate text-[11px] text-zinc-500">{user.email}</div> : null}
               </div>
            </div>
            <div className="mt-2.5">
               <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]">
                  <span className={cn('font-medium', overload > 0 ? 'text-rose-600 dark:text-rose-200' : user.totalWeight >= dailyWeightLimit ? 'text-emerald-700 dark:text-emerald-200' : 'text-zinc-500')}>
                     {fa.todayPlan.weightOfLimit(user.totalWeight, dailyWeightLimit)}
                  </span>
                  <span className="text-zinc-500">
                     {overload > 0
                        ? fa.todayPlan.overloadBy(overload)
                        : user.tasks.length > 0
                          ? fa.todayPlan.taskCount(user.tasks.length)
                          : fa.todayPlan.noTasks}
                  </span>
               </div>
               <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/7">
                  <div
                     className={cn(
                        'h-full rounded-full transition-[width]',
                        overload > 0
                           ? 'bg-rose-400'
                           : user.totalWeight >= dailyWeightLimit
                             ? 'bg-emerald-400'
                             : 'bg-indigo-400'
                     )}
                     style={{ width: `${progress}%` }}
                  />
               </div>
            </div>
         </div>

         <div className="min-w-0">
            {user.tasks.length === 0 ? (
               <LinearEmptyState className="py-2">{fa.todayPlan.noDueTasks}</LinearEmptyState>
            ) : (
               <div className="grid gap-1.5 md:grid-cols-2 2xl:grid-cols-3">
                  {user.tasks.map((task) => (
                     <TodayPlanTaskItem key={task.id} orgId={orgId} task={task} />
                  ))}
               </div>
            )}
         </div>
      </div>
   );
}

function TodayPlanTaskItem({ orgId, task }: { orgId: string; task: TaskaraTask }) {
   const content = <TodayPlanTaskContent task={task} />;
   const className =
      'block min-w-0 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 transition hover:border-zinc-300 hover:bg-zinc-100 dark:border-white/7 dark:bg-white/[0.018] dark:hover:border-white/12 dark:hover:bg-white/[0.035]';

   if (task.syncState === 'pending') {
      return (
         <div className={className} title={fa.issue.pendingSync}>
            {content}
         </div>
      );
   }

   return (
      <Link className={className} to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}>
         {content}
      </Link>
   );
}

function TodayPlanTaskContent({ task }: { task: TaskaraTask }) {
   const statusLabel = linearStatusMeta[task.status]?.label || task.status;
   const dateLabel = task.status === 'DONE'
      ? formatJalaliDate(task.completedAt || task.updatedAt)
      : formatJalaliDate(task.dueAt);

   return (
      <div className="min-w-0">
         <div className="flex min-w-0 items-center gap-1.5">
            <StatusIcon status={task.status} className="size-3.5 shrink-0" />
            <IssueTitleTooltip title={task.title}>
               <span className="min-w-0 flex-1 truncate text-right text-xs text-zinc-900 [unicode-bidi:plaintext] dark:text-zinc-200" dir="rtl">
                  {task.title}
               </span>
            </IssueTitleTooltip>
            <span className="shrink-0 rounded-full border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] text-zinc-500 dark:border-white/8 dark:bg-white/[0.035] dark:text-zinc-400">
               {formatTaskWeight(task.weight)}
            </span>
         </div>
         <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
            <span className="flex min-w-0 items-center gap-1">
               <ProjectGlyph name={task.project?.name} className="size-3.5 shrink-0 rounded-sm" iconClassName="size-2.5" />
               <span className="min-w-0 truncate">{task.project?.name || fa.app.unset}</span>
            </span>
            <span>{statusLabel}</span>
            <span>{dateLabel}</span>
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
         <span className="shrink-0 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-500 dark:border-white/8 dark:bg-white/[0.035] dark:text-zinc-400">
            {count.toLocaleString('fa-IR')}
         </span>
      </div>
   );
}

const heartbeatCardToneClasses = {
   amber: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200',
   emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200',
   indigo: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-400/20 dark:bg-indigo-400/10 dark:text-indigo-200',
   zinc: 'border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-400/15 dark:bg-zinc-400/8 dark:text-zinc-300',
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
         <div className="max-h-[560px] divide-y divide-zinc-100 overflow-y-auto dark:divide-white/6">
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
         <div className="max-h-[560px] divide-y divide-zinc-100 overflow-y-auto dark:divide-white/6">
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
                           <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-200">{user.name}</div>
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
      'block px-4 py-3 transition hover:bg-zinc-50 dark:hover:bg-white/[0.018]';
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
      <div className="grid min-w-0 grid-cols-[82px_minmax(0,1fr)_32px] items-center gap-3 [direction:ltr] sm:grid-cols-[96px_132px_minmax(0,1fr)_32px]">
         <span
            className={cn(
               'min-w-0 truncate text-right text-xs font-medium [direction:rtl] [unicode-bidi:plaintext]',
               heartbeatTaskDateToneClasses[dateKind]
            )}
            dir="rtl"
            title={relatedDate ? formatJalaliDateTime(relatedDate) : undefined}
         >
            {relatedDateLabel}
         </span>
         <span className="hidden min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-500 sm:flex">
            <ProjectGlyph name={task.project?.name} className="size-4 shrink-0 rounded-sm" iconClassName="size-3" />
            <span className="min-w-0 truncate text-right">{task.project?.name || fa.app.unset}</span>
         </span>
         <IssueTitleTooltip title={task.title}>
            <span className="min-w-0 truncate text-right text-sm text-zinc-900 [direction:rtl] [unicode-bidi:plaintext] dark:text-zinc-200" dir="rtl">
               {task.title}
            </span>
         </IssueTitleTooltip>
         <span className="flex size-6 items-center justify-center justify-self-center">
            {task.assignee ? <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-6" /> : null}
         </span>
      </div>
   );
}

const heartbeatTaskDateToneClasses: Record<HeartbeatTaskDateKind, string> = {
   done: 'text-emerald-700 dark:text-emerald-200/70',
   overdue: 'text-amber-700 dark:text-amber-200/80',
   progress: 'text-indigo-700 dark:text-indigo-200/70',
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

function buildUserPlans(users: TaskaraUser[], tasks: TaskaraTask[]): TodayPlanUser[] {
   const people = users.length > 0 ? users : uniqueTaskAssignees(tasks);
   const tasksByAssignee = new Map<string, TaskaraTask[]>();

   for (const task of tasks) {
      if (!task.assignee) continue;
      const current = tasksByAssignee.get(task.assignee.id) || [];
      current.push(task);
      tasksByAssignee.set(task.assignee.id, current);
   }

   return people
      .map((user) => {
         const userTasks = tasksByAssignee.get(user.id) || [];
         return {
            id: user.id,
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl,
            tasks: userTasks,
            totalWeight: userTasks.reduce((sum, task) => sum + taskWeight(task), 0),
         };
      })
      .sort((a, b) => {
         if (b.totalWeight !== a.totalWeight) return b.totalWeight - a.totalWeight;
         if (b.tasks.length !== a.tasks.length) return b.tasks.length - a.tasks.length;
         return a.name.localeCompare(b.name, 'fa');
      });
}

function isTodayPlanTask(task: TaskaraTask, todayEnd: number, now: number) {
   if (task.status === 'CANCELED') return false;
   if (task.status === 'DONE') return isToday(task.completedAt || task.updatedAt, now);
   if (!activeStatuses.has(task.status) || !task.dueAt) return false;

   const dueAt = new Date(task.dueAt).getTime();
   return Number.isFinite(dueAt) && dueAt <= todayEnd;
}

function endOfTodayTimestamp(now: number) {
   const end = new Date(now);
   end.setHours(23, 59, 59, 999);
   return end.getTime();
}

function compareTodayPlanTasks(left: TaskaraTask, right: TaskaraTask) {
   const leftDone = left.status === 'DONE';
   const rightDone = right.status === 'DONE';
   if (leftDone !== rightDone) return leftDone ? 1 : -1;

   const leftDate = todayPlanTaskTimestamp(left);
   const rightDate = todayPlanTaskTimestamp(right);
   if (leftDate !== rightDate) return leftDone ? rightDate - leftDate : leftDate - rightDate;

   return taskWeight(right) - taskWeight(left);
}

function todayPlanTaskTimestamp(task: TaskaraTask) {
   const value = task.status === 'DONE' ? task.completedAt || task.updatedAt : task.dueAt;
   if (!value) return 0;
   const timestamp = new Date(value).getTime();
   return Number.isFinite(timestamp) ? timestamp : 0;
}

function taskWeight(task: TaskaraTask) {
   return typeof task.weight === 'number' && Number.isFinite(task.weight) ? task.weight : 0;
}

function formatTaskWeight(weight: number | null | undefined) {
   return typeof weight === 'number' && Number.isFinite(weight)
      ? weight.toLocaleString('fa-IR')
      : fa.todayPlan.noWeight;
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
