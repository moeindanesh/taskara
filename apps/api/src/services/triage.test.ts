import { describe, expect, test } from 'bun:test';
import { triageAcceptSchema, triageSnoozeSchema, triageSplitSchema } from '@taskara/shared';
import { canTriageTaskStatus } from './triage';

describe('triage rules', () => {
  test('only backlog tasks can enter triage actions', () => {
    expect(canTriageTaskStatus('BACKLOG')).toBe(true);
    expect(canTriageTaskStatus('TODO')).toBe(false);
    expect(canTriageTaskStatus('IN_PROGRESS')).toBe(false);
    expect(canTriageTaskStatus('DONE')).toBe(false);
  });

  test('accepting unassigned backlog work requires a reason', () => {
    expect(() => triageAcceptSchema.parse({ priority: 'MEDIUM' })).toThrow();
    expect(triageAcceptSchema.parse({ priority: 'MEDIUM', unassignedReason: 'Waiting for planning owner' })).toMatchObject({
      priority: 'MEDIUM',
      unassignedReason: 'Waiting for planning owner'
    });
  });

  test('snoozing backlog work requires a timestamp and reason', () => {
    expect(() => triageSnoozeSchema.parse({ snoozedUntil: '2026-07-07T09:00:00.000Z' })).toThrow();
    expect(triageSnoozeSchema.parse({ snoozedUntil: '2026-07-07T09:00:00.000Z', reason: 'Waiting for customer answer' })).toMatchObject({
      snoozedUntil: '2026-07-07T09:00:00.000Z',
      reason: 'Waiting for customer answer'
    });
  });

  test('splitting backlog work requires at least two child items', () => {
    expect(() => triageSplitSchema.parse({ items: [{ title: 'Only one item' }] })).toThrow();
    expect(triageSplitSchema.parse({
      items: [
        { title: 'Clarify scope' },
        { title: 'Implement narrow follow-up', description: 'Second piece' }
      ],
      reason: 'Too broad'
    })).toMatchObject({
      items: [
        { title: 'Clarify scope' },
        { title: 'Implement narrow follow-up', description: 'Second piece' }
      ],
      reason: 'Too broad'
    });
  });
});
