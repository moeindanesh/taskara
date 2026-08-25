import { describe, expect, test } from 'bun:test';
import type { SupportSlaMetric } from '@taskara/db';
import {
  applySupportSlaEvent,
  buildSupportSlaClock,
  meetSupportSlaClock,
  nextSupportSlaCycle,
  parseSupportSlaPolicy,
  selectSupportSlaPolicy,
  supportInteractionMeetsResponseClock,
  supportSlaMetricsForEvent,
  type SupportSlaClockSnapshot,
  type SupportSlaPolicyDefinition
} from './support-sla';

const calendar = {
  timezone: 'UTC',
  periods: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60 }))
};

function policy(version = 1, priority = 100): SupportSlaPolicyDefinition {
  return {
    id: `00000000-0000-4000-8000-00000000000${version}`,
    workspaceId: '10000000-0000-4000-8000-000000000001',
    calendarId: '20000000-0000-4000-8000-000000000001',
    policyKey: 'default',
    version,
    priority,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveUntil: null,
    conditions: {},
    targets: {
      FIRST_RESPONSE: { businessSeconds: 4 * 60 * 60 },
      NEXT_RESPONSE: { businessSeconds: 2 * 60 * 60 },
      RESOLUTION: { businessSeconds: 8 * 60 * 60 }
    },
    pauseRules: {
      waitingOnCustomer: ['RESOLUTION'],
      waitingOnInternal: [],
      snoozed: [],
      automatedPublicResponseMeets: []
    }
  };
}

function clock(metric: SupportSlaMetric = 'RESOLUTION'): SupportSlaClockSnapshot {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    ...buildSupportSlaClock({
      workspaceId: policy().workspaceId,
      caseId: '40000000-0000-4000-8000-000000000001',
      policy: policy(),
      calendar,
      metric,
      cycle: 1,
      startedAt: new Date('2026-07-06T09:00:00.000Z')
    })
  };
}

describe('Support SLA policy selection and freezing', () => {
  test('chooses lowest ordered priority, then the latest applicable version', () => {
    const supportCase = {
      id: '40000000-0000-4000-8000-000000000001',
      workspaceId: policy().workspaceId,
      typeKey: 'incident',
      priority: 'HIGH' as const,
      sourceChannel: 'API' as const,
      departmentId: null,
      impact: null,
      urgency: null
    };
    expect(selectSupportSlaPolicy([policy(1), policy(2)], supportCase, new Date('2026-07-01'))?.version).toBe(2);
    expect(selectSupportSlaPolicy([policy(1, 10), policy(2, 100)], supportCase, new Date('2026-07-01'))?.version).toBe(1);
  });

  test('freezes target and pause rules on a clock instead of retaining mutable policy objects', () => {
    const selected = policy();
    const built = buildSupportSlaClock({
      workspaceId: selected.workspaceId,
      caseId: '40000000-0000-4000-8000-000000000001',
      policy: selected,
      calendar,
      metric: 'RESOLUTION',
      cycle: 1,
      startedAt: new Date('2026-07-06T09:00:00.000Z')
    });
    selected.targets.RESOLUTION!.businessSeconds = 60;
    selected.pauseRules.waitingOnCustomer.length = 0;
    calendar.periods[0].startMinute = 0;
    expect(built.targetBusinessSeconds).toBe(8 * 60 * 60);
    expect(built.pauseRules.waitingOnCustomer).toEqual(['RESOLUTION']);
    expect(built.calendar.periods[0].startMinute).toBe(9 * 60);
    calendar.periods[0].startMinute = 9 * 60;
  });

  test('strictly rejects malformed policy JSON read from the database', () => {
    expect(() => parseSupportSlaPolicy({
      ...policy(),
      conditions: {},
      targets: { RESOLUTION: { businessSeconds: -1 } },
      pauseRules: {}
    } as never)).toThrow();
  });
});

describe('Support SLA clock lifecycle', () => {
  test('waiting on the customer pauses only opted-in clocks and resume extends by business time', () => {
    const original = clock('RESOLUTION');
    const paused = applySupportSlaEvent(original, 'WAITING_ON_CUSTOMER', new Date('2026-07-06T10:00:00.000Z'));
    const resumed = applySupportSlaEvent(paused, 'RESUMED', new Date('2026-07-06T12:00:00.000Z'));
    expect(paused.state).toBe('PAUSED');
    expect(resumed.state).toBe('RUNNING');
    expect(resumed.accumulatedPausedSeconds).toBe(2n * 60n * 60n);
    // Original deadline 17:00; two paused business hours carry to Tuesday 11:00.
    expect(resumed.dueAt.toISOString()).toBe('2026-07-07T11:00:00.000Z');
  });

  test('resume uses the frozen calendar even after the source calendar is edited', () => {
    const mutableCalendar = {
      timezone: 'UTC',
      periods: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60 }))
    };
    const original = {
      id: '30000000-0000-4000-8000-000000000002',
      ...buildSupportSlaClock({
        workspaceId: policy().workspaceId,
        caseId: '40000000-0000-4000-8000-000000000001',
        policy: policy(),
        calendar: mutableCalendar,
        metric: 'RESOLUTION',
        cycle: 1,
        startedAt: new Date('2026-07-06T09:00:00.000Z')
      })
    };
    const paused = applySupportSlaEvent(original, 'WAITING_ON_CUSTOMER', new Date('2026-07-06T10:00:00.000Z'));
    mutableCalendar.timezone = 'America/New_York';
    mutableCalendar.periods.forEach((period) => { period.startMinute = 0; period.endMinute = 60; });
    const resumed = applySupportSlaEvent(paused, 'RESUMED', new Date('2026-07-06T12:00:00.000Z'));
    expect(resumed.calendar.timezone).toBe('UTC');
    expect(resumed.dueAt.toISOString()).toBe('2026-07-07T11:00:00.000Z');
  });

  test('a pause containing zero business time does not move the deadline', () => {
    const original = {
      ...clock('RESOLUTION'),
      dueAt: new Date('2026-07-08T17:00:00.000Z')
    };
    const paused = applySupportSlaEvent(original, 'WAITING_ON_CUSTOMER', new Date('2026-07-06T18:00:00.000Z'));
    const resumed = applySupportSlaEvent(paused, 'RESUMED', new Date('2026-07-07T08:00:00.000Z'));
    expect(resumed.accumulatedPausedSeconds).toBe(0n);
    expect(resumed.dueAt.toISOString()).toBe(original.dueAt.toISOString());
  });

  test('transfer preserves the exact Case-level clock', () => {
    const original = clock('RESOLUTION');
    const transferred = applySupportSlaEvent(original, 'TRANSFERRED', new Date('2026-07-06T12:00:00.000Z'));
    expect(transferred).toEqual(original);
    expect(transferred).not.toBe(original);
  });

  test('only public outbound human work fulfills response clocks by default', () => {
    const rules = policy().pauseRules;
    expect(supportInteractionMeetsResponseClock({ visibility: 'PUBLIC', direction: 'OUTBOUND', humanAuthored: true, automated: false }, 'FIRST_RESPONSE', rules)).toBe(true);
    expect(supportInteractionMeetsResponseClock({ visibility: 'INTERNAL', direction: 'OUTBOUND', humanAuthored: true, automated: false }, 'FIRST_RESPONSE', rules)).toBe(false);
    expect(supportInteractionMeetsResponseClock({ visibility: 'PUBLIC', direction: 'OUTBOUND', humanAuthored: false, automated: true }, 'FIRST_RESPONSE', rules)).toBe(false);
    expect(supportInteractionMeetsResponseClock({ visibility: 'PUBLIC', direction: 'INBOUND', humanAuthored: true, automated: false }, 'NEXT_RESPONSE', rules)).toBe(false);
    expect(supportInteractionMeetsResponseClock(
      { visibility: 'PUBLIC', direction: 'OUTBOUND', humanAuthored: false, automated: true },
      'FIRST_RESPONSE',
      { ...rules, automatedPublicResponseMeets: ['FIRST_RESPONSE'] }
    )).toBe(false);
  });

  test('transfer closes only the Department-local member-assignment cycle', () => {
    const memberAssignment = {
      ...clock('RESOLUTION'),
      metric: 'MEMBER_ASSIGNMENT' as const
    };
    const transferred = applySupportSlaEvent(memberAssignment, 'TRANSFERRED', new Date('2026-07-06T12:00:00.000Z'));
    expect(transferred.state).toBe('CANCELED');
    expect(transferred.canceledAt?.toISOString()).toBe('2026-07-06T12:00:00.000Z');
  });

  test('a response after breach records late fulfillment without erasing the breach', () => {
    const breached = { ...clock('FIRST_RESPONSE'), state: 'BREACHED' as const, breachedAt: new Date('2026-07-06T14:00:00.000Z') };
    const met = meetSupportSlaClock(breached, new Date('2026-07-06T15:00:00.000Z'));
    expect(met.state).toBe('BREACHED');
    expect(met.metAt?.toISOString()).toBe('2026-07-06T15:00:00.000Z');
  });

  test('a late response cannot meet a running clock just because the evaluator has not run yet', () => {
    const running = clock('FIRST_RESPONSE');
    const met = meetSupportSlaClock(running, new Date(running.dueAt.getTime() + 1));
    expect(met.state).toBe('BREACHED');
    expect(met.breachedAt?.toISOString()).toBe(running.dueAt.toISOString());
    expect(met.metAt?.getTime()).toBe(running.dueAt.getTime() + 1);
  });

  test('an action exactly at the deadline is on time', () => {
    const running = clock('FIRST_RESPONSE');
    expect(meetSupportSlaClock(running, running.dueAt).state).toBe('MET');
  });

  test('customer activity and reopen create new cycles; they never reset old ones', () => {
    const outstanding = clock('NEXT_RESPONSE');
    const frozen = applySupportSlaEvent(outstanding, 'CUSTOMER_ACTIVITY', new Date('2026-07-06T10:00:00.000Z'));
    expect(frozen.state).toBe('CANCELED');
    expect(supportSlaMetricsForEvent('CASE_CREATED')).toEqual(['TRIAGE', 'FIRST_RESPONSE', 'RESOLUTION']);
    expect(supportSlaMetricsForEvent('CUSTOMER_ACTIVITY')).toEqual(['NEXT_RESPONSE']);
    expect(supportSlaMetricsForEvent('REOPENED')).toEqual(['NEXT_RESPONSE', 'RESOLUTION']);
    expect(supportSlaMetricsForEvent('ASSIGNED')).toEqual([]);
    expect(supportSlaMetricsForEvent('UNASSIGNED')).toEqual(['MEMBER_ASSIGNMENT']);
    expect(nextSupportSlaCycle([{ metric: 'NEXT_RESPONSE', cycle: 1 }, { metric: 'NEXT_RESPONSE', cycle: 2 }], 'NEXT_RESPONSE')).toBe(3);
  });
});
