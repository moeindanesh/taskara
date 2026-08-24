import { describe, expect, test } from 'bun:test';
import { supportIntakeEventSchema } from './support-intake-contract';

const valid = {
  schemaVersion: 1 as const,
  externalCaseId: 'external-42',
  sourceSequence: '9',
  case: { title: 'درخواست مشتری', typeKey: 'incident' },
  interaction: { externalId: 'message-1', kind: 'MESSAGE' as const, body: 'متن پیام' }
};

describe('Support connector intake contract', () => {
  test('accepts the bounded source projection', () => {
    expect(supportIntakeEventSchema.parse(valid).case.priority).toBe('NORMAL');
  });

  test('rejects server-owned routing, lifecycle and requester-recording fields', () => {
    for (const extra of [
      { workspaceId: crypto.randomUUID() },
      { status: 'CLOSED' },
      { departmentId: crypto.randomUUID() },
      { assigneeMembershipId: crypto.randomUUID() },
      { resolutionCode: 'FIXED' },
      { nextSlaDueAt: new Date().toISOString() }
    ]) {
      expect(supportIntakeEventSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    expect(supportIntakeEventSchema.safeParse({
      ...valid,
      interaction: { externalId: 'call-1', kind: 'CALL' },
      call: {
        disposition: 'ANSWERED',
        startedAt: new Date().toISOString(),
        recordingExists: true,
        recordingUrl: 'https://permanent.example/secret'
      }
    }).success).toBe(false);
  });

  test('requires call metadata to belong to a CALL interaction', () => {
    expect(supportIntakeEventSchema.safeParse({
      ...valid,
      call: { disposition: 'MISSED', startedAt: new Date().toISOString() }
    }).success).toBe(false);
  });
});
