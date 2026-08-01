import type { Prisma, TaskKind } from '@taskara/db';

/**
 * Which tasks count as WORK — the things a manager measures, ranks, triages and is alerted about.
 *
 * An EFFORT is an agent's map of what it is doing: a long-lived, prose-heavy row that is edited
 * constantly while it is being planned, holds no assignee, no due date, no weight and no milestone,
 * and is never finished in the sense a task is. Counting one alongside real work changes what every
 * number means — a status distribution, a project's health badge, "how many issues does this
 * project have", "who has unassigned work", "what has gone stale". None of those questions is about
 * the map.
 *
 * THE PROPERTY HAS TWO HALVES, and dropping either one is a regression:
 *   - an EFFORT is EXCLUDED from measurements and work lists. That is this predicate;
 *   - an EFFORT stays VISIBLE on reads. Its own row at `GET /tasks/:idOrKey`, its body, its
 *     comments, its activity, its children, its notifications. The effort IS the map: a manager who
 *     cannot open it has lost the only artifact explaining what an agent is up to, which is the
 *     reason the row exists at all. "Excluded" and "deleted" are not the same word.
 *
 * WHERE THIS MUST NOT LIVE: `team-access.ts`. `taskWhereForAccess` and the lookup where behind
 * `findTaskByIdOrKey` answer an AUTHORIZATION question — "what may this actor read" — and roughly
 * fifteen call sites compose them. Folding `kind: 'WORK'` in there looks like a one-line fix for
 * this whole ticket and is the exact opposite of one: every effort would 404 on detail, patch,
 * comment, activity and review in a single edit. Compose this predicate per site instead, and say
 * per site whether the site is a read (effort visible) or a measurement (effort excluded).
 *
 * There is deliberately no `effortTaskWhere`. The one place that wants the complement is the `kind`
 * query parameter on the task list, and reading the caller's value straight through is what keeps
 * that path visibly a read rather than an inverted measurement.
 */
export const workTaskWhere = { kind: 'WORK' } satisfies Prisma.TaskWhereInput;

/**
 * In-memory form, for the one list that cannot be filtered at the query: the daily-report draft
 * chips, which are rebuilt from ActivityLog snapshots. ActivityLog has no `kind` column — the task
 * is embedded in a JSON blob — so the filter has to happen after the rows are materialised.
 *
 * Snapshots written before the column existed carry no `kind` at all. Every one of those rows is
 * WORK (the column was added with `DEFAULT 'WORK'`), so callers must treat a missing `kind` as WORK
 * rather than feeding `undefined` in here and losing every legacy chip.
 */
export function isWorkTask(task: { kind: TaskKind }): boolean {
  return task.kind === 'WORK';
}
