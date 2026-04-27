import { describe, expect, test } from 'bun:test';
import { hasTaskFieldConflict } from './tasks';

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
