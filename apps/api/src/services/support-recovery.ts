import {
  type AttentionItemSeverity,
  type SupportCasePriority,
  type SupportCaseResolutionCode,
  type SupportCaseStatus,
  type SupportSlaClockState,
  type SupportSlaMetric
} from '@taskara/db';
import { supportAttentionReasons, type SupportAttentionReasonValue } from '@taskara/shared';
import { supportBusinessSecondsBetween, type SupportBusinessCalendarSnapshot } from './support-business-time';
import { isNonFixedResolution } from './support-sla';

export interface SupportRecoveryThresholds {
  triageUnassignedSeconds: number;
  slaAtRiskSeconds: number;
  staleMeaningfulActivitySeconds: number;
  departmentUnassignedSeconds: number;
  waitingOnCustomerSeconds: number;
  waitingOnInternalSeconds: number;
  excessiveTransferCount: number;
  reopenedAttentionSeconds: number;
}

export const defaultSupportRecoveryThresholds: SupportRecoveryThresholds = {
  triageUnassignedSeconds: 4 * 60 * 60,
  slaAtRiskSeconds: 60 * 60,
  staleMeaningfulActivitySeconds: 3 * 24 * 60 * 60,
  departmentUnassignedSeconds: 4 * 60 * 60,
  waitingOnCustomerSeconds: 7 * 24 * 60 * 60,
  waitingOnInternalSeconds: 2 * 24 * 60 * 60,
  excessiveTransferCount: 3,
  reopenedAttentionSeconds: 24 * 60 * 60
};

export interface SupportRecoveryCaseFacts {
  id: string;
  workspaceId: string;
  key: string;
  title: string;
  status: SupportCaseStatus;
  priority: SupportCasePriority;
  departmentId: string | null;
  assigneeMembershipId: string | null;
  assigneeUserId: string | null;
  receivedAt: Date;
  lastMeaningfulActivityAt: Date;
  nextActionAt: Date | null;
  reopenedAt: Date | null;
  resolvedAt: Date | null;
  resolutionCode: SupportCaseResolutionCode | null;
  statusSince: Date;
  departmentAssignedAt?: Date | null;
  transferCount?: number;
  handoffRejectedOrExpired?: boolean;
  linkedTaskBlockedOrOverdue?: boolean;
}

export interface SupportRecoveryClockFacts {
  id: string;
  metric: SupportSlaMetric;
  cycle: number;
  state: SupportSlaClockState;
  dueAt: Date;
  breachedAt: Date | null;
  metAt: Date | null;
  canceledAt: Date | null;
  atRiskSeconds?: number;
  frozenCalendar?: SupportBusinessCalendarSnapshot;
}

export interface SupportRecoveryCallFacts {
  interactionId: string;
  disposition: 'ANSWERED' | 'MISSED' | 'ABANDONED' | 'VOICEMAIL';
  callbackOwnerId: string | null;
  callbackDueAt: Date | null;
}

export interface SupportRecoveryCandidate {
  workspaceId: string;
  entityType: 'support_case' | 'support_case_sla_clock' | 'support_call';
  entityId: string;
  supportCaseId: string;
  reason: SupportAttentionReasonValue;
  severity: AttentionItemSeverity;
  assigneeId: string | null;
  dueAt: Date | null;
  conditionKey: string;
  title: string;
  description: string;
  metric?: SupportSlaMetric;
  cycle?: number;
}

export interface DeriveSupportRecoveryInput {
  supportCase: SupportRecoveryCaseFacts;
  clocks?: readonly SupportRecoveryClockFacts[];
  calls?: readonly SupportRecoveryCallFacts[];
  now: Date;
  thresholds?: Partial<SupportRecoveryThresholds>;
}

export function deriveSupportRecoveryCandidates(input: DeriveSupportRecoveryInput): SupportRecoveryCandidate[] {
  const thresholds = { ...defaultSupportRecoveryThresholds, ...input.thresholds };
  const supportCase = input.supportCase;
  if (supportCase.status === 'CLOSED') return [];
  const candidates: SupportRecoveryCandidate[] = [];
  const base = (reason: SupportAttentionReasonValue, severity: AttentionItemSeverity, description: string, dueAt: Date | null = null): SupportRecoveryCandidate => ({
    workspaceId: supportCase.workspaceId,
    entityType: 'support_case',
    entityId: supportCase.id,
    supportCaseId: supportCase.id,
    reason,
    severity,
    assigneeId: supportCase.assigneeUserId,
    dueAt,
    conditionKey: [reason, supportCase.id, dueAt?.toISOString() ?? '', supportCase.status, supportCase.reopenedAt?.toISOString() ?? ''].join(':'),
    title: `${supportCase.key}: ${supportCase.title}`,
    description
  });

  if (
    !supportCase.departmentId &&
    (supportCase.status === 'NEW' || supportCase.status === 'OPEN') &&
    elapsedSeconds(supportCase.receivedAt, input.now) >= thresholds.triageUnassignedSeconds
  ) {
    candidates.push(base('UNTRIAGED_TOO_LONG', severityForPriority(supportCase.priority), 'The Case has remained in Triage beyond policy.'));
  }
  if (caseNeedsNextAction(supportCase.status) && !supportCase.nextActionAt) {
    candidates.push(base('NO_NEXT_ACTION', severityForPriority(supportCase.priority), 'No next action is recorded for this Case.'));
  }
  if (supportCase.nextActionAt && supportCase.nextActionAt.getTime() <= input.now.getTime()) {
    candidates.push(base('NEXT_ACTION_DUE', dueSeverity(supportCase.nextActionAt, input.now, supportCase.priority), 'The Case next action is due.', supportCase.nextActionAt));
  }

  for (const clock of input.clocks ?? []) {
    const wallSecondsUntilDue = Math.floor((clock.dueAt.getTime() - input.now.getTime()) / 1000);
    const businessSecondsUntilDue = clock.frozenCalendar && wallSecondsUntilDue > 0
      ? supportBusinessSecondsBetween(clock.frozenCalendar, input.now, clock.dueAt)
      : Math.max(0, wallSecondsUntilDue);
    const atRiskSeconds = clock.atRiskSeconds ?? thresholds.slaAtRiskSeconds;
    if ((clock.state === 'BREACHED' && !clock.metAt && !clock.canceledAt) || (clock.state === 'RUNNING' && wallSecondsUntilDue < 0)) {
      candidates.push(clockCandidate(supportCase, clock, 'SLA_BREACHED', 'URGENT', 'A service commitment has breached.', clock.dueAt));
    } else if (clock.state === 'RUNNING' && businessSecondsUntilDue <= atRiskSeconds) {
      candidates.push(clockCandidate(supportCase, clock, 'SLA_AT_RISK', businessSecondsUntilDue <= atRiskSeconds / 4 ? 'HIGH' : 'MEDIUM', 'A service commitment is approaching breach.', clock.dueAt));
    }
  }

  if (
    supportCase.assigneeMembershipId &&
    elapsedSeconds(supportCase.lastMeaningfulActivityAt, input.now) >= thresholds.staleMeaningfulActivitySeconds
  ) {
    candidates.push(base('STALE_OWNERSHIP', severityForPriority(supportCase.priority), 'The Case has had no meaningful customer or human support activity.'));
  }
  if (
    supportCase.departmentId && !supportCase.assigneeMembershipId &&
    supportCase.departmentAssignedAt &&
    elapsedSeconds(supportCase.departmentAssignedAt, input.now) >= thresholds.departmentUnassignedSeconds
  ) {
    candidates.push(base('DEPARTMENT_UNASSIGNED_TOO_LONG', severityForPriority(supportCase.priority), 'The Case has remained in the Department Inbox beyond policy.'));
  }
  if (
    supportCase.status === 'WAITING_ON_CUSTOMER' &&
    elapsedSeconds(supportCase.statusSince, input.now) >= thresholds.waitingOnCustomerSeconds
  ) {
    candidates.push(base('WAITING_ON_CUSTOMER_TOO_LONG', 'MEDIUM', 'The Case has waited on the customer beyond policy.', supportCase.nextActionAt));
  }
  if (
    supportCase.status === 'WAITING_ON_INTERNAL' &&
    elapsedSeconds(supportCase.statusSince, input.now) >= thresholds.waitingOnInternalSeconds
  ) {
    candidates.push(base('WAITING_ON_INTERNAL_TOO_LONG', 'HIGH', 'The Case has waited on an internal action beyond policy.', supportCase.nextActionAt));
  }

  for (const call of input.calls ?? []) {
    if (!call.callbackDueAt || call.callbackDueAt.getTime() > input.now.getTime()) continue;
    if (call.disposition !== 'MISSED' && call.disposition !== 'ABANDONED' && call.disposition !== 'VOICEMAIL') continue;
    candidates.push({
      ...base('CALLBACK_DUE', 'HIGH', 'A missed, abandoned, or voicemail call needs a callback.', call.callbackDueAt),
      entityType: 'support_call',
      entityId: call.interactionId,
      assigneeId: call.callbackOwnerId ?? supportCase.assigneeUserId,
      conditionKey: ['CALLBACK_DUE', call.interactionId, call.callbackDueAt.toISOString()].join(':')
    });
  }

  if ((supportCase.transferCount ?? 0) >= thresholds.excessiveTransferCount) {
    candidates.push(base('EXCESSIVE_TRANSFERS', 'HIGH', 'The Case has bounced between Departments too many times.'));
  }
  if (supportCase.handoffRejectedOrExpired) {
    candidates.push(base('HANDOFF_REJECTED_OR_EXPIRED', 'HIGH', 'A Team handoff was rejected or expired.'));
  }
  if (
    supportCase.reopenedAt &&
    elapsedSeconds(supportCase.reopenedAt, input.now) <= thresholds.reopenedAttentionSeconds
  ) {
    candidates.push(base('REOPENED', 'HIGH', 'The Case reopened after resolution.'));
  }
  if (supportCase.status === 'RESOLVED') {
    candidates.push(base('RESOLUTION_UNCONFIRMED', isNonFixedResolution(supportCase.resolutionCode) ? 'HIGH' : 'MEDIUM', 'The resolution is awaiting confirmation or its verification window.'));
  }
  if (isNonFixedResolution(supportCase.resolutionCode)) {
    candidates.push(base('NON_FIXED_RESOLUTION', 'HIGH', 'The recorded outcome did not confirm a complete fix.'));
  }
  if (supportCase.linkedTaskBlockedOrOverdue) {
    candidates.push(base('LINKED_TASK_BLOCKED_OR_OVERDUE', 'MEDIUM', 'Linked Team work is blocked or overdue; this is a signal, not an automatic Case transition.'));
  }

  return dedupeAndSort(candidates);
}

export function primarySupportAttentionReason(candidates: readonly SupportRecoveryCandidate[]): SupportAttentionReasonValue | null {
  return [...candidates].sort(compareRecoveryCandidate)[0]?.reason ?? null;
}

export function isSupportAttentionReason(value: string): value is SupportAttentionReasonValue {
  return (supportAttentionReasons as readonly string[]).includes(value);
}

function clockCandidate(
  supportCase: SupportRecoveryCaseFacts,
  clock: SupportRecoveryClockFacts,
  reason: Extract<SupportAttentionReasonValue, 'SLA_AT_RISK' | 'SLA_BREACHED'>,
  severity: AttentionItemSeverity,
  description: string,
  dueAt: Date
): SupportRecoveryCandidate {
  return {
    workspaceId: supportCase.workspaceId,
    entityType: 'support_case_sla_clock',
    // One clock is one metric/cycle, making `(entityId, reason)` an idempotent alert identity while
    // a reopened cycle can alert again without mutating the old incident.
    entityId: clock.id,
    supportCaseId: supportCase.id,
    reason,
    severity,
    assigneeId: supportCase.assigneeUserId,
    dueAt,
    conditionKey: [reason, supportCase.id, clock.metric, clock.cycle, dueAt.toISOString()].join(':'),
    title: `${supportCase.key}: ${supportCase.title}`,
    description,
    metric: clock.metric,
    cycle: clock.cycle
  };
}

function dedupeAndSort(candidates: SupportRecoveryCandidate[]): SupportRecoveryCandidate[] {
  const byKey = new Map<string, SupportRecoveryCandidate>();
  for (const candidate of candidates) {
    const key = [candidate.entityType, candidate.entityId, candidate.reason].join(':');
    const current = byKey.get(key);
    if (!current || severityRank[candidate.severity] > severityRank[current.severity]) byKey.set(key, candidate);
  }
  return [...byKey.values()].sort(compareRecoveryCandidate);
}

function compareRecoveryCandidate(left: SupportRecoveryCandidate, right: SupportRecoveryCandidate): number {
  return severityRank[right.severity] - severityRank[left.severity] ||
    (left.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
    left.reason.localeCompare(right.reason);
}

const severityRank: Record<AttentionItemSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };

function severityForPriority(priority: SupportCasePriority): AttentionItemSeverity {
  if (priority === 'URGENT') return 'URGENT';
  if (priority === 'HIGH') return 'HIGH';
  if (priority === 'NORMAL') return 'MEDIUM';
  return 'LOW';
}

function dueSeverity(dueAt: Date, now: Date, priority: SupportCasePriority): AttentionItemSeverity {
  const overdueSeconds = elapsedSeconds(dueAt, now);
  if (priority === 'URGENT' || overdueSeconds >= 24 * 60 * 60) return 'URGENT';
  return 'HIGH';
}

function caseNeedsNextAction(status: SupportCaseStatus): boolean {
  return status === 'OPEN' || status === 'WAITING_ON_CUSTOMER' || status === 'WAITING_ON_INTERNAL' || status === 'RESOLVED';
}

function elapsedSeconds(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}
