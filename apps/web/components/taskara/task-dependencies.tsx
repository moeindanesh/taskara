/**
 * Seeing whether a task is takeable, and what it is waiting on.
 *
 * The shape here is what issue #26's prototype settled on: a body **section** carrying both
 * directions, and a **chip** in the properties rail for the glance. A banner across the top of the
 * body was rejected outright, because on a task with no dependencies — which is most tasks — it
 * still occupied a full row to say nothing, and a banner people learn to skip is skipped exactly
 * when it finally matters.
 *
 * That rejection is why {@link TaskDependenciesSection} returns `null` rather than an empty state.
 * The chip is not conditional: it is a property, and it sits beside status and assignee where a
 * property that is sometimes absent would be harder to read than one that is always there.
 *
 * Read-only in v1. The API can add and remove edges (#24 shipped DELETE, cycle refusal and sync
 * events), but `lib/task-sync.ts` has no dependency field on `TaskUpdatePatch`, so a mutation needs
 * a name, a sync-event shape, an optimistic path and a rollback path. Agents draw the edges; this is
 * how humans read them.
 */
import { Link } from 'react-router-dom';
import { Lock, Unlock } from 'lucide-react';
import { StatusIcon, linearStatusMeta } from '@/components/taskara/linear-ui';
import { cn } from '@/lib/utils';
import { fa } from '@/lib/fa-copy';
import {
   isOpenBlocker,
   openBlockerCount,
   readTakeability,
   type BlockerEdgeTask,
   type Takeability,
} from '@/lib/takeability';
import type { TaskaraTask } from '@/lib/taskara-types';

/**
 * «وابستگی‌ها» — both directions, or nothing at all.
 *
 * Silent unless the task participates in a dependency, and *not* only when it is blocked: a task
 * with no blockers that blocks something else renders too, showing «مسدودکننده‌ای ندارد» on one side
 * and the downstream task on the other. A map needs the downstream direction as much as the upstream
 * one, and this is the only surface that carries it.
 */
export function TaskDependenciesSection({
   task,
   orgId,
   className,
}: {
   task: TaskaraTask;
   orgId: string;
   className?: string;
}) {
   const state = readTakeability(task);
   if (!state.hasDependencies) return null;

   // Open first, then the resolved ones as history. Sorting rather than concatenating the two lists
   // would lose the API's ordering within each group for nothing.
   const blockers = [...state.openBlockers, ...state.closedBlockers];

   return (
      <section
         className={cn('rounded-lg border border-white/8 bg-[#141416] p-4', className)}
         data-testid="task-dependencies"
      >
         {/* No takeability chip here on purpose. The rail carries it, and inside the section the
             open blockers are listed two lines below — a chip counting them would be a third copy
             of a statement already on screen twice. */}
         <h2 className="mb-3 text-sm font-semibold text-zinc-200">{fa.issue.dependencies}</h2>
         <div className="grid gap-4 sm:grid-cols-2">
            <DependencyColumn
               emptyLabel={fa.blockers.noBlockers}
               icon={<Lock className="size-3" />}
               orgId={orgId}
               tasks={blockers}
               title={fa.blockers.blockedBy}
            />
            <DependencyColumn
               emptyLabel={fa.blockers.blocksNothing}
               icon={<Unlock className="size-3" />}
               orgId={orgId}
               tasks={state.blocks}
               title={fa.blockers.blocks}
            />
         </div>
      </section>
   );
}

/**
 * The rail property, so takeability is answerable without scrolling to the section — which is below
 * the fold on any task with a real description.
 */
export function TaskTakeabilityProperty({ task }: { task: TaskaraTask }) {
   const state = readTakeability(task);

   return (
      <div className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2">
         <span className="flex size-5 shrink-0 items-center justify-center text-zinc-500">
            {state.takeable ? <Unlock className="size-4" /> : <Lock className="size-4" />}
         </span>
         <span className="sr-only">{fa.blockers.takeState}</span>
         {/* One chip and nothing else. Resolved blockers are history and belong in the section,
             where they can be shown as the tasks they are rather than as a number. */}
         <TakeabilityChip state={state} />
      </div>
   );
}

/**
 * The list and board badge, from `_count.blockingDependencies` — already filtered to open blockers
 * by the API, so no new query and no status of its own.
 *
 * Nothing is drawn for an unblocked row. A green "takeable" pip on every row of a list where almost
 * everything is takeable is the banner's mistake at row scale.
 */
export function TaskBlockedBadge({ task, className }: { task: TaskaraTask; className?: string }) {
   const count = openBlockerCount(task);
   if (count === 0) return null;

   return (
      <span
         className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 text-[10px] font-medium text-amber-300',
            className
         )}
         data-testid="task-blocked-badge"
         title={fa.blockers.openCount(count)}
      >
         <Lock className="size-2.5 shrink-0" />
         <span>{count.toLocaleString('fa-IR')}</span>
         <span className="sr-only">{fa.blockers.blockedBadge}</span>
      </span>
   );
}

function TakeabilityChip({ state, className }: { state: Takeability; className?: string }) {
   const label = state.takeable
      ? fa.blockers.takeable
      : fa.blockers.openCount(state.openBlockers.length);

   return (
      <span
         className={cn(
            'inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium',
            state.takeable
               ? 'bg-emerald-500/10 text-emerald-300'
               : 'bg-amber-500/10 text-amber-300',
            className
         )}
         data-takeable={state.takeable ? 'true' : 'false'}
         data-testid="task-takeability-chip"
      >
         {state.takeable ? (
            <Unlock className="size-3 shrink-0" />
         ) : (
            <Lock className="size-3 shrink-0" />
         )}
         <span className="truncate">{label}</span>
      </span>
   );
}

function DependencyColumn({
   emptyLabel,
   icon,
   orgId,
   tasks,
   title,
}: {
   emptyLabel: string;
   icon: React.ReactNode;
   orgId: string;
   tasks: BlockerEdgeTask[];
   title: string;
}) {
   return (
      <div className="min-w-0">
         <div className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
            {icon}
            {title}
         </div>
         {tasks.length ? (
            tasks.map((item) => <DependencyLine key={item.id} orgId={orgId} task={item} />)
         ) : (
            <p className="py-1 text-xs text-zinc-600">{emptyLabel}</p>
         )}
      </div>
   );
}

function DependencyLine({ orgId, task }: { orgId: string; task: BlockerEdgeTask }) {
   const open = isOpenBlocker(task);

   return (
      <Link
         className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 transition hover:bg-white/5"
         to={`/${orgId}/issue/${encodeURIComponent(task.key)}`}
      >
         <StatusIcon className="size-3.5 shrink-0" status={task.status} />
         {/* A task key is Latin text inside RTL prose; without `.ltr` «CORE-2» renders reversed. */}
         <span className={cn('ltr shrink-0 text-xs font-medium', open ? 'text-zinc-400' : 'text-zinc-600')}>
            {task.key}
         </span>
         <span className={cn('min-w-0 truncate text-xs', open ? 'text-zinc-300' : 'text-zinc-600 line-through')}>
            {task.title}
         </span>
         {/* Its own status, not a generic «رفع شد». A DONE blocker was finished and a CANCELED one
             was abandoned; both stopped blocking, and calling the second one resolved would be a
             small lie in the one place a reader is deciding whether to trust the green chip. */}
         {open ? null : (
            <span className="shrink-0 text-[10px] text-zinc-500">
               {linearStatusMeta[task.status]?.label || task.status}
            </span>
         )}
      </Link>
   );
}
