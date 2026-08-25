import { taskaraRequest } from '@/lib/taskara-client';
import type { SupportCase, SupportCasePriority, SupportCaseSource } from '@/lib/support-types';
import {
   supportIntakeReceiptStatuses,
   supportSlaMetrics,
   type CreateSupportCalendarInput,
   type CreateSupportSlaPolicyInput,
   type SupportBusinessCalendar,
   type SupportCaseResumeInput,
   type SupportCaseSnoozeInput,
   type SupportDeadLetterQuery,
   type SupportDurationSummary,
   type SupportIntakeConnectorProjection,
   type SupportIntakeDeadLetter,
   type SupportIntakeDeadLetterPage,
   type SupportIntakeHealth,
   type SupportIntakeReceiptCounts,
   type SupportIntakeReceiptStatus,
   type SupportIntakeRetryResult,
   type SupportOperationalReport,
   type SupportReportQuery,
   type SupportSlaConditions,
   type SupportSlaMetric,
   type SupportSlaPauseRules,
   type SupportSlaPolicy,
   type SupportSlaTargets,
   type UpdateSupportCalendarInput,
} from '@/lib/support-operations-types';

const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const sources = ['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING'] as const;
const levels = ['LOW', 'MEDIUM', 'HIGH'] as const;

function segment(value: string): string {
   return encodeURIComponent(value);
}

export function supportCalendarPath(id?: string): string {
   return id ? `/support/config/calendars/${segment(id)}` : '/support/config/calendars';
}

export function supportSlaPoliciesPath(): string {
   return '/support/config/sla-policies';
}

export function supportSlaDeactivatePath(id: string): string {
   return `${supportSlaPoliciesPath()}/${segment(id)}/deactivate`;
}

export function supportDeadLettersPath(query: SupportDeadLetterQuery = {}): string {
   const params = new URLSearchParams();
   if (query.cursor) params.set('cursor', query.cursor);
   if (query.limit !== undefined) params.set('limit', String(query.limit));
   if (query.connectorId) params.set('connectorId', query.connectorId);
   return `/support/intake-admin/dead-letters${params.size ? `?${params.toString()}` : ''}`;
}

export function supportDeadLetterPath(receiptId: string): string {
   return `/support/intake-admin/dead-letters/${segment(receiptId)}`;
}

export function supportReportsOverviewPath(query: SupportReportQuery = {}): string {
   const params = new URLSearchParams();
   if (query.from) params.set('from', query.from);
   if (query.to) params.set('to', query.to);
   if (query.departmentId) params.set('departmentId', query.departmentId);
   return `/support/reports/overview${params.size ? `?${params.toString()}` : ''}`;
}

export function supportAttentionPath(idOrKey: string, action: 'snooze' | 'resume'): string {
   return `/support/cases/${segment(idOrKey)}/${action}`;
}

export const supportOperationsClient = {
   listCalendars: async () => normalizeSupportCalendars(await taskaraRequest<unknown>(supportCalendarPath())),
   createCalendar: async (input: CreateSupportCalendarInput) => normalizeSupportCalendar(
      await taskaraRequest<unknown>(supportCalendarPath(), { method: 'POST', body: JSON.stringify(input) })
   ),
   updateCalendar: async (id: string, input: UpdateSupportCalendarInput) => normalizeSupportCalendar(
      await taskaraRequest<unknown>(supportCalendarPath(id), { method: 'PATCH', body: JSON.stringify(input) })
   ),
   listSlaPolicies: async () => normalizeSupportSlaPolicies(await taskaraRequest<unknown>(supportSlaPoliciesPath())),
   createSlaPolicy: async (input: CreateSupportSlaPolicyInput) => normalizeSupportSlaPolicy(
      await taskaraRequest<unknown>(supportSlaPoliciesPath(), { method: 'POST', body: JSON.stringify(input) })
   ),
   deactivateSlaPolicy: async (id: string) => normalizeSupportSlaPolicy(
      await taskaraRequest<unknown>(supportSlaDeactivatePath(id), { method: 'POST' })
   ),
   getIntakeHealth: async () => normalizeSupportIntakeHealth(
      await taskaraRequest<unknown>('/support/intake-admin/health')
   ),
   listDeadLetters: async (query: SupportDeadLetterQuery = {}) => normalizeSupportDeadLetterPage(
      await taskaraRequest<unknown>(supportDeadLettersPath(query))
   ),
   getDeadLetter: async (receiptId: string) => normalizeSupportDeadLetter(
      await taskaraRequest<unknown>(supportDeadLetterPath(receiptId))
   ),
   retryDeadLetter: async (receiptId: string) => normalizeSupportIntakeRetry(
      await taskaraRequest<unknown>(`${supportDeadLetterPath(receiptId)}/retry`, { method: 'POST' })
   ),
   getReport: async (query: SupportReportQuery = {}) => normalizeSupportOperationalReport(
      await taskaraRequest<unknown>(supportReportsOverviewPath(query))
   ),
   snoozeCase: (idOrKey: string, input: SupportCaseSnoozeInput) => taskaraRequest<SupportCase>(
      supportAttentionPath(idOrKey, 'snooze'), { method: 'POST', body: JSON.stringify(input) }
   ),
   resumeCase: (idOrKey: string, input: SupportCaseResumeInput) => taskaraRequest<SupportCase>(
      supportAttentionPath(idOrKey, 'resume'), { method: 'POST', body: JSON.stringify(input) }
   ),
};

export function normalizeSupportCalendars(value: unknown): SupportBusinessCalendar[] {
   return rows(value).map(normalizeSupportCalendar);
}

export function normalizeSupportCalendar(value: unknown): SupportBusinessCalendar {
   const item = record(value);
   const department = nullableRecord(item.department);
   return {
      id: text(item.id),
      name: text(item.name),
      timezone: text(item.timezone),
      department: department ? {
         id: text(department.id),
         name: text(department.name),
         slug: text(department.slug),
      } : null,
      active: item.active !== false,
      periods: array(item.periods).map((value) => {
         const period = record(value);
         return {
            dayOfWeek: integer(period.dayOfWeek),
            startMinute: integer(period.startMinute),
            endMinute: integer(period.endMinute),
         };
      }),
      holidays: array(item.holidays).map((value) => {
         const holiday = record(value);
         return { date: text(holiday.date), name: text(holiday.name), working: holiday.working === true };
      }),
      createdAt: text(item.createdAt),
      updatedAt: text(item.updatedAt),
   };
}

export function normalizeSupportSlaPolicies(value: unknown): SupportSlaPolicy[] {
   return rows(value).map(normalizeSupportSlaPolicy);
}

export function normalizeSupportSlaPolicy(value: unknown): SupportSlaPolicy {
   const item = record(value);
   const calendar = record(item.calendar);
   return {
      id: text(item.id),
      policyKey: text(item.policyKey),
      name: text(item.name),
      version: integer(item.version),
      priority: integer(item.priority),
      active: item.active === true,
      calendar: {
         id: text(calendar.id),
         name: text(calendar.name),
         timezone: text(calendar.timezone),
         active: calendar.active === true,
      },
      conditions: normalizeConditions(item.conditions),
      targets: normalizeTargets(item.targets),
      pauseRules: normalizePauseRules(item.pauseRules),
      effectiveFrom: text(item.effectiveFrom),
      effectiveUntil: optionalText(item.effectiveUntil),
      createdAt: text(item.createdAt),
   };
}

/** Re-projects the already-sanitized server contract and drops every unknown receipt field. */
export function normalizeSupportDeadLetter(value: unknown): SupportIntakeDeadLetter {
   const item = record(value);
   const connector = normalizeConnector(item.connector);
   const caseRecord = nullableRecord(item.case);
   const error = nullableRecord(item.error);
   return {
      receiptId: text(item.receiptId),
      connector: {
         id: connector.id,
         name: connector.name,
         sourceChannel: connector.sourceChannel,
         status: connector.status,
      },
      case: caseRecord ? { id: text(caseRecord.id), key: text(caseRecord.key) } : null,
      status: receiptStatus(item.status),
      attempts: integer(item.attempts),
      error: error ? { code: text(error.code), message: text(error.message) } : null,
      receivedAt: text(item.receivedAt),
      processedAt: optionalText(item.processedAt),
      deadLetteredAt: optionalText(item.deadLetteredAt),
      updatedAt: text(item.updatedAt),
   };
}

export function normalizeSupportDeadLetterPage(value: unknown): SupportIntakeDeadLetterPage {
   const page = record(value);
   return {
      items: array(page.items).map(normalizeSupportDeadLetter),
      nextCursor: optionalText(page.nextCursor),
   };
}

export function normalizeSupportIntakeHealth(value: unknown): SupportIntakeHealth {
   const payload = record(value);
   const summary = record(payload.summary);
   return {
      generatedAt: text(payload.generatedAt),
      summary: {
         connectorCount: integer(summary.connectorCount),
         activeConnectorCount: integer(summary.activeConnectorCount),
         receiptCounts: normalizeReceiptCounts(summary.receiptCounts),
         pendingCount: integer(summary.pendingCount),
         deadLetterCount: integer(summary.deadLetterCount),
         oldestPendingAt: optionalText(summary.oldestPendingAt),
      },
      items: array(payload.items).map((value) => {
         const item = record(value);
         return {
            connector: normalizeConnector(item.connector),
            receiptCounts: normalizeReceiptCounts(item.receiptCounts),
            pendingCount: integer(item.pendingCount),
            deadLetterCount: integer(item.deadLetterCount),
            oldestPendingAt: optionalText(item.oldestPendingAt),
            lastReceivedAt: optionalText(item.lastReceivedAt),
            lastProcessedAt: optionalText(item.lastProcessedAt),
            lastDeadLetteredAt: optionalText(item.lastDeadLetteredAt),
         };
      }),
   };
}

export function normalizeSupportOperationalReport(value: unknown): SupportOperationalReport {
   const payload = record(value);
   const scope = record(payload.scope);
   const cohort = record(payload.cohort);
   const summary = record(payload.summary);
   const backlog = record(payload.backlog);
   const breakdowns = record(payload.breakdowns);
   const privacy = record(payload.privacy);
   return {
      generatedAt: text(payload.generatedAt),
      timezone: text(payload.timezone),
      scope: { kind: text(scope.kind), departmentId: optionalText(scope.departmentId) },
      cohort: { from: text(cohort.from), to: text(cohort.to), definition: text(cohort.definition) },
      summary: {
         received: integer(summary.received),
         resolved: integer(summary.resolved),
         closed: integer(summary.closed),
         reopened: integer(summary.reopened),
         firstResponseRate: optionalNumber(summary.firstResponseRate),
         firstResponseSeconds: normalizeDuration(summary.firstResponseSeconds),
         resolutionSeconds: normalizeDuration(summary.resolutionSeconds),
      },
      backlog: { open: integer(backlog.open), ageSeconds: normalizeDuration(backlog.ageSeconds) },
      queues: numericRecord(payload.queues),
      breakdowns: {
         status: numericRecord(breakdowns.status),
         priority: numericRecord(breakdowns.priority),
         sourceChannel: numericRecord(breakdowns.sourceChannel),
         type: numericRecord(breakdowns.type),
         resolutionCode: numericRecord(breakdowns.resolutionCode),
         department: array(breakdowns.department).map((value) => {
            const item = record(value);
            return { departmentId: optionalText(item.departmentId), name: text(item.name), count: integer(item.count) };
         }),
      },
      sla: array(payload.sla).flatMap((value) => {
         const item = record(value);
         const metric = enumOrNull(item.metric, supportSlaMetrics);
         if (!metric) return [];
         return [{
            metric,
            met: integer(item.met),
            breached: integer(item.breached),
            active: integer(item.active),
            canceled: integer(item.canceled),
            decided: integer(item.decided),
            attainmentRate: optionalNumber(item.attainmentRate),
         }];
      }),
      privacy: {
         perMemberBreakdownIncluded: false,
         note: text(privacy.note),
      },
   };
}

function normalizeSupportIntakeRetry(value: unknown): SupportIntakeRetryResult {
   const item = record(value);
   return {
      receiptId: text(item.receiptId),
      status: 'RETRY_PENDING',
      scheduledAt: text(item.scheduledAt),
   };
}

function normalizeConnector(value: unknown): SupportIntakeConnectorProjection {
   const item = record(value);
   return {
      id: text(item.id),
      name: text(item.name),
      sourceChannel: enumValue(item.sourceChannel, sources, 'API'),
      status: text(item.status),
      ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
      ...(item.rotatedAt === null || typeof item.rotatedAt === 'string' ? { rotatedAt: item.rotatedAt } : {}),
      ...(item.revokedAt === null || typeof item.revokedAt === 'string' ? { revokedAt: item.revokedAt } : {}),
   };
}

function normalizeReceiptCounts(value: unknown): SupportIntakeReceiptCounts {
   const counts = record(value);
   return Object.fromEntries(
      supportIntakeReceiptStatuses.map((status) => [status, integer(counts[status])])
   ) as SupportIntakeReceiptCounts;
}

function normalizeConditions(value: unknown): SupportSlaConditions {
   const item = record(value);
   return {
      ...(strings(item.caseTypes).length ? { caseTypes: strings(item.caseTypes) } : {}),
      ...(enums(item.priorities, priorities).length ? { priorities: enums(item.priorities, priorities) as SupportCasePriority[] } : {}),
      ...(enums(item.sourceChannels, sources).length ? { sourceChannels: enums(item.sourceChannels, sources) as SupportCaseSource[] } : {}),
      ...(strings(item.departmentIds).length ? { departmentIds: strings(item.departmentIds) } : {}),
      ...(enums(item.impact, levels).length ? { impact: enums(item.impact, levels) } : {}),
      ...(enums(item.urgency, levels).length ? { urgency: enums(item.urgency, levels) } : {}),
   };
}

function normalizeTargets(value: unknown): SupportSlaTargets {
   const item = record(value);
   const targets: SupportSlaTargets = {};
   for (const metric of supportSlaMetrics) {
      const target = nullableRecord(item[metric]);
      if (!target) continue;
      targets[metric] = {
         businessSeconds: integer(target.businessSeconds),
         ...(typeof target.atRiskSeconds === 'number' ? { atRiskSeconds: integer(target.atRiskSeconds) } : {}),
      };
   }
   return targets;
}

function normalizePauseRules(value: unknown): SupportSlaPauseRules {
   const item = record(value);
   return {
      waitingOnCustomer: enums(item.waitingOnCustomer, supportSlaMetrics),
      waitingOnInternal: enums(item.waitingOnInternal, supportSlaMetrics),
      snoozed: enums(item.snoozed, supportSlaMetrics),
      automatedPublicResponseMeets: enums(item.automatedPublicResponseMeets, ['FIRST_RESPONSE', 'NEXT_RESPONSE'] as const),
   };
}

function normalizeDuration(value: unknown): SupportDurationSummary {
   const item = record(value);
   return { count: integer(item.count), p50: optionalNumber(item.p50), p90: optionalNumber(item.p90) };
}

function receiptStatus(value: unknown): SupportIntakeReceiptStatus {
   return enumValue(value, supportIntakeReceiptStatuses, 'DEAD_LETTER');
}

function rows(value: unknown): unknown[] {
   return Array.isArray(value) ? value : array(record(value).items);
}

function array(value: unknown): unknown[] {
   return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
   return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
   return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
   return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | null {
   return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number {
   return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function optionalNumber(value: unknown): number | null {
   return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
   return array(value).filter((item): item is string => typeof item === 'string');
}

function enums<T extends string>(value: unknown, allowed: readonly T[]): T[] {
   return array(value).filter((item): item is T => typeof item === 'string' && allowed.includes(item as T));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
   return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function enumOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
   return typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
}

function numericRecord(value: unknown): Record<string, number> {
   return Object.fromEntries(
      Object.entries(record(value)).flatMap(([key, count]) =>
         typeof count === 'number' && Number.isFinite(count) ? [[key, Math.trunc(count)]] : []
      )
   );
}
