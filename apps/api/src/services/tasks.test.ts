import { describe, expect, test } from 'bun:test';
import { hasTaskFieldConflict, shouldCancelActiveTaskReviewsForStatusChange } from './tasks';

describe('task conflict detection', () => {
  test('allows stale disjoint field updates', () => {
    expect(
      hasTaskFieldConflict(['priority'], [
        { operation: 'updated', payload: { changedFields: ['status'] } },
        { operation: 'updated', payload: { changedFields: ['assigneeId'] } }
      ])
    ).toBe(false);
  });

  test('rejects stale same-field updates', () => {
    expect(
      hasTaskFieldConflict(['status'], [
        { operation: 'updated', payload: { changedFields: ['status'] } }
      ])
    ).toBe(true);
  });

  test('treats remote deletes as conflicts', () => {
    expect(
      hasTaskFieldConflict(['title'], [
        { operation: 'deleted', payload: { changedFields: ['deleted'] } }
      ])
    ).toBe(true);
  });
});

describe('task review cleanup policy', () => {
  test('keeps active reviews when status is unchanged or still in review', () => {
    expect(shouldCancelActiveTaskReviewsForStatusChange()).toBe(false);
    expect(shouldCancelActiveTaskReviewsForStatusChange('IN_REVIEW')).toBe(false);
  });

  test('cancels active reviews when ordinary task status moves out of review', () => {
    expect(shouldCancelActiveTaskReviewsForStatusChange('IN_PROGRESS')).toBe(true);
    expect(shouldCancelActiveTaskReviewsForStatusChange('DONE')).toBe(true);
    expect(shouldCancelActiveTaskReviewsForStatusChange('CANCELED')).toBe(true);
  });
});
