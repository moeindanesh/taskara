import { describe, expect, test } from 'bun:test';
import { dateKeyRange, isValidDateKey, shiftDateKey, workspaceClockParts, workspaceDateKey } from './workspace-time';

describe('workspace clock', () => {
  test('resolves the calendar day in the workspace timezone, not UTC', () => {
    // 20:45 UTC is already the next day in Tehran (+03:30).
    expect(workspaceDateKey(new Date('2026-07-28T20:45:00.000Z'))).toBe('2026-07-29');
    // 20:15 UTC is still the same Tehran day.
    expect(workspaceDateKey(new Date('2026-07-28T20:15:00.000Z'))).toBe('2026-07-28');
  });

  test('places reports written either side of Tehran midnight on the days a human expects', () => {
    const beforeMidnight = new Date('2026-07-28T20:28:00.000Z'); // 23:58 Tehran
    const afterMidnight = new Date('2026-07-28T20:33:00.000Z'); // 00:03 Tehran

    expect(workspaceDateKey(beforeMidnight)).toBe('2026-07-28');
    expect(workspaceDateKey(afterMidnight)).toBe('2026-07-29');
  });

  test('reports the workspace-local hour used by the reminder window', () => {
    // 14:00 UTC is 17:30 Tehran — the daily report reminder slot.
    const parts = workspaceClockParts(new Date('2026-07-28T14:00:00.000Z'));
    expect(parts.hour).toBe(17);
    expect(parts.minute).toBe(30);
    expect(parts.dateKey).toBe('2026-07-28');
  });

  test('reports hour 0 rather than 24 at midnight', () => {
    const parts = workspaceClockParts(new Date('2026-07-28T20:33:00.000Z'));
    expect(parts.hour).toBe(0);
  });

  test('shifts day keys across month and year boundaries', () => {
    expect(shiftDateKey('2026-07-29', -1)).toBe('2026-07-28');
    expect(shiftDateKey('2026-08-01', -1)).toBe('2026-07-31');
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('builds an instant range covering exactly one workspace day', () => {
    const { start, end } = dateKeyRange('2026-07-29');

    expect(start.toISOString()).toBe('2026-07-28T20:30:00.000Z');
    expect(end.toISOString()).toBe('2026-07-29T20:30:00.000Z');
    expect(workspaceDateKey(start)).toBe('2026-07-29');
    expect(workspaceDateKey(new Date(end.getTime() - 1))).toBe('2026-07-29');
    expect(workspaceDateKey(end)).toBe('2026-07-30');
  });

  test('validates day-key shape', () => {
    expect(isValidDateKey('2026-07-29')).toBe(true);
    expect(isValidDateKey('2026-7-9')).toBe(false);
    expect(isValidDateKey('yesterday')).toBe(false);
  });
});
