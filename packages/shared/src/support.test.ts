import { describe, expect, test } from 'bun:test';
import {
  createAuthWorkspaceSchema,
  createDepartmentWorkTargetSchema,
  createSupportCallSchema,
  createSupportIntakeConnectorSchema,
  resolveSupportCaseSchema,
  supportCallDetailInputSchema,
  supportCaseKeySchema,
  waitOnSupportCaseSchema,
  workspaceModeSchema
} from './index';

describe('workspace mode contracts', () => {
  test('existing creation payloads default to TEAM', () => {
    expect(createAuthWorkspaceSchema.parse({ name: 'Core', slug: 'core' }).mode).toBe('TEAM');
  });

  test('SUPPORT is an explicit accepted mode', () => {
    expect(workspaceModeSchema.parse('SUPPORT')).toBe('SUPPORT');
    expect(createAuthWorkspaceSchema.parse({ name: 'Support', slug: 'support', mode: 'SUPPORT' }).mode).toBe('SUPPORT');
  });
});

describe('Support intake connector contracts', () => {
  test('advertises only signature schemes the v1 secret-provisioning flow can use', () => {
    const base = {
      name: 'Signed API',
      sourceKey: 'signed-api',
      sourceChannel: 'API' as const
    };
    expect(createSupportIntakeConnectorSchema.safeParse(base).success).toBe(true);
    expect(createSupportIntakeConnectorSchema.safeParse({
      ...base,
      signatureScheme: 'ED25519'
    }).success).toBe(false);
  });
});

describe('Support Case command invariants', () => {
  test('Case keys are scoped prefix plus positive sequence', () => {
    expect(supportCaseKeySchema.safeParse('SUP-42').success).toBe(true);
    expect(supportCaseKeySchema.safeParse('sup-42').success).toBe(false);
    expect(supportCaseKeySchema.safeParse('SUP-0').success).toBe(false);
  });

  test('duplicate resolution requires exactly one canonical Case', () => {
    const base = { resolutionSummary: 'Same source problem', baseVersion: 2 };
    expect(resolveSupportCaseSchema.safeParse({ ...base, resolutionCode: 'DUPLICATE' }).success).toBe(false);
    expect(resolveSupportCaseSchema.safeParse({
      ...base,
      resolutionCode: 'DUPLICATE',
      duplicateOfCaseId: '3db16090-7b83-47f8-9197-d82c64615837'
    }).success).toBe(true);
    expect(resolveSupportCaseSchema.safeParse({
      ...base,
      resolutionCode: 'FIXED',
      duplicateOfCaseId: '3db16090-7b83-47f8-9197-d82c64615837'
    }).success).toBe(false);
  });

  test('internal waiting requires a reason and both waiting variants require a next action', () => {
    expect(waitOnSupportCaseSchema.safeParse({
      status: 'WAITING_ON_INTERNAL',
      nextActionAt: '2026-08-24T12:00:00.000Z',
      baseVersion: 1
    }).success).toBe(false);
    expect(waitOnSupportCaseSchema.safeParse({
      status: 'WAITING_ON_CUSTOMER',
      nextActionAt: '2026-08-24T12:00:00.000Z',
      baseVersion: 1
    }).success).toBe(true);
  });

  test('callback owner and deadline are one fact', () => {
    const base = {
      direction: 'INBOUND' as const,
      disposition: 'MISSED' as const,
      startedAt: '2026-08-23T12:00:00.000Z'
    };
    expect(supportCallDetailInputSchema.safeParse({
      ...base,
      callbackOwnerId: '3db16090-7b83-47f8-9197-d82c64615837'
    }).success).toBe(false);
    expect(supportCallDetailInputSchema.safeParse({
      ...base,
      callbackOwnerId: '3db16090-7b83-47f8-9197-d82c64615837',
      callbackDueAt: '2026-08-24T12:00:00.000Z'
    }).success).toBe(true);
  });

  test('manual calls require an external direction and the correct concurrency identity', () => {
    const call = {
      direction: 'OUTBOUND' as const,
      disposition: 'ANSWERED' as const,
      startedAt: '2026-08-23T12:00:00.000Z'
    };
    const existing = {
      caseId: '3db16090-7b83-47f8-9197-d82c64615837',
      summary: 'Follow-up call',
      call
    };
    expect(createSupportCallSchema.safeParse(existing).success).toBe(false);
    expect(createSupportCallSchema.safeParse({ ...existing, baseVersion: 3 }).success).toBe(true);
    expect(createSupportCallSchema.safeParse({
      newCase: {
        title: 'New caller',
        sourceChannel: 'CALL',
        typeKey: 'incident'
      },
      summary: 'Inbound call',
      call: { ...call, direction: 'INBOUND' }
    }).success).toBe(false);
    expect(createSupportCallSchema.safeParse({
      newCase: {
        title: 'New caller',
        sourceChannel: 'CALL',
        typeKey: 'incident',
        idempotencyKey: 'call-create-1'
      },
      summary: 'Inbound call',
      call: { ...call, direction: 'INTERNAL' }
    }).success).toBe(false);
  });

  test('a Department target cannot authorize nothing', () => {
    const target = {
      connectionId: '3db16090-7b83-47f8-9197-d82c64615837',
      departmentId: '839cf4f2-c2d9-4472-837d-eeb101309912',
      projectId: '08e5e4dc-7fd2-4e83-930d-c146c564678e'
    };
    expect(createDepartmentWorkTargetSchema.safeParse(target).success).toBe(true);
    expect(createDepartmentWorkTargetSchema.safeParse({
      ...target,
      allowCreateTasks: false,
      allowLinkTasks: false
    }).success).toBe(false);
  });
});
