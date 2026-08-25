import { describe, expect, test } from 'bun:test';
import {
  serializeSupportLinkProjection,
  type SupportCaseTaskLinkProjectionRecord
} from './support-link-projections';

describe('Support Case–Task projection freeze', () => {
  test('hides Task deletion learned after unlink/revocation but preserves an earlier tombstone', () => {
    const freezeAt = new Date('2026-08-23T10:00:00.000Z');
    const afterFreeze = projectionRecord({
      unlinkedAt: freezeAt,
      connectionRevokedAt: new Date('2026-08-23T11:00:00.000Z'),
      taskDeletedAt: new Date('2026-08-23T12:00:00.000Z')
    });
    expect(serializeSupportLinkProjection(afterFreeze).tombstone.taskDeletedAt).toBeNull();

    const beforeFreeze = projectionRecord({
      unlinkedAt: freezeAt,
      taskDeletedAt: new Date('2026-08-23T09:00:00.000Z')
    });
    expect(serializeSupportLinkProjection(beforeFreeze).tombstone.taskDeletedAt)
      .toBe('2026-08-23T09:00:00.000Z');
  });
});

function projectionRecord(
  overrides: Partial<SupportCaseTaskLinkProjectionRecord>
): SupportCaseTaskLinkProjectionRecord {
  const createdAt = new Date('2026-08-23T08:00:00.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    version: 1,
    idempotencyKey: 'projection-test',
    idempotencyHash: 'hash',
    connectionId: '00000000-0000-4000-8000-000000000002',
    workTargetId: '00000000-0000-4000-8000-000000000003',
    supportWorkspaceId: '00000000-0000-4000-8000-000000000004',
    teamWorkspaceId: '00000000-0000-4000-8000-000000000005',
    caseId: '00000000-0000-4000-8000-000000000006',
    taskId: '00000000-0000-4000-8000-000000000007',
    taskWorkspaceId: '00000000-0000-4000-8000-000000000005',
    relationType: 'FIX_WORK',
    handoffTitle: 'Approved handoff',
    handoffSummary: 'Approved summary',
    teamWorkspaceNameSnapshot: 'Delivery',
    taskKeySnapshot: 'CORE-1',
    taskTitleSnapshot: 'Approved handoff',
    taskStatusSnapshot: 'TODO',
    supportWorkspaceNameSnapshot: 'Support',
    caseKeySnapshot: 'SUP-1',
    caseTitleSnapshot: 'Approved handoff',
    caseStatusSnapshot: 'OPEN',
    lastTaskSignalAt: createdAt,
    lastCaseSignalAt: createdAt,
    connectionRevokedAt: null,
    taskDeletedAt: null,
    unlinkedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}
