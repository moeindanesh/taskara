import type { TaskaraTask, TaskaraTaskKind } from '@/lib/taskara-types';

/**
 * Which Task rows are work.
 *
 * An **Effort** (`TaskKind.EFFORT`) is the root of an effort — a wayfinder map. It carries the
 * Destination, the Notes and the Decisions-so-far, and owns its tickets through `parentId`. It is a
 * real Task with a real key and a real URL, but it is not a unit of work: nobody is assigned it,
 * nothing is due on it, and no human should ever be offered it as something to pick up. See
 * https://github.com/moeindanesh/taskara/issues/19 for why it is a Task with a kind rather than a
 * separate model, and CONTEXT.md for the vocabulary.
 *
 * The test is on `kind` and never on shape. An effort holds no assignee, no due date, no weight and
 * no milestone — enforced by a database CHECK — so it is tempting to recognise one by its emptiness.
 * That reasoning is backwards, and it is the single sharpest finding of the exclusion audit: in
 * roughly a third of the places that leak, *absence* is the inclusion predicate. `!task.assignee?.id`
 * is how the person sheet decides a row is unowned work to claim; `!task.milestone?.id` is how the
 * task list decides a row belongs in «بدون گام». An effort is selected *by* being empty. Pinning its
 * fields to NULL locks the leak in rather than removing it, so the discriminator has to be a positive
 * field that says what the row is.
 *
 * Absence of `kind` itself means WORK, and that is a fact rather than a lenient default: efforts did
 * not exist when the older cached snapshots were written, so a row from one cannot be an effort. The
 * alternative — treating an unknown `kind` as non-work — would empty the board for anyone holding a
 * snapshot from a build that predates the column.
 */
export function isEffort(task: { kind?: TaskaraTaskKind | null }): boolean {
   return task.kind === 'EFFORT';
}

/**
 * The work in a list of tasks, in order.
 *
 * Returns the same array when there is nothing to remove, which is the overwhelmingly common case.
 * That is not a micro-optimisation: this runs on every write to the task cache, and handing back a
 * fresh array each time would change the identity every consumer's `useMemo` depends on, re-deriving
 * the board, the graph and the Heartbeat panel on every keystroke of somebody else's sync.
 */
export function selectWorkTasks<T extends { kind?: TaskaraTaskKind | null }>(tasks: T[]): T[] {
   return tasks.some(isEffort) ? tasks.filter((task) => !isEffort(task)) : tasks;
}

/**
 * The one gate into the client task cache.
 *
 * Every consumer of `useWorkspaceTaskSync()` reads one workspace-wide array — the task list, the
 * board, the Heartbeat panel, the person sheet, the command palette, the sidebar counts. Filtering
 * per consumer would mean the same rule hand-copied roughly a dozen times, and any view added later
 * would leak by default because nothing tells its author the array can contain a non-work row. So
 * the array simply never contains one, and no consumer has to know efforts exist.
 *
 * The gate applies to what the cache *becomes*, not to what arrives, so it covers three cases with
 * one rule: a fresh bootstrap payload, an incremental upsert from the event stream, and a stale row
 * already sitting in the cache from a snapshot written before this gate existed.
 */
export function admitTasksToCache(
   current: TaskaraTask[],
   update: TaskaraTask[] | ((current: TaskaraTask[]) => TaskaraTask[])
): TaskaraTask[] {
   return selectWorkTasks(typeof update === 'function' ? update(current) : update);
}
