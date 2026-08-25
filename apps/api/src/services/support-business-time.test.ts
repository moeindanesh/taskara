import { describe, expect, test } from 'bun:test';
import {
  addSupportBusinessSeconds,
  isSupportBusinessInstant,
  localSupportDateKey,
  nextSupportBusinessInstant,
  snapshotSupportBusinessCalendar,
  supportBusinessSecondsBetween
} from './support-business-time';

const weekdayCalendar = {
  timezone: 'America/New_York',
  periods: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60 }))
};

describe('Support business-time arithmetic', () => {
  test('crosses a DST weekend in wall-clock business hours, not fixed 24-hour days', () => {
    // Friday 16:00 EST + two business hours = Monday 10:00 EDT. The UTC offset changed meanwhile.
    const startedAt = new Date('2026-03-06T21:00:00.000Z');
    const dueAt = addSupportBusinessSeconds(weekdayCalendar, startedAt, 2 * 60 * 60);
    expect(dueAt.toISOString()).toBe('2026-03-09T14:00:00.000Z');
    expect(supportBusinessSecondsBetween(weekdayCalendar, startedAt, dueAt)).toBe(2 * 60 * 60);
  });

  test('counts the actual two-hour spring-forward interval inside a 01:00–04:00 local period', () => {
    const springForward = {
      timezone: 'America/New_York',
      periods: [{ dayOfWeek: 7, startMinute: 60, endMinute: 240 }]
    };
    const startedAt = new Date('2026-03-08T06:00:00.000Z'); // 01:00 EST
    const dueAt = addSupportBusinessSeconds(springForward, startedAt, 2 * 60 * 60);
    expect(dueAt.toISOString()).toBe('2026-03-08T08:00:00.000Z'); // 04:00 EDT
    expect(supportBusinessSecondsBetween(springForward, startedAt, dueAt)).toBe(2 * 60 * 60);
  });

  test('counts both occurrences of the repeated hour during fall-back', () => {
    const fallBack = {
      timezone: 'America/New_York',
      periods: [{ dayOfWeek: 7, startMinute: 60, endMinute: 180 }]
    };
    const startedAt = new Date('2026-11-01T05:00:00.000Z'); // First 01:00, still EDT.
    const dueAt = addSupportBusinessSeconds(fallBack, startedAt, 3 * 60 * 60);
    expect(dueAt.toISOString()).toBe('2026-11-01T08:00:00.000Z'); // 03:00 EST.
    expect(supportBusinessSecondsBetween(fallBack, startedAt, dueAt)).toBe(3 * 60 * 60);
  });

  test('skips holidays without shifting their UTC date into the calendar timezone', () => {
    const calendar = {
      ...weekdayCalendar,
      holidays: [{ date: '2026-07-03', working: false }]
    };
    const startedAt = new Date('2026-07-02T20:00:00.000Z'); // Thursday 16:00 EDT
    expect(addSupportBusinessSeconds(calendar, startedAt, 2 * 60 * 60).toISOString())
      .toBe('2026-07-06T14:00:00.000Z'); // Monday 10:00 EDT
  });

  test('moves a non-business instant to the next opening and recognizes half-open periods', () => {
    expect(nextSupportBusinessInstant(weekdayCalendar, new Date('2026-07-04T16:00:00.000Z')).toISOString())
      .toBe('2026-07-06T13:00:00.000Z');
    expect(isSupportBusinessInstant(weekdayCalendar, new Date('2026-07-06T13:00:00.000Z'))).toBe(true);
    expect(isSupportBusinessInstant(weekdayCalendar, new Date('2026-07-06T21:00:00.000Z'))).toBe(false);
  });

  test('adding zero business seconds preserves the exact instant outside business hours', () => {
    const afterClose = new Date('2026-07-06T22:00:00.000Z');
    expect(addSupportBusinessSeconds(weekdayCalendar, afterClose, 0).toISOString())
      .toBe(afterClose.toISOString());
  });

  test('uses the calendar timezone for Persian/Jalali display-day boundaries', () => {
    // The server keeps UTC instants; 20:30Z is already the next civil day in Tehran.
    expect(localSupportDateKey(new Date('2026-03-20T20:29:59.999Z'), 'Asia/Tehran')).toBe('2026-03-20');
    expect(localSupportDateKey(new Date('2026-03-20T20:30:00.000Z'), 'Asia/Tehran')).toBe('2026-03-21');
  });

  test('refuses invalid timezone, periods, or holidays instead of making an approximate SLA', () => {
    expect(() => snapshotSupportBusinessCalendar({ timezone: 'Mars/Olympus', periods: weekdayCalendar.periods })).toThrow('Invalid IANA timezone');
    expect(() => snapshotSupportBusinessCalendar({
      timezone: 'UTC',
      periods: [
        { dayOfWeek: 1, startMinute: 540, endMinute: 720 },
        { dayOfWeek: 1, startMinute: 660, endMinute: 780 }
      ]
    })).toThrow('cannot overlap');
    expect(() => snapshotSupportBusinessCalendar({
      timezone: 'UTC',
      periods: weekdayCalendar.periods,
      holidays: [{ date: '2026-02-31', working: false }]
    })).toThrow('Invalid holiday date');
    expect(() => snapshotSupportBusinessCalendar({
      timezone: 'UTC',
      periods: weekdayCalendar.periods,
      holidays: [
        { date: '2026-03-21', working: false },
        { date: '2026-03-21', working: true }
      ]
    })).toThrow('cannot contain duplicate dates');
  });
});
