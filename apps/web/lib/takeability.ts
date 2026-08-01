import type { TaskBlockersFilter, TaskaraTask } from '@/lib/taskara-types';

/**
 * Whether a task can be picked up, and what is standing in front of it.
 *
 * ## Openness is a question about the blocker's status
 *
 * A `TaskDependency` row records that a task waited on another one. It is not a statement about now.
 * `GET /tasks/:idOrKey` returns the edges **unfiltered** on purpose — issue #24 settled that "the
 * count is the predicate, the list is the record" — so a blocker finished last month is still a
 * member of `blockingDependencies`. Deriving blockedness from membership therefore calls a finished
 * prerequisite blocking, and the task behind it never becomes takeable. Every read here asks the
 * blocker's `status` instead, and closed blockers are kept and shown as history rather than dropped:
 * "this was in the way and it is not any more" is the answer a human is looking for, and hiding it
 * makes a resolved dependency indistinguishable from one that never existed.
 *
 * CANCELED is closed alongside DONE, matching `apps/api/src/services/blockers.ts` — a canceled
 * prerequisite will never be finished, so treating it as open would wall the task off permanently.
 *
 * ## Two sources, deliberately
 *
 * The detail page has the edges and reads them with {@link readTakeability}. The list and the board
 * have only `_count.blockingDependencies`, which the API already filters to open blockers, so
 * {@link openBlockerCount} is the same fact arriving pre-counted. Keep the two in step: a row badged
 * as blocked in the list must show open blockers when it is opened.
 */
export const closedBlockerStatuses = ['DONE', 'CANCELED'] as const;

/** A task at the far end of a dependency edge, in either direction. */
export interface BlockerEdgeTask {
   id: string;
   key: string;
   title: string;
   status: string;
}

export interface Takeability {
   /** Blockers still in the way, in the order the API returned them. */
   openBlockers: BlockerEdgeTask[];
   /** Blockers that were in the way and are not any more. Shown as history, never hidden. */
   closedBlockers: BlockerEdgeTask[];
   /** Tasks waiting on this one. Unfinished and finished alike — the downstream record. */
   blocks: BlockerEdgeTask[];
   /** Nothing open in front of it. True for a task with no blockers at all. */
   takeable: boolean;
   /**
    * Whether this task participates in any dependency at all, in either direction. The section that
    * renders takeability is silent when this is false, which is most tasks — and it is why the
    * prototype's banner variant was rejected. It is deliberately *not* `openBlockers.length > 0`: a
    * task with no blockers that blocks something else still has a relationship worth drawing.
    */
   hasDependencies: boolean;
}

/** Is this blocker still in the way? */
export function isOpenBlocker(task: { status: string }): boolean {
   return !closedBlockerStatuses.includes(task.status as (typeof closedBlockerStatuses)[number]);
}

/**
 * Read both directions of a task's dependencies off a detail-route payload.
 *
 * Tolerates a missing edge target (`blockedByTask` / `task` are optional on the type because a
 * cached row can predate the include) by dropping the edge — an edge with nothing on the far end has
 * nothing to render and must not be counted as a blocker.
 */
export function readTakeability(task: TaskaraTask): Takeability {
   const blockers = (task.blockingDependencies ?? [])
      .map((edge) => edge.blockedByTask)
      .filter((value): value is BlockerEdgeTask => Boolean(value));
   const blocks = (task.blockedTasks ?? [])
      .map((edge) => edge.task)
      .filter((value): value is BlockerEdgeTask => Boolean(value));

   const openBlockers = blockers.filter(isOpenBlocker);
   const closedBlockers = blockers.filter((blocker) => !isOpenBlocker(blocker));

   return {
      openBlockers,
      closedBlockers,
      blocks,
      takeable: openBlockers.length === 0,
      hasDependencies: blockers.length > 0 || blocks.length > 0
   };
}

/**
 * How many blockers are still in the way, for a row that carries only the count.
 *
 * `_count.blockingDependencies` is filtered to open blockers by the API (#24 fixed all three
 * includes that feed the sync stream), so this needs no status of its own. Absent on a task created
 * offline and not yet synced, which has no edges either — zero is the truth there, not a guess.
 */
export function openBlockerCount(task: TaskaraTask): number {
   return task._count?.blockingDependencies ?? 0;
}

/**
 * The list/board filter: `none` is the frontier, `any` is what is stuck, `all` is no filter.
 *
 * The values are the API's `?blockers=none|any` spelling from #21 so the two never drift, with `all`
 * standing in for the absent parameter because a saved view serializes every key.
 */
export function matchesBlockersFilter(task: TaskaraTask, filter: TaskBlockersFilter): boolean {
   if (filter === 'all') return true;
   return filter === 'none' ? openBlockerCount(task) === 0 : openBlockerCount(task) > 0;
}

/**
 * What «آماده برداشت» means, and it is narrower than "unfinished with nothing in front of it".
 *
 * Something already IN_PROGRESS or IN_REVIEW has been taken, so offering it as takeable answers a
 * question nobody asked. BLOCKED is excluded for the opposite reason: the status is self-declared
 * and unrelated to dependency edges (CONTEXT.md), so a person who set it has said this is not ready
 * whatever the graph thinks — and a view that overrules them would be worse than no view.
 *
 * The broader set is a click away, because the blockers filter is a first-class control now:
 * widening the status filter on top of `blockers: 'none'` is how you ask that question.
 */
export const takeableStatuses: readonly string[] = ['BACKLOG', 'TODO'];

/**
 * The takeable view's predicate, shared with its chip count so the number on the chip and the rows
 * behind it can never disagree.
 */
export function isTakeable(task: TaskaraTask): boolean {
   return takeableStatuses.includes(task.status) && openBlockerCount(task) === 0;
}
