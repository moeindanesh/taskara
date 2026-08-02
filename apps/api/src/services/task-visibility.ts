import type { Prisma, TaskStatus } from '@taskara/db';
import { isOpenBlockerStatus } from './blockers';
import { canReadProject, type WorkspaceAccess } from './team-access';

/**
 * What a reader sees of a task hanging off a task they *are* allowed to read.
 *
 * A task row carries other tasks with it: its blockers, the tasks it blocks, its subtasks. None of
 * those are constrained to the project the reader came in through — a dependency may point at any
 * task in the workspace, and a subtask survives its parent's project move — so returning them with
 * the row hands out work from behind team walls. That was issue #58, and it returned the whole row,
 * body and all.
 *
 * ## Redacted, not omitted
 *
 * The obvious fix is to compose `taskWhereForAccess` into the include and let the unreadable edges
 * fall out of the query. That is the wrong answer, and it is worth writing down why, because it is
 * the answer a reviewer will reach for.
 *
 * A task's blockedness has to be **true**. #24 made the open-blocker predicate correct and #50
 * renders it to a human as a takeable/blocked chip; both read the edge list. An edge that vanishes
 * because of who is asking makes a blocked task read as takeable — somebody picks it up, and the
 * thing in the way is invisible by construction. Of the two things a reader can be told about work
 * they may not see, "there is something here you cannot open" is honest and "there is nothing here"
 * is not.
 *
 * So the edge survives and its far end is replaced by {@link RedactedTaskRef}: no id, no key, no
 * title, no body, and **no foreign key on the edge row either** — a redaction that ships the hidden
 * task's primary key is cosmetic.
 *
 * ## Why `open` and not `status`
 *
 * The placeholder carries one bit: whether the hidden task is still live (`open`), on the same
 * DONE/CANCELED reading as everywhere else — see `blockers.ts`. Not its status, which would say
 * IN_REVIEW where TODO was the truth and disclose a state nobody is entitled to.
 *
 * One bit rather than none, because without it the reader cannot tell a hidden blocker that is
 * finished from one that is not, and both available guesses are lies: assume open and a task whose
 * only blocker was cancelled is walled off forever; assume closed and blockedness is back to being
 * false. And one bit is not a new disclosure — `_count.blockingDependencies` has published the
 * number of *open* blockers, unfiltered by access, since #24, and the list badge depends on it. A
 * per-edge flag over anonymous placeholders says nothing that count does not already say, because
 * "which of the hidden ones" is not a question that has an answer.
 */
export interface RedactedTaskRef {
  redacted: true;
  /** Still in the way (or, downstream, still unfinished). The one bit the frontier needs. */
  open: boolean;
}

/**
 * The project facts `canReadProject` asks about, pulled along with the related task.
 *
 * Spread into the include of whichever relation is being carried. It is the only reason the far end
 * is fetched with an `include` rather than left bare, and {@link visibleRelatedTask} strips it back
 * off, so a reader who may see the far end sees exactly the row they saw before this existed.
 */
export const relatedTaskAccessInclude = {
  project: { select: { id: true, teamId: true, leadId: true } }
} satisfies Prisma.TaskInclude;

type RelatedTaskRow = {
  status: TaskStatus;
  project: { id: string; teamId: string | null; leadId: string | null };
};

/**
 * The related task as this reader may see it — itself, or a placeholder standing where it was.
 *
 * **The decision is `canReadProject`**, called once per related task with that task's own project.
 * This does not restate the access rule; the include above only gathers the facts to ask it with.
 * Same shape as #57's `filterUsersWithTaskAccess`, asked the other way round: that one has one task
 * and many candidate readers, this one has one reader and many tasks.
 */
export function visibleRelatedTask<T extends RelatedTaskRow>(
  access: WorkspaceAccess,
  related: T
): Omit<T, 'project'> | RedactedTaskRef {
  const { project, ...task } = related;
  if (canReadProject(access, project)) return task;
  return { redacted: true, open: isOpenBlockerStatus(related.status) };
}

/** Whether {@link visibleRelatedTask} redacted this one — the wire's discriminant, in one place. */
export function isRedactedTaskRef(value: object): value is RedactedTaskRef {
  return (value as Partial<RedactedTaskRef>).redacted === true;
}

/**
 * Every other task a task detail carries, put through {@link visibleRelatedTask} in one pass.
 *
 * All three relations together rather than one call per relation at the call site, because the one
 * that gets forgotten is the one nobody was looking at: `subtasks` had no access clause either and
 * was not in the report. A parent keeps a child that is moved to another project — `updateTask`
 * accepts `projectId` and leaves `parentId` alone — so the subtask list crosses walls by the same
 * route the dependency list does.
 *
 * The foreign key goes with the row. `blockedByTaskId` and `taskId` name the far end as surely as
 * its key does, so a redacted edge carries `null` there; the edge's own id stays, because it
 * identifies the relationship the reader is entitled to know about.
 */
export function redactRelatedTasks<
  Sub extends RelatedTaskRow,
  Blocker extends RelatedTaskRow,
  Blocked extends RelatedTaskRow,
  T extends {
    subtasks: Sub[];
    blockingDependencies: Array<{ blockedByTaskId: string; blockedByTask: Blocker }>;
    blockedTasks: Array<{ taskId: string; task: Blocked }>;
  }
>(access: WorkspaceAccess, task: T) {
  return {
    ...task,
    subtasks: task.subtasks.map((subtask) => visibleRelatedTask(access, subtask)),
    blockingDependencies: task.blockingDependencies.map((edge) => {
      const blockedByTask = visibleRelatedTask(access, edge.blockedByTask);
      return isRedactedTaskRef(blockedByTask)
        ? { ...edge, blockedByTaskId: null, blockedByTask }
        : { ...edge, blockedByTask };
    }),
    blockedTasks: task.blockedTasks.map((edge) => {
      const blocked = visibleRelatedTask(access, edge.task);
      return isRedactedTaskRef(blocked)
        ? { ...edge, taskId: null, task: blocked }
        : { ...edge, task: blocked };
    })
  };
}
