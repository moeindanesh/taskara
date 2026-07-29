// Today Load (بار امروز) is the computed set of tasks that make up a person's working set for the
// current workspace day: unfinished work due today or earlier (overdue included, no age cap) plus
// whatever they finished today. It is derived from task data — never self-reported. The self-reported
// counterpart is the daily report's `planText`; see CONTEXT.md.
//
// Day boundaries resolve against the workspace clock, mirroring apps/api/src/services/workspace-time.ts.
// Keep the two in sync: a member's day must start and end at the same instant on both sides.

export const defaultWorkspaceTimeZone = 'Asia/Tehran';

export const workspaceTimeZone =
   import.meta.env?.VITE_TASKARA_WORKSPACE_TIMEZONE?.trim() || defaultWorkspaceTimeZone;

/** Statuses that count as unfinished work. CANCELED is excluded — it is not work anyone will do. */
export const todayLoadActiveStatuses = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] as const;

const activeStatuses = new Set<string>(todayLoadActiveStatuses);

/** The half-open instant range [start, end) covering one workspace day. */
export interface WorkspaceDay {
   dateKey: string;
   start: number;
   end: number;
}

/** The shape Today Load needs from a task. Structural on purpose so the rules stay testable. */
export interface TodayLoadTask {
   status: string;
   dueAt?: string | null;
   completedAt?: string | null;
}

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function dateKeyFormatter(timeZone: string): Intl.DateTimeFormat {
   let formatter = dateKeyFormatters.get(timeZone);
   if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-CA', {
         timeZone,
         year: 'numeric',
         month: '2-digit',
         day: '2-digit',
      });
      dateKeyFormatters.set(timeZone, formatter);
   }
   return formatter;
}

/** The workspace calendar day containing `date`, as `YYYY-MM-DD`. */
export function workspaceDateKey(date: Date = new Date(), timeZone: string = workspaceTimeZone): string {
   return dateKeyFormatter(timeZone).format(date);
}

function timeZoneOffsetMinutes(at: Date, timeZone: string): number {
   const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
   const local = new Date(at.toLocaleString('en-US', { timeZone }));
   return Math.round((local.getTime() - utc.getTime()) / 60000);
}

/** Resolves a `YYYY-MM-DD` day key into the instant range it covers in the workspace timezone. */
export function workspaceDay(dateKey: string, timeZone: string = workspaceTimeZone): WorkspaceDay {
   // Noon avoids the DST edges where a day's own midnight sits in the shifted hour.
   const offsetMinutes = timeZoneOffsetMinutes(new Date(`${dateKey}T12:00:00Z`), timeZone);
   const start = Date.parse(`${dateKey}T00:00:00Z`) - offsetMinutes * 60_000;
   return { dateKey, start, end: start + 24 * 60 * 60 * 1000 };
}

export function currentWorkspaceDay(now: Date = new Date(), timeZone: string = workspaceTimeZone): WorkspaceDay {
   return workspaceDay(workspaceDateKey(now, timeZone), timeZone);
}

function timestamp(value: string | null | undefined): number | null {
   if (!value) return null;
   const parsed = Date.parse(value);
   return Number.isNaN(parsed) ? null : parsed;
}

function normalizeStatus(status: string | null | undefined): string {
   return (status ?? '').toUpperCase();
}

export function isActiveStatus(status: string | null | undefined): boolean {
   return activeStatuses.has(normalizeStatus(status));
}

/**
 * Unfinished and due by the end of the day (however long overdue), or finished during it.
 * Tasks with no due date are not part of the load: nobody has committed them to a day yet.
 */
export function isInTodayLoad(task: TodayLoadTask, day: WorkspaceDay): boolean {
   const status = normalizeStatus(task.status);

   if (status === 'DONE') {
      const completedAt = timestamp(task.completedAt);
      return completedAt !== null && completedAt >= day.start && completedAt < day.end;
   }

   if (!activeStatuses.has(status)) return false;

   const dueAt = timestamp(task.dueAt);
   return dueAt !== null && dueAt < day.end;
}

/** Unfinished work whose due date fell before this day began. Completed work is never overdue. */
export function isOverdue(task: TodayLoadTask, day: WorkspaceDay): boolean {
   if (!activeStatuses.has(normalizeStatus(task.status))) return false;
   const dueAt = timestamp(task.dueAt);
   return dueAt !== null && dueAt < day.start;
}

/** The instant a task created from this view should be due: the end of the current workspace day. */
export function endOfWorkspaceDay(day: WorkspaceDay): Date {
   return new Date(day.end - 1);
}
