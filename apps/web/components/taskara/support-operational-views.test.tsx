import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportIntakeDeadLetterDetails } from './support-intake-admin-view';
import { SupportSlaPolicySection } from './support-operations-view';
import { SupportReportOverview } from './support-reports-view';
import type { SupportIntakeDeadLetter, SupportOperationalReport, SupportSlaPolicy } from '@/lib/support-operations-types';

describe('Support operational views', () => {
   test('explains report cohort and privacy without a per-member surface', () => {
      const html = renderToStaticMarkup(<SupportReportOverview report={report()} />);
      expect(html).toContain('تعریف هم‌گروه');
      expect(html).toContain('پایان بازه، غیرشامل');
      expect(html).toContain('هیچ رتبه‌بندی، عملکرد فردی یا مقایسه همکاران ندارد');
      expect(html).not.toContain('همکار خصوصی');
   });

   test('renders only the sanitized dead-letter projection and its safe retry context', () => {
      const html = renderToStaticMarkup(<SupportIntakeDeadLetterDetails item={deadLetter()} />);
      expect(html).toContain('خطای قرارداد ورودی');
      expect(html).toContain('جزئیات حساس ورودی و اتصال عمداً در این نما موجود نیست');
      for (const forbidden of ['payload', 'idempotency', 'ciphertext', 'connector-secret', 'raw-error-stack']) {
         expect(html).not.toContain(forbidden);
      }
   });

   test('offers a new SLA version and deactivation, never in-place policy editing', () => {
      const html = renderToStaticMarkup(
         <SupportSlaPolicySection
            policies={[policy()]}
            onCreate={() => undefined}
            onNewVersion={() => undefined}
            onDeactivate={() => undefined}
         />
      );
      expect(html).toContain('نسخه جدید');
      expect(html).toContain('این نسخه ویرایش نمی‌شود');
      expect(html).not.toContain('ویرایش سیاست');
   });
});

function deadLetter(): SupportIntakeDeadLetter {
   return {
      receiptId: 'receipt-safe',
      connector: { id: 'connector-safe', name: 'اتصال CRM', sourceChannel: 'API', status: 'ACTIVE' },
      case: null,
      status: 'DEAD_LETTER',
      attempts: 3,
      error: { code: 'INTAKE_PAYLOAD_INVALID', message: 'خطای قرارداد ورودی' },
      receivedAt: '2026-08-22T10:00:00.000Z',
      processedAt: null,
      deadLetteredAt: '2026-08-22T10:05:00.000Z',
      updatedAt: '2026-08-22T10:05:00.000Z',
   };
}

function policy(): SupportSlaPolicy {
   return {
      id: 'policy-v1', policyKey: 'standard', name: 'استاندارد', version: 1, priority: 100, active: true,
      calendar: { id: 'calendar', name: 'تهران', timezone: 'Asia/Tehran', active: true },
      conditions: {},
      targets: { FIRST_RESPONSE: { businessSeconds: 3600, atRiskSeconds: 2700 } },
      pauseRules: { waitingOnCustomer: [], waitingOnInternal: [], snoozed: [], automatedPublicResponseMeets: [] },
      effectiveFrom: '2026-08-23T10:00:00.000Z', effectiveUntil: null, createdAt: '2026-08-23T10:00:00.000Z',
   };
}

function report(): SupportOperationalReport {
   return {
      generatedAt: '2026-08-23T10:00:00.000Z', timezone: 'Asia/Tehran',
      scope: { kind: 'WORKSPACE', departmentId: null },
      cohort: { from: '2026-07-23T10:00:00.000Z', to: '2026-08-23T10:00:00.000Z', definition: 'visible cases' },
      summary: {
         received: 10, resolved: 7, closed: 5, reopened: 1, firstResponseRate: 0.8,
         firstResponseSeconds: { count: 8, p50: 600, p90: 1800 },
         resolutionSeconds: { count: 7, p50: 7200, p90: 18_000 },
      },
      backlog: { open: 5, ageSeconds: { count: 5, p50: 3600, p90: 14_400 } },
      queues: { TRIAGE: 1, DEPARTMENT_INBOX: 2 },
      breakdowns: {
         status: { OPEN: 5 }, priority: { NORMAL: 10 }, sourceChannel: { API: 10 },
         type: { general: 10 }, resolutionCode: { FIXED: 7 },
         department: [{ departmentId: 'department', name: 'پاسخ‌گویی', count: 10 }],
      },
      sla: [{ metric: 'FIRST_RESPONSE', met: 8, breached: 2, active: 0, canceled: 0, decided: 10, attainmentRate: 0.8 }],
      privacy: { perMemberBreakdownIncluded: false, note: 'same access predicate' },
   };
}
