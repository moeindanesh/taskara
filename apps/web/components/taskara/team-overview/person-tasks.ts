// Task lists behind the person sheet. The graph shows a person's Today Load; the sheet shows the
// wider pool you draw that load from — everything still open for them, plus everything nobody owns
// yet — so pulling work into today is a one-click move rather than a trip to the task list.

import { type WorkspaceDay, isActiveStatus } from './today-load';

export interface ListedTask {
   id: string;
   key: string;
   title: string;
   status: string;
   priority: string;
   weight?: number | null;
   dueAt?: string | null;
   assignee?: { id: string } | null;
}

/** Most urgent first: overdue, then due today, then dated work, then work with no date at all. */
export const urgencyRanks = { overdue: 0, today: 1, upcoming: 2, undated: 3 } as const;

const priorityRank: Record<string, number> = {
   URGENT: 0,
   HIGH: 1,
   MEDIUM: 2,
   LOW: 3,
   NO_PRIORITY: 4,
};

function dueTimestamp(task: ListedTask): number | null {
   if (!task.dueAt) return null;
   const parsed = Date.parse(task.dueAt);
   return Number.isNaN(parsed) ? null : parsed;
}

export function isDueToday(task: ListedTask, day: WorkspaceDay): boolean {
   const dueAt = dueTimestamp(task);
   return dueAt !== null && dueAt >= day.start && dueAt < day.end;
}

export function isOverdue(task: ListedTask, day: WorkspaceDay): boolean {
   const dueAt = dueTimestamp(task);
   return dueAt !== null && dueAt < day.start;
}

export function urgencyRank(task: ListedTask, day: WorkspaceDay): number {
   const dueAt = dueTimestamp(task);
   if (dueAt === null) return urgencyRanks.undated;
   if (dueAt < day.start) return urgencyRanks.overdue;
   if (dueAt < day.end) return urgencyRanks.today;
   return urgencyRanks.upcoming;
}

function compare(day: WorkspaceDay) {
   return (left: ListedTask, right: ListedTask): number => {
      const byUrgency = urgencyRank(left, day) - urgencyRank(right, day);
      if (byUrgency !== 0) return byUrgency;

      const leftDue = dueTimestamp(left);
      const rightDue = dueTimestamp(right);
      if (leftDue !== null && rightDue !== null && leftDue !== rightDue) return leftDue - rightDue;

      const byPriority =
         (priorityRank[left.priority] ?? priorityRank.NO_PRIORITY) -
         (priorityRank[right.priority] ?? priorityRank.NO_PRIORITY);
      if (byPriority !== 0) return byPriority;

      return left.key.localeCompare(right.key, 'en');
   };
}

/** Everything still open for one person, whatever it is due — this is the pool, not the day. */
export function selectPersonTasks<T extends ListedTask>(tasks: T[], userId: string, day: WorkspaceDay): T[] {
   return tasks.filter((task) => task.assignee?.id === userId && isActiveStatus(task.status)).sort(compare(day));
}

/** Open work nobody owns. Deliberately absent from the graph, which is why the sheet surfaces it. */
export function selectUnassignedTasks<T extends ListedTask>(tasks: T[], day: WorkspaceDay): T[] {
   return tasks.filter((task) => !task.assignee?.id && isActiveStatus(task.status)).sort(compare(day));
}
