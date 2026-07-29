import { config } from '../config';

// Every calendar-day decision in Taskara (daily reports, reminders, digests) resolves against a
// single workspace clock so a report written at 23:58 and one written at 00:03 land on the days a
// human would expect. Clients never compute the day key.
export const workspaceTimeZone = config.TASKARA_WORKSPACE_TIMEZONE;

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: workspaceTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: workspaceTimeZone,
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit'
});

export interface WorkspaceClockParts {
  dateKey: string;
  hour: number;
  minute: number;
  weekday: string;
}

export function workspaceDateKey(date: Date = new Date()): string {
  return dateKeyFormatter.format(date);
}

export function workspaceClockParts(date: Date = new Date()): WorkspaceClockParts {
  const parts = partsFormatter.formatToParts(date);
  const lookup = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  // "24" is how Intl reports midnight under hour12:false in some runtimes.
  const hour = Number(lookup('hour')) % 24;
  return {
    dateKey: workspaceDateKey(date),
    hour,
    minute: Number(lookup('minute')),
    weekday: lookup('weekday')
  };
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return formatUtcDateKey(new Date(Date.UTC(year, month - 1, day + days)));
}

export function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// Instant range covering the given workspace day, for querying timestamp columns.
export function dateKeyRange(dateKey: string): { start: Date; end: Date } {
  const offsetMinutes = timeZoneOffsetMinutes(new Date(`${dateKey}T12:00:00Z`));
  const start = new Date(Date.parse(`${dateKey}T00:00:00Z`) - offsetMinutes * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// The workspace work week. Iran's weekend is Thursday–Friday, so the default work week is Sat–Wed.
const workdays = new Set(['Sat', 'Sun', 'Mon', 'Tue', 'Wed']);

export function isWorkday(date: Date = new Date()): boolean {
  return workdays.has(workspaceClockParts(date).weekday) && !isHoliday(workspaceDateKey(date));
}

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Same question as isWorkday, asked about a workspace day rather than an instant. Noon UTC keeps the
// calendar date stable regardless of which side of the date line the offset falls on.
export function isWorkdayKey(dateKey: string): boolean {
  const weekday = weekdayNames[new Date(`${dateKey}T12:00:00Z`).getUTCDay()];
  return workdays.has(weekday) && !isHoliday(dateKey);
}

// v1 keeps the holiday list in code; a per-workspace calendar is deliberately out of scope.
const holidayDateKeys = new Set<string>([]);

export function isHoliday(dateKey: string): boolean {
  return holidayDateKeys.has(dateKey);
}

function formatUtcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function timeZoneOffsetMinutes(at: Date): number {
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(at.toLocaleString('en-US', { timeZone: workspaceTimeZone }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}
