import { describe, expect, test } from 'bun:test';
import { deriveSupportRecoveryCandidates, primarySupportAttentionReason } from './support-recovery';

const now = new Date('2026-08-23T12:00:00.000Z');

function supportCase() {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    workspaceId: '10000000-0000-4000-8000-000000000001',
    key: 'SUP-1',
    title: 'Checkout failed',
    status: 'OPEN' as const,
    priority: 'HIGH' as const,
    departmentId: '50000000-0000-4000-8000-000000000001',
    assigneeMembershipId: '60000000-0000-4000-8000-000000000001',
    assigneeUserId: '70000000-0000-4000-8000-000000000001',
    receivedAt: new Date('2026-08-20T12:00:00.000Z'),
    lastMeaningfulActivityAt: new Date('2026-08-20T12:00:00.000Z'),
    nextActionAt: null,
    reopenedAt: null,
    resolvedAt: null,
    resolutionCode: null,
    statusSince: new Date('2026-08-20T12:00:00.000Z')
  };
}

describe('Support recovery projection', () => {
  test('flags an untriaged Case after policy without mislabeling it as stale ownership', () => {
    const candidates = deriveSupportRecoveryCandidates({
      supportCase: {
        ...supportCase(),
        status: 'NEW',
        departmentId: null,
        assigneeMembershipId: null,
        assigneeUserId: null,
        receivedAt: new Date('2026-08-23T07:59:59.000Z'),
        lastMeaningfulActivityAt: new Date('2026-08-01T00:00:00.000Z')
      },
      now,
      thresholds: { triageUnassignedSeconds: 4 * 60 * 60 }
    });
    expect(candidates.map((candidate) => candidate.reason)).toContain('UNTRIAGED_TOO_LONG');
    expect(candidates.map((candidate) => candidate.reason)).not.toContain('STALE_OWNERSHIP');
  });

  test('reasons overlap and the most urgent reason wins without hiding the rest', () => {
    const candidates = deriveSupportRecoveryCandidates({
      supportCase: supportCase(),
      clocks: [{
        id: '80000000-0000-4000-8000-000000000001',
        metric: 'FIRST_RESPONSE',
        cycle: 1,
        state: 'RUNNING',
        dueAt: new Date('2026-08-23T11:00:00.000Z'),
        breachedAt: null,
        metAt: null,
        canceledAt: null
      }],
      now
    });
    expect(candidates.map((candidate) => candidate.reason)).toContain('NO_NEXT_ACTION');
    expect(candidates.map((candidate) => candidate.reason)).toContain('STALE_OWNERSHIP');
    expect(candidates.map((candidate) => candidate.reason)).toContain('SLA_BREACHED');
    expect(primarySupportAttentionReason(candidates)).toBe('SLA_BREACHED');
  });

  test('SLA alert identity includes the metric cycle so a reopened cycle can alert again', () => {
    const candidates = deriveSupportRecoveryCandidates({
      supportCase: supportCase(),
      clocks: [1, 2].map((cycle) => ({
        id: `80000000-0000-4000-8000-00000000000${cycle}`,
        metric: 'NEXT_RESPONSE' as const,
        cycle,
        state: 'BREACHED' as const,
        dueAt: new Date(`2026-08-${20 + cycle}T12:00:00.000Z`),
        breachedAt: new Date(`2026-08-${20 + cycle}T12:00:00.000Z`),
        metAt: null,
        canceledAt: null
      })),
      now
    }).filter((candidate) => candidate.reason === 'SLA_BREACHED');
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.entityId)).size).toBe(2);
    expect(new Set(candidates.map((candidate) => candidate.conditionKey)).size).toBe(2);
  });

  test('a late-met breached clock remains a reporting breach but leaves recovery', () => {
    const candidates = deriveSupportRecoveryCandidates({
      supportCase: { ...supportCase(), lastMeaningfulActivityAt: now, nextActionAt: new Date('2026-08-24') },
      clocks: [{
        id: '80000000-0000-4000-8000-000000000001',
        metric: 'FIRST_RESPONSE',
        cycle: 1,
        state: 'BREACHED',
        dueAt: new Date('2026-08-22'),
        breachedAt: new Date('2026-08-22'),
        metAt: new Date('2026-08-23T11:30:00.000Z'),
        canceledAt: null
      }],
      now
    });
    expect(candidates.some((candidate) => candidate.reason === 'SLA_BREACHED')).toBe(false);
  });

  test('uses the frozen policy cycle risk window before the workspace fallback', () => {
    const candidates = deriveSupportRecoveryCandidates({
      supportCase: { ...supportCase(), lastMeaningfulActivityAt: now, nextActionAt: new Date('2026-08-24') },
      clocks: [{
        id: '80000000-0000-4000-8000-000000000001',
        metric: 'FIRST_RESPONSE',
        cycle: 1,
        state: 'RUNNING',
        dueAt: new Date('2026-08-23T13:30:00.000Z'),
        breachedAt: null,
        metAt: null,
        canceledAt: null,
        atRiskSeconds: 2 * 60 * 60
      }],
      now,
      thresholds: { slaAtRiskSeconds: 60 * 60 }
    });
    expect(candidates.some((candidate) => candidate.reason === 'SLA_AT_RISK')).toBe(true);
  });

  test('calculates at-risk windows in frozen business time across a weekend', () => {
    const friday = new Date('2026-08-21T16:00:00.000Z');
    const candidates = deriveSupportRecoveryCandidates({
      supportCase: { ...supportCase(), lastMeaningfulActivityAt: friday, nextActionAt: new Date('2026-08-25') },
      clocks: [{
        id: '80000000-0000-4000-8000-000000000009',
        metric: 'FIRST_RESPONSE',
        cycle: 1,
        state: 'RUNNING',
        dueAt: new Date('2026-08-24T10:00:00.000Z'),
        breachedAt: null,
        metAt: null,
        canceledAt: null,
        atRiskSeconds: 2 * 60 * 60,
        frozenCalendar: {
          timezone: 'UTC',
          periods: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60 })),
          holidays: []
        }
      }],
      now: friday
    });
    expect(candidates.some((candidate) => candidate.reason === 'SLA_AT_RISK')).toBe(true);
  });

  test('closed Cases never appear in Needs Attention', () => {
    expect(deriveSupportRecoveryCandidates({
      supportCase: { ...supportCase(), status: 'CLOSED' },
      now
    })).toEqual([]);
  });
});
