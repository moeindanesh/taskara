/**
 * Business-time arithmetic for Support SLA clocks.
 *
 * Calendar dates/minutes are interpreted in the calendar's own IANA timezone and every result is
 * a UTC instant. Arithmetic walks local business periods, not elapsed 24-hour days, so daylight
 * saving transitions, non-working days, and holiday overrides cannot distort a deadline.
 */

export interface SupportBusinessPeriodInput {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface SupportBusinessHolidayInput {
  /** Persistence rows use `date`; already-frozen snapshots use `dateKey`. */
  date?: Date | string;
  dateKey?: string;
  working: boolean;
}

export interface SupportBusinessCalendarInput {
  timezone: string;
  periods: readonly SupportBusinessPeriodInput[];
  holidays?: readonly SupportBusinessHolidayInput[];
}

export interface SupportBusinessCalendarSnapshot {
  timezone: string;
  periods: SupportBusinessPeriodInput[];
  holidays: Array<{ dateKey: string; working: boolean }>;
}

interface LocalDateTimeParts {
  dateKey: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  isoDayOfWeek: number;
}

interface BusinessInterval {
  start: Date;
  end: Date;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const MAX_SEARCH_DAYS = 3660;

export function snapshotSupportBusinessCalendar(calendar: SupportBusinessCalendarInput): SupportBusinessCalendarSnapshot {
  assertValidTimeZone(calendar.timezone);
  const periods = [...calendar.periods]
    .map((period) => ({
      dayOfWeek: period.dayOfWeek,
      startMinute: period.startMinute,
      endMinute: period.endMinute
    }))
    .sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  validateBusinessPeriods(periods);
  const holidays = [...(calendar.holidays ?? [])]
    .map((holiday) => ({
      dateKey: holidayDateKey(holiday.date ?? holiday.dateKey ?? ''),
      working: holiday.working
    }))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
  for (let index = 1; index < holidays.length; index += 1) {
    if (holidays[index - 1].dateKey === holidays[index].dateKey) {
      throw new Error('Business calendar holidays cannot contain duplicate dates');
    }
  }
  return {
    timezone: calendar.timezone,
    periods,
    holidays
  };
}

export function addSupportBusinessSeconds(
  calendar: SupportBusinessCalendarInput,
  startedAt: Date,
  seconds: number
): Date {
  assertValidInstant(startedAt, 'startedAt');
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error('Business seconds must be a non-negative integer');
  const snapshot = snapshotSupportBusinessCalendar(calendar);
  if (!snapshot.periods.length) throw new Error('Business calendar has no work periods');
  // Adding no duration must be an identity operation. Snapping to the next opening here used to
  // move a deadline that was paused entirely outside business hours (for example Monday 17:00)
  // to Tuesday 09:00 even though zero business seconds elapsed.
  if (seconds === 0) return new Date(startedAt);

  let cursor = new Date(startedAt);
  let remainingMilliseconds = seconds * 1000;
  let previousLocalDateKey = localParts(cursor, snapshot.timezone).dateKey;
  let searchedDays = 0;
  while (searchedDays <= MAX_SEARCH_DAYS) {
    const interval = businessIntervalContainingOrAfter(snapshot, cursor);
    const availableMilliseconds = interval.end.getTime() - interval.start.getTime();
    if (remainingMilliseconds <= availableMilliseconds) {
      return new Date(interval.start.getTime() + remainingMilliseconds);
    }
    remainingMilliseconds -= availableMilliseconds;
    cursor = new Date(interval.end.getTime() + 1);
    const nextLocalDateKey = localParts(cursor, snapshot.timezone).dateKey;
    if (nextLocalDateKey !== previousLocalDateKey) searchedDays += 1;
    previousLocalDateKey = nextLocalDateKey;
  }
  throw new Error('Could not find enough business time within ten years');
}

export function supportBusinessSecondsBetween(
  calendar: SupportBusinessCalendarInput,
  startedAt: Date,
  endedAt: Date
): number {
  assertValidInstant(startedAt, 'startedAt');
  assertValidInstant(endedAt, 'endedAt');
  if (endedAt.getTime() <= startedAt.getTime()) return 0;
  const snapshot = snapshotSupportBusinessCalendar(calendar);
  if (!snapshot.periods.length) return 0;

  let totalMilliseconds = 0;
  let dateKey = localParts(startedAt, snapshot.timezone).dateKey;
  const finalDateKey = localParts(endedAt, snapshot.timezone).dateKey;
  for (let days = 0; days <= MAX_SEARCH_DAYS; days += 1) {
    for (const interval of intervalsForLocalDate(snapshot, dateKey)) {
      const overlapStart = Math.max(startedAt.getTime(), interval.start.getTime());
      const overlapEnd = Math.min(endedAt.getTime(), interval.end.getTime());
      if (overlapEnd > overlapStart) totalMilliseconds += overlapEnd - overlapStart;
    }
    if (dateKey === finalDateKey) break;
    dateKey = shiftLocalDateKey(dateKey, 1);
    if (days === MAX_SEARCH_DAYS) throw new Error('Business-time range exceeds ten years');
  }
  return Math.floor(totalMilliseconds / 1000);
}

export function nextSupportBusinessInstant(calendar: SupportBusinessCalendarInput, at: Date): Date {
  assertValidInstant(at, 'at');
  const snapshot = snapshotSupportBusinessCalendar(calendar);
  if (!snapshot.periods.length) throw new Error('Business calendar has no work periods');
  return businessIntervalContainingOrAfter(snapshot, at).start;
}

export function isSupportBusinessInstant(calendar: SupportBusinessCalendarInput, at: Date): boolean {
  assertValidInstant(at, 'at');
  const snapshot = snapshotSupportBusinessCalendar(calendar);
  const dateKey = localParts(at, snapshot.timezone).dateKey;
  return intervalsForLocalDate(snapshot, dateKey).some(
    (interval) => at.getTime() >= interval.start.getTime() && at.getTime() < interval.end.getTime()
  );
}

export function localSupportDateKey(at: Date, timezone: string): string {
  assertValidInstant(at, 'at');
  assertValidTimeZone(timezone);
  return localParts(at, timezone).dateKey;
}

function businessIntervalContainingOrAfter(
  calendar: SupportBusinessCalendarSnapshot,
  at: Date
): BusinessInterval {
  let dateKey = localParts(at, calendar.timezone).dateKey;
  for (let days = 0; days <= MAX_SEARCH_DAYS; days += 1) {
    for (const interval of intervalsForLocalDate(calendar, dateKey)) {
      if (at.getTime() < interval.start.getTime()) return interval;
      if (at.getTime() < interval.end.getTime()) return { start: new Date(at), end: interval.end };
    }
    dateKey = shiftLocalDateKey(dateKey, 1);
  }
  throw new Error('Could not find the next business instant within ten years');
}

function intervalsForLocalDate(
  calendar: SupportBusinessCalendarSnapshot,
  dateKey: string
): BusinessInterval[] {
  const holiday = calendar.holidays.find((candidate) => candidate.dateKey === dateKey);
  if (holiday && !holiday.working) return [];
  const isoDayOfWeek = isoDayForDateKey(dateKey);
  const periods = calendar.periods.filter((period) => period.dayOfWeek === isoDayOfWeek);
  if (!periods.length) return [];
  return periods.map((period) => ({
    start: zonedDateTimeToUtc(dateKey, period.startMinute, calendar.timezone),
    end: zonedDateTimeToUtc(dateKey, period.endMinute, calendar.timezone)
  }));
}

/** Resolve a local wall-clock date/minute to a UTC instant without a Temporal dependency. */
function zonedDateTimeToUtc(dateKey: string, minuteOfDay: number, timezone: string): Date {
  const nextDay = minuteOfDay === 1440;
  const targetDate = nextDay ? shiftLocalDateKey(dateKey, 1) : dateKey;
  const [targetYear, targetMonth, targetDay] = targetDate.split('-').map(Number);
  const targetHour = nextDay ? 0 : Math.floor(minuteOfDay / 60);
  const targetMinute = nextDay ? 0 : minuteOfDay % 60;
  let guess = Date.UTC(targetYear, targetMonth - 1, targetDay, targetHour, targetMinute);

  // Offset iteration converges for normal instants and both sides of DST. The final comparison
  // catches nonexistent local times rather than silently inventing a deadline.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = localParts(new Date(guess), timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
    const wanted = Date.UTC(targetYear, targetMonth - 1, targetDay, targetHour, targetMinute);
    const delta = wanted - represented;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }

  const resolved = localParts(new Date(guess), timezone);
  if (
    resolved.year !== targetYear || resolved.month !== targetMonth || resolved.day !== targetDay ||
    resolved.hour !== targetHour || resolved.minute !== targetMinute
  ) {
    throw new Error(`Local time ${targetDate}T${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')} does not exist in ${timezone}`);
  }
  return new Date(guess);
}

function localParts(at: Date, timezone: string): LocalDateTimeParts {
  const parts = formatterFor(timezone).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  const year = Number(value('year'));
  const month = Number(value('month'));
  const day = Number(value('day'));
  const rawHour = Number(value('hour'));
  const hour = rawHour % 24;
  return {
    dateKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    month,
    day,
    hour,
    minute: Number(value('minute')),
    second: Number(value('second')),
    millisecond: at.getUTCMilliseconds(),
    isoDayOfWeek: isoDayFromShortName(value('weekday'))
  };
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function validateBusinessPeriods(periods: readonly SupportBusinessPeriodInput[]): void {
  for (const period of periods) {
    if (!Number.isInteger(period.dayOfWeek) || period.dayOfWeek < 1 || period.dayOfWeek > 7) {
      throw new Error('Business period dayOfWeek must be an ISO day from 1 to 7');
    }
    if (!Number.isInteger(period.startMinute) || !Number.isInteger(period.endMinute) || period.startMinute < 0 || period.endMinute > 1440 || period.startMinute >= period.endMinute) {
      throw new Error('Business period minutes must be an increasing range inside one local day');
    }
  }
  for (let index = 1; index < periods.length; index += 1) {
    const previous = periods[index - 1];
    const current = periods[index];
    if (previous.dayOfWeek === current.dayOfWeek && previous.endMinute > current.startMinute) {
      throw new Error('Business periods cannot overlap');
    }
  }
}

function holidayDateKey(value: Date | string): string {
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
    if (!match) throw new Error(`Invalid holiday date: ${value}`);
    const [year, month, day] = match[1].split('-').map(Number);
    const roundTrip = new Date(Date.UTC(year, month - 1, day));
    if (
      roundTrip.getUTCFullYear() !== year ||
      roundTrip.getUTCMonth() + 1 !== month ||
      roundTrip.getUTCDate() !== day
    ) throw new Error(`Invalid holiday date: ${value}`);
    return match[1];
  }
  assertValidInstant(value, 'holiday date');
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function shiftLocalDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function isoDayForDateKey(dateKey: string): number {
  const day = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function isoDayFromShortName(name: string): number {
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);
  if (index < 0) throw new Error(`Unknown weekday from Intl: ${name}`);
  return index + 1;
}

function assertValidTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

function assertValidInstant(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid Date`);
}
