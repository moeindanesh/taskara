import type { Prisma, TaskStatus } from '@taskara/db';

/**
 * What it means for a task to be blocked.
 *
 * A `TaskDependency` row is a permanent record: "this task waited on that one". It is *not* a
 * statement about now. The predicate that decides whether a task is takeable has to ask about the
 * blocker's current status, because the whole point of finishing a prerequisite is that the thing
 * behind it becomes available. Counting edges instead of open edges made "blocked" a one-way door:
 * a task whose blockers were all DONE read as blocked forever.
 *
 * CANCELED counts as closed alongside DONE. A canceled blocker will never be finished, so treating
 * it as still blocking would leave the task behind it permanently unreachable — the same one-way
 * door by another route. Cancelling a prerequisite is how you decide it is not needed.
 *
 * ## Filtered at read time, not a maintained counter column
 *
 * A denormalized `openBlockerCount` on Task would be sortable and filterable in raw SQL, and it was
 * the obvious candidate. It is rejected because it cannot be kept true:
 *
 *   - `TaskDependency` has `onDelete: Cascade` on both ends. Deleting a task removes its edges
 *     inside the database with no application code in the path, so every counter on the other side
 *     of those edges would silently drift. Correcting that needs a database trigger — and this
 *     repository has already learned (see the `TaskKind` CHECK constraints) that `prisma db push`
 *     bootstraps a schema without them, so a trigger is a guarantee that quietly disappears in
 *     exactly the environments least likely to notice.
 *   - Every status write would have to fan out to the counter of every task the written task
 *     blocks: `updateTask`, the triage transitions, the milestone bulk dispositions, the meeting
 *     action-item completion path, the seed script, and any future bulk update. Missing one is a
 *     wrong number with no error.
 *   - It would need a repair job nobody has asked for, to fix the drift the first two produce.
 *
 * The filtered read is one correlated subquery inside the query that was already being issued, so
 * it costs no extra round trip; `TaskDependency` is indexed by its unique `[taskId,
 * blockedByTaskId]` pair and the join reaches `Task` by primary key. The honest cost is that
 * "blocked" cannot be an indexed column to sort on. Nothing sorts on it today.
 *
 * ## Two forms, one definition
 *
 * `openBlockerEdgeWhere` is the single fact. Everything else here is that fact wearing the shape a
 * particular Prisma call needs — a `_count` filter, a `where` clause, or an in-memory test. Keep
 * them in step: a list drawn with one and a count drawn with another must describe the same tasks.
 */
export const closedBlockerStatuses = ['DONE', 'CANCELED'] as const satisfies readonly TaskStatus[];

/** An edge that still blocks: its blocker has not been finished or abandoned. */
export const openBlockerEdgeWhere = {
  blockedByTask: { status: { notIn: [...closedBlockerStatuses] } }
} satisfies Prisma.TaskDependencyWhereInput;

/**
 * The `_count` form. Spread into a `_count: { select: { ... } }` so the number a client reads is
 * the number of blockers still in the way, not the number of edges ever drawn.
 */
export const openBlockerCountSelect = { where: openBlockerEdgeWhere } as const;

/**
 * The `include` form, for the handful of call sites that materialise the edges and then count them
 * in memory. Passing `where` here keeps `.length` meaning the same thing as the `_count`.
 */
export const openBlockerEdgesInclude = { where: openBlockerEdgeWhere } as const;

/**
 * The `where` form: tasks with nothing open in front of them. This is the "no open blocker" clause
 * of a frontier query — a `NOT EXISTS`, composable with any other Task filter.
 */
export const hasNoOpenBlockerWhere = {
  blockingDependencies: { none: openBlockerEdgeWhere }
} satisfies Prisma.TaskWhereInput;

/**
 * The name #21 gave the same clause when it built `GET /tasks?blockers=none`, kept as an alias so
 * the two can be reconciled by deleting one line rather than by choosing a winner. #21 declared the
 * contract as *the meaning, not the spelling* — a blocker is open while it is neither DONE nor
 * CANCELED, and blockedness is a question about the blocker's status rather than about how many
 * edges exist. That is exactly this predicate, so its local copy in services/tasks.ts should become
 * `export { openBlockersWhere } from './blockers'`.
 */
export const openBlockersWhere = hasNoOpenBlockerWhere;

/** Its complement, for the "what is stuck" side of the same question. */
export const hasOpenBlockerWhere = {
  blockingDependencies: { some: openBlockerEdgeWhere }
} satisfies Prisma.TaskWhereInput;

/** In-memory form, for rows already loaded with their edges. */
export function isOpenBlockerStatus(status: TaskStatus): boolean {
  return !closedBlockerStatuses.includes(status as (typeof closedBlockerStatuses)[number]);
}
