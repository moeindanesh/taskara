import { describe, expect, test } from 'bun:test';
import {
   normalizeSupportDeadLetter,
   normalizeSupportOperationalReport,
   normalizeSupportSlaPolicy,
   supportAttentionPath,
   supportCalendarPath,
   supportDeadLettersPath,
   supportReportsOverviewPath,
   supportSlaDeactivatePath,
} from './support-operations-client';

describe('Support operational client', () => {
   test('encodes action identifiers and report/dead-letter filters', () => {
      expect(supportCalendarPath('calendar/one')).toBe('/support/config/calendars/calendar%2Fone');
      expect(supportSlaDeactivatePath('policy/one')).toBe('/support/config/sla-policies/policy%2Fone/deactivate');
      expect(supportAttentionPath('SUP/42', 'snooze')).toBe('/support/cases/SUP%2F42/snooze');

      const deadLetters = new URL(supportDeadLettersPath({ cursor: 'opaque/cursor', connectorId: 'connector one', limit: 25 }), 'https://taskara.test');
      expect(deadLetters.pathname).toBe('/support/intake-admin/dead-letters');
      expect(deadLetters.searchParams.get('cursor')).toBe('opaque/cursor');
      expect(deadLetters.searchParams.get('connectorId')).toBe('connector one');
      expect(deadLetters.searchParams.get('limit')).toBe('25');

      const report = new URL(supportReportsOverviewPath({
         from: '2026-07-01T00:00:00.000Z',
         to: '2026-08-01T00:00:00.000Z',
         departmentId: 'department/one',
      }), 'https://taskara.test');
      expect(report.pathname).toBe('/support/reports/overview');
      expect(report.searchParams.get('departmentId')).toBe('department/one');
   });

   test('re-projects dead letters without payload, identity, secret, or raw error fields', () => {
      const normalized = normalizeSupportDeadLetter({
         receiptId: 'receipt-safe',
         connector: {
            id: 'connector-safe', name: 'CRM', sourceChannel: 'API', status: 'ACTIVE',
            secret: 'connector-secret', config: { token: 'hidden' },
         },
         case: { id: 'case-safe', key: 'SUP-9', title: 'must-not-cross' },
         status: 'DEAD_LETTER', attempts: 3,
         error: { code: 'INTAKE_PAYLOAD_INVALID', message: 'Intake payload is invalid', raw: 'stack-secret' },
         receivedAt: '2026-08-20T10:00:00.000Z', processedAt: null,
         deadLetteredAt: '2026-08-20T10:01:00.000Z', updatedAt: '2026-08-20T10:01:00.000Z',
         payload: 'customer-private-payload', eventKey: 'event-secret', idempotencyKey: 'idem-secret',
         payloadHash: 'hash-secret', payloadRef: 'ref-secret', payloadCiphertext: 'cipher-secret',
      });

      expect(normalized).toEqual({
         receiptId: 'receipt-safe',
         connector: { id: 'connector-safe', name: 'CRM', sourceChannel: 'API', status: 'ACTIVE' },
         case: { id: 'case-safe', key: 'SUP-9' },
         status: 'DEAD_LETTER', attempts: 3,
         error: { code: 'INTAKE_PAYLOAD_INVALID', message: 'Intake payload is invalid' },
         receivedAt: '2026-08-20T10:00:00.000Z', processedAt: null,
         deadLetteredAt: '2026-08-20T10:01:00.000Z', updatedAt: '2026-08-20T10:01:00.000Z',
      });
      const serialized = JSON.stringify(normalized);
      for (const secret of ['customer-private-payload', 'event-secret', 'idem-secret', 'hash-secret', 'ref-secret', 'cipher-secret', 'stack-secret', 'connector-secret']) {
         expect(serialized).not.toContain(secret);
      }
   });

   test('keeps SLA policy versions immutable and only projects supported metrics', () => {
      const policy = normalizeSupportSlaPolicy({
         id: 'policy-v2', policyKey: 'enterprise', name: 'سازمانی', version: 2, priority: 10, active: true,
         calendar: { id: 'calendar', name: 'تهران', timezone: 'Asia/Tehran', active: true, secret: 'hidden' },
         conditions: { priorities: ['URGENT', 'INVALID'], memberIds: ['peer-private'] },
         targets: { RESOLUTION: { businessSeconds: 14_400, atRiskSeconds: 10_800 }, UNKNOWN: { businessSeconds: 1 } },
         pauseRules: { waitingOnCustomer: ['RESOLUTION'], waitingOnInternal: [], snoozed: ['RESOLUTION'], automatedPublicResponseMeets: [] },
         effectiveFrom: '2026-08-23T10:00:00.000Z', effectiveUntil: null, createdAt: '2026-08-23T10:00:00.000Z',
      });
      expect(policy.version).toBe(2);
      expect(policy.conditions.priorities).toEqual(['URGENT']);
      expect(policy.targets).toEqual({ RESOLUTION: { businessSeconds: 14_400, atRiskSeconds: 10_800 } });
      expect(JSON.stringify(policy)).not.toContain('peer-private');
   });

   test('hard-disables per-member report projections even if an incompatible server includes them', () => {
      const report = normalizeSupportOperationalReport({
         generatedAt: '2026-08-23T10:00:00.000Z', timezone: 'Asia/Tehran',
         scope: { kind: 'WORKSPACE', departmentId: null },
         cohort: { from: '2026-07-23T10:00:00.000Z', to: '2026-08-23T10:00:00.000Z', definition: 'visible received cases' },
         summary: { received: 4, resolved: 2, closed: 1, reopened: 1, firstResponseRate: 0.5, firstResponseSeconds: { count: 2, p50: 120, p90: 400 }, resolutionSeconds: { count: 2, p50: 3600, p90: 7200 } },
         backlog: { open: 3, ageSeconds: { count: 3, p50: 4000, p90: 9000 } }, queues: { TRIAGE: 1 },
         breakdowns: { status: { OPEN: 3 }, priority: {}, sourceChannel: {}, type: {}, resolutionCode: {}, department: [] },
         sla: [], privacy: { perMemberBreakdownIncluded: true, note: 'same access predicate' },
         perMember: [{ name: 'همکار خصوصی', count: 99 }],
      });
      expect(report.privacy.perMemberBreakdownIncluded).toBeFalse();
      expect(JSON.stringify(report)).not.toContain('همکار خصوصی');
   });
});
