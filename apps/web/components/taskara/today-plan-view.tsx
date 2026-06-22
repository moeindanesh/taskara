'use client';

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CalendarCheck2, Gauge } from 'lucide-react';
import {
   LinearAvatar,
   LinearEmptyState,
   LinearPanel,
   ProjectGlyph,
   StatusIcon,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { fa } from '@/lib/fa-copy';
import { formatJalaliDate } from '@/lib/jalali';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import type { TaskaraTask, TaskaraUser } from '@/lib/taskara-types';
import { cn } from '@/lib/utils';

const dailyWeightLimit = 8;
const excludedStatuses = new Set(['DONE', 'CANCELED']);

type TodayPlanUser = Pick<TaskaraUser, 'id' | 'name' | 'email' | 'avatarUrl'> & {
   tasks: TaskaraTask[];
   totalWeight: number;
};

export function TodayPlanView() {
   const { orgId } = useParams();
   const { tasks, users, loading, error } = useWorkspaceTaskSync();

   const todayEnd = useMemo(() => endOfTodayTimestamp(), []);
   const dueTasks = useMemo(
      () =>
         tasks
            .filter((task) => isDueTodayOrBefore(task, todayEnd))
            .sort((a, b) => compareDueTasks(a, b)),
      [tasks, todayEnd]
   );
   const userPlans = useMemo(() => buildUserPlans(users, dueTasks), [dueTasks, users]);

   return (
      <div className="flex h-full flex-col bg-[#101011]" data-testid="today-plan-screen">
         <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
            {error ? (
               <p className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                  {error}
               </p>
            ) : null}

            {loading ? (
               <div className="p-4 text-sm text-zinc-500">{fa.app.loading}</div>
            ) : (
               <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
                  <LinearPanel
                     title={
                        <div className="flex items-center justify-between gap-3">
                           <span className="flex min-w-0 items-center gap-2">
                              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-indigo-400/20 bg-indigo-400/10 text-indigo-200">
                                 <CalendarCheck2 className="size-3.5" />
                              </span>
                              <span className="truncate">{fa.todayPlan.peopleWorkload}</span>
                           </span>
                           <span className="shrink-0 text-xs font-normal text-zinc-500">
                              {fa.todayPlan.capacityLabel(dailyWeightLimit)}
                           </span>
                        </div>
                     }
                     className="overflow-hidden"
                  >
                     {userPlans.length === 0 ? (
                        <div className="p-4">
                           <LinearEmptyState>{fa.todayPlan.noUsers}</LinearEmptyState>
                        </div>
                     ) : (
                        <div className="divide-y divide-white/6">
                           {userPlans.map((user) => (
                              <TodayPlanUserRow
                                 key={user.id}
                                 orgId={orgId || 'taskara'}
                                 user={user}
                              />
                           ))}
                        </div>
                     )}
                  </LinearPanel>

                  {dueTasks.some((task) => !task.assignee) ? (
                     <UnassignedTasksPanel
                        orgId={orgId || 'taskara'}
                        tasks={dueTasks.filter((task) => !task.assignee)}
                     />
                  ) : null}
               </div>
            )}
         </div>
      </div>
   );
}

function TodayPlanUserRow({ orgId, user }: { orgId: string; user: TodayPlanUser }) {
   const overload = Math.max(user.totalWeight - dailyWeightLimit, 0);
   const progress = Math.min((user.totalWeight / dailyWeightLimit) * 100, 100);
   const taskCount = user.tasks.length;

   return (
      <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
         <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-3">
               <LinearAvatar name={user.name} src={user.avatarUrl} className="size-8" />
               <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-200">{user.name}</div>
                  <div className="ltr mt-1 truncate text-xs text-zinc-500">{user.email}</div>
               </div>
            </div>
            <div className="mt-4">
               <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                  <span className={cn('font-medium', overload > 0 ? 'text-rose-200' : user.totalWeight >= dailyWeightLimit ? 'text-emerald-200' : 'text-zinc-400')}>
                     {fa.todayPlan.weightOfLimit(user.totalWeight, dailyWeightLimit)}
                  </span>
                  <span className="text-zinc-500">
                     {overload > 0
                        ? fa.todayPlan.overloadBy(overload)
                        : taskCount > 0
                          ? fa.todayPlan.taskCount(taskCount)
                          : fa.todayPlan.noTasks}
                  </span>
               </div>
               <div className="h-2 overflow-hidden rounded-full bg-white/7">
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
               <LinearEmptyState className="py-4">{fa.todayPlan.noDueTasks}</LinearEmptyState>
            ) : (
               <div className="grid gap-2 xl:grid-cols-2">
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
      'block min-w-0 rounded-lg border border-white/7 bg-white/[0.018] px-3 py-2.5 transition hover:border-white/12 hover:bg-white/[0.035]';

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

   return (
      <div className="min-w-0">
         <div className="flex min-w-0 items-center gap-2">
            <StatusIcon status={task.status} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-right text-sm text-zinc-200 [unicode-bidi:plaintext]" dir="rtl">
               {task.title}
            </span>
            <span className="shrink-0 rounded-full border border-white/8 bg-white/[0.035] px-2 py-0.5 text-[11px] text-zinc-400">
               {formatTaskWeight(task.weight)}
            </span>
         </div>
         <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span className="flex min-w-0 items-center gap-1.5">
               <ProjectGlyph name={task.project?.name} className="size-4 shrink-0 rounded-sm" iconClassName="size-3" />
               <span className="min-w-0 truncate">{task.project?.name || fa.app.unset}</span>
            </span>
            <span>{statusLabel}</span>
            <span>{formatJalaliDate(task.dueAt)}</span>
         </div>
      </div>
   );
}

function UnassignedTasksPanel({ orgId, tasks }: { orgId: string; tasks: TaskaraTask[] }) {
   return (
      <LinearPanel
         title={
            <div className="flex items-center justify-between gap-3">
               <span className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-amber-400/20 bg-amber-400/10 text-amber-200">
                     <Gauge className="size-3.5" />
                  </span>
                  <span className="truncate">{fa.todayPlan.unassignedTasks}</span>
               </span>
               <span className="shrink-0 rounded-full border border-white/8 bg-white/[0.035] px-2 py-0.5 text-[11px] text-zinc-400">
                  {tasks.length.toLocaleString('fa-IR')}
               </span>
            </div>
         }
      >
         <div className="grid gap-2 p-4 md:grid-cols-2 xl:grid-cols-3">
            {tasks.map((task) => (
               <TodayPlanTaskItem key={task.id} orgId={orgId} task={task} />
            ))}
         </div>
      </LinearPanel>
   );
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

function isDueTodayOrBefore(task: TaskaraTask, todayEnd: number) {
   if (!task.dueAt || excludedStatuses.has(task.status)) return false;
   const dueAt = new Date(task.dueAt).getTime();
   return Number.isFinite(dueAt) && dueAt <= todayEnd;
}

function endOfTodayTimestamp() {
   const end = new Date();
   end.setHours(23, 59, 59, 999);
   return end.getTime();
}

function compareDueTasks(left: TaskaraTask, right: TaskaraTask) {
   const leftDue = left.dueAt ? new Date(left.dueAt).getTime() || 0 : 0;
   const rightDue = right.dueAt ? new Date(right.dueAt).getTime() || 0 : 0;
   if (leftDue !== rightDue) return leftDue - rightDue;
   return (right.weight || 0) - (left.weight || 0);
}

function taskWeight(task: TaskaraTask) {
   return typeof task.weight === 'number' && Number.isFinite(task.weight) ? task.weight : 0;
}

function formatTaskWeight(weight: number | null | undefined) {
   return typeof weight === 'number' && Number.isFinite(weight)
      ? weight.toLocaleString('fa-IR')
      : fa.todayPlan.noWeight;
}
