import type { SupportCase, SupportCasePriority, SupportCaseSource } from '@/lib/support-types';

export const supportSlaMetrics = [
   'TRIAGE',
   'FIRST_RESPONSE',
   'NEXT_RESPONSE',
   'RESOLUTION',
   'FOLLOW_UP',
   'MEMBER_ASSIGNMENT',
] as const;

export type SupportSlaMetric = (typeof supportSlaMetrics)[number];

export interface SupportCalendarPeriod {
   dayOfWeek: number;
   startMinute: number;
   endMinute: number;
}

export interface SupportCalendarHoliday {
   /** ISO civil date in the calendar timezone, for example `2026-03-21`. */
   date: string;
   name: string;
   working: boolean;
}

export interface SupportBusinessCalendar {
   id: string;
   name: string;
   timezone: string;
   department: { id: string; name: string; slug: string } | null;
   active: boolean;
   periods: SupportCalendarPeriod[];
   holidays: SupportCalendarHoliday[];
   createdAt: string;
   updatedAt: string;
}

export interface CreateSupportCalendarInput {
   name: string;
   timezone: string;
   departmentId?: string | null;
   periods: SupportCalendarPeriod[];
   holidays: SupportCalendarHoliday[];
}

export type UpdateSupportCalendarInput = Partial<CreateSupportCalendarInput> & { active?: boolean };

export interface SupportSlaConditions {
   caseTypes?: string[];
   priorities?: SupportCasePriority[];
   sourceChannels?: SupportCaseSource[];
   departmentIds?: string[];
   impact?: Array<'LOW' | 'MEDIUM' | 'HIGH'>;
   urgency?: Array<'LOW' | 'MEDIUM' | 'HIGH'>;
}

export interface SupportSlaTarget {
   businessSeconds: number;
   atRiskSeconds?: number;
}

export type SupportSlaTargets = Partial<Record<SupportSlaMetric, SupportSlaTarget>>;

export interface SupportSlaPauseRules {
   waitingOnCustomer: SupportSlaMetric[];
   waitingOnInternal: SupportSlaMetric[];
   snoozed: SupportSlaMetric[];
   automatedPublicResponseMeets: Array<'FIRST_RESPONSE' | 'NEXT_RESPONSE'>;
}

export interface SupportSlaPolicy {
   id: string;
   policyKey: string;
   name: string;
   version: number;
   priority: number;
   active: boolean;
   calendar: { id: string; name: string; timezone: string; active: boolean };
   conditions: SupportSlaConditions;
   targets: SupportSlaTargets;
   pauseRules: SupportSlaPauseRules;
   effectiveFrom: string;
   effectiveUntil: string | null;
   createdAt: string;
}

export interface CreateSupportSlaPolicyInput {
   calendarId: string;
   policyKey: string;
   name: string;
   priority: number;
   conditions: SupportSlaConditions;
   targets: SupportSlaTargets;
   pauseRules: SupportSlaPauseRules;
   effectiveFrom: string;
   effectiveUntil?: string | null;
}

export const supportIntakeReceiptStatuses = [
   'RECEIVED',
   'PROCESSING',
   'RETRY_PENDING',
   'PROCESSED',
   'REJECTED',
   'DEAD_LETTER',
] as const;

export type SupportIntakeReceiptStatus = (typeof supportIntakeReceiptStatuses)[number];
export type SupportIntakeReceiptCounts = Record<SupportIntakeReceiptStatus, number>;

export interface SupportIntakeConnectorProjection {
   id: string;
   name: string;
   sourceChannel: SupportCaseSource;
   status: string;
   createdAt?: string;
   rotatedAt?: string | null;
   revokedAt?: string | null;
}

export interface SupportIntakeHealth {
   generatedAt: string;
   summary: {
      connectorCount: number;
      activeConnectorCount: number;
      receiptCounts: SupportIntakeReceiptCounts;
      pendingCount: number;
      deadLetterCount: number;
      oldestPendingAt: string | null;
   };
   items: Array<{
      connector: SupportIntakeConnectorProjection;
      receiptCounts: SupportIntakeReceiptCounts;
      pendingCount: number;
      deadLetterCount: number;
      oldestPendingAt: string | null;
      lastReceivedAt: string | null;
      lastProcessedAt: string | null;
      lastDeadLetteredAt: string | null;
   }>;
}

/** Deliberately contains only the server's sanitized operational projection. */
export interface SupportIntakeDeadLetter {
   receiptId: string;
   connector: Pick<SupportIntakeConnectorProjection, 'id' | 'name' | 'sourceChannel' | 'status'>;
   case: { id: string; key: string } | null;
   status: SupportIntakeReceiptStatus;
   attempts: number;
   error: { code: string; message: string } | null;
   receivedAt: string;
   processedAt: string | null;
   deadLetteredAt: string | null;
   updatedAt: string;
}

export interface SupportIntakeDeadLetterPage {
   items: SupportIntakeDeadLetter[];
   nextCursor: string | null;
}

export interface SupportIntakeRetryResult {
   receiptId: string;
   status: 'RETRY_PENDING';
   scheduledAt: string;
}

export interface SupportDurationSummary {
   count: number;
   p50: number | null;
   p90: number | null;
}

export interface SupportOperationalReport {
   generatedAt: string;
   timezone: string;
   scope: { kind: string; departmentId: string | null };
   cohort: { from: string; to: string; definition: string };
   summary: {
      received: number;
      resolved: number;
      closed: number;
      reopened: number;
      firstResponseRate: number | null;
      firstResponseSeconds: SupportDurationSummary;
      resolutionSeconds: SupportDurationSummary;
   };
   backlog: { open: number; ageSeconds: SupportDurationSummary };
   queues: Record<string, number>;
   breakdowns: {
      status: Record<string, number>;
      priority: Record<string, number>;
      sourceChannel: Record<string, number>;
      type: Record<string, number>;
      resolutionCode: Record<string, number>;
      department: Array<{ departmentId: string | null; name: string; count: number }>;
   };
   sla: Array<{
      metric: SupportSlaMetric;
      met: number;
      breached: number;
      active: number;
      canceled: number;
      decided: number;
      attainmentRate: number | null;
   }>;
   privacy: {
      /** Always false. The web client intentionally cannot represent a peer/member breakdown. */
      perMemberBreakdownIncluded: false;
      note: string;
   };
}

export interface SupportReportQuery {
   from?: string;
   to?: string;
   departmentId?: string;
}

export interface SupportDeadLetterQuery {
   cursor?: string;
   limit?: number;
   connectorId?: string;
}

export interface SupportCaseSnoozeInput {
   snoozedUntil: string;
   reason: string;
   baseVersion: number;
}

export interface SupportCaseResumeInput {
   reason: string;
   baseVersion: number;
}

export type SupportAttentionMutation = SupportCase;
