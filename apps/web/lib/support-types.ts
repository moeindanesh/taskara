export const supportQueueKinds = ['TRIAGE', 'DEPARTMENT_INBOX', 'MY_CASES', 'NEEDS_ATTENTION'] as const;
export type SupportQueueKind = (typeof supportQueueKinds)[number];

export const supportCaseStatuses = [
   'NEW',
   'OPEN',
   'WAITING_ON_CUSTOMER',
   'WAITING_ON_INTERNAL',
   'RESOLVED',
   'CLOSED',
] as const;
export type SupportCaseStatus = (typeof supportCaseStatuses)[number];

export const supportCasePriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type SupportCasePriority = (typeof supportCasePriorities)[number];

export const supportCaseSources = ['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING'] as const;
export type SupportCaseSource = (typeof supportCaseSources)[number];

export const supportResolutionCodes = [
   'FIXED',
   'ANSWERED',
   'WORKAROUND',
   'DUPLICATE',
   'NO_RESPONSE',
   'NOT_REPRODUCIBLE',
   'REJECTED',
   'WITHDRAWN',
   'SPAM',
] as const;
export type SupportResolutionCode = (typeof supportResolutionCodes)[number];

export const supportAttentionReasons = [
   'UNTRIAGED_TOO_LONG',
   'NO_NEXT_ACTION',
   'NEXT_ACTION_DUE',
   'SLA_AT_RISK',
   'SLA_BREACHED',
   'STALE_OWNERSHIP',
   'DEPARTMENT_UNASSIGNED_TOO_LONG',
   'WAITING_ON_CUSTOMER_TOO_LONG',
   'WAITING_ON_INTERNAL_TOO_LONG',
   'CALLBACK_DUE',
   'EXCESSIVE_TRANSFERS',
   'HANDOFF_REJECTED_OR_EXPIRED',
   'REOPENED',
   'RESOLUTION_UNCONFIRMED',
   'NON_FIXED_RESOLUTION',
   'LINKED_TASK_BLOCKED_OR_OVERDUE',
] as const;
export type SupportAttentionReason = (typeof supportAttentionReasons)[number];

export interface SupportPersonSummary {
   id: string;
   name: string;
   email?: string;
   phone?: string | null;
   avatarUrl?: string | null;
}

export interface SupportDepartment {
   id: string;
   workspaceId: string;
   name: string;
   slug: string;
   description: string | null;
   active: boolean;
   routingSettings?: Record<string, unknown> | null;
   createdAt: string;
   updatedAt: string;
   currentMembership?: Pick<SupportDepartmentMember, 'id' | 'role' | 'active'> | null;
   members?: SupportDepartmentMember[];
   _count?: { members?: number; cases?: number; unassignedCases?: number };
}

export interface SupportDepartmentMember {
   id: string;
   workspaceId: string;
   departmentId: string;
   userId: string;
   role: 'MEMBER' | 'MANAGER';
   active: boolean;
   deactivatedAt?: string | null;
   createdAt: string;
   updatedAt: string;
   user?: SupportPersonSummary;
}

export interface SupportPermissionGrant {
   id?: string;
   workspaceId?: string;
   userId: string;
   role: 'TRIAGER' | 'SUPERVISOR';
   active?: boolean;
   createdAt?: string;
   updatedAt?: string;
   user?: SupportPersonSummary;
}

export interface SupportContact {
   id: string;
   workspaceId?: string;
   name?: string | null;
   email?: string | null;
   phone?: string | null;
   externalCustomerId?: string | null;
   createdAt?: string;
   updatedAt?: string;
}

export interface SupportCase {
   id: string;
   workspaceId: string;
   key: string;
   sequence: number;
   title: string;
   description: string | null;
   sourceChannel: SupportCaseSource;
   typeKey: string;
   priority: SupportCasePriority;
   impact: 'LOW' | 'MEDIUM' | 'HIGH' | null;
   urgency: 'LOW' | 'MEDIUM' | 'HIGH' | null;
   status: SupportCaseStatus;
   waitingReason: string | null;
   departmentId: string | null;
   assigneeMembershipId: string | null;
   contactId: string | null;
   duplicateOfCaseId?: string | null;
   firstResponseAt?: string | null;
   lastCustomerActivityAt?: string | null;
   lastHumanResponseAt?: string | null;
   nextActionAt: string | null;
   snoozedUntil?: string | null;
   nextSlaDueAt: string | null;
   resolutionCode: SupportResolutionCode | null;
   resolutionSummary: string | null;
   receivedAt: string;
   lastMeaningfulActivityAt: string;
   resolvedAt: string | null;
   closedAt: string | null;
   reopenedAt?: string | null;
   reopenCount?: number;
   version: number;
   createdAt: string;
   updatedAt: string;
   department?: Pick<SupportDepartment, 'id' | 'name' | 'slug'> | null;
   /** The API name. `assignee` remains accepted for rolling-deploy compatibility. */
   assigneeMembership?: SupportDepartmentMember | null;
   assignee?: SupportDepartmentMember | null;
   contact?: SupportContact | null;
   duplicateOf?: Pick<SupportCase, 'id' | 'key' | 'title' | 'status'> | null;
   attentionReasons?: SupportAttentionReason[];
   accessEpoch?: string;
}

export interface SupportInteraction {
   id: string;
   workspaceId: string;
   caseId: string;
   kind: 'MESSAGE' | 'CALL' | 'NOTE';
   visibility: 'PUBLIC' | 'INTERNAL';
   channel: SupportCaseSource;
   direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
   contactId: string | null;
   externalId?: string | null;
   occurredAt: string;
   receivedAt?: string;
   createdAt: string;
   content?: {
      body?: string;
      format?: 'text/plain' | 'text/markdown';
      bodyHash?: string;
      redactedAt?: string | null;
      retentionUntil?: string | null;
      encrypted?: boolean;
   } | null;
   author?: SupportPersonSummary | null;
   actor?: SupportPersonSummary | null;
   call?: SupportCallDetail | null;
}

export interface SupportCallDetail {
   id?: string;
   direction: 'INBOUND' | 'OUTBOUND';
   disposition: 'ANSWERED' | 'MISSED' | 'ABANDONED' | 'VOICEMAIL';
   startedAt: string;
   answeredAt?: string | null;
   endedAt?: string | null;
   durationSeconds?: number | null;
   recordingConsent: 'UNKNOWN' | 'GIVEN' | 'DENIED' | 'NOT_REQUIRED';
   recordingExists: boolean;
   callbackOwnerId?: string | null;
   callbackDueAt?: string | null;
   externalCallId?: string | null;
}

export interface SupportCaseEvent {
   id: string;
   caseId?: string;
   sequence: number;
   action: string;
   source: 'WEB' | 'API' | 'CONNECTOR' | 'CALL_CENTER' | 'SYSTEM';
   occurredAt: string;
   createdAt?: string;
   actorId?: string | null;
   actorType?: string;
   actorRuntime?: string | null;
   before?: Record<string, unknown> | null;
   after?: Record<string, unknown> | null;
   reason?: string | null;
   actor?: SupportPersonSummary | null;
}

export interface SupportCaseDetail {
   case: SupportCase;
   interactions: SupportInteraction[];
   events: SupportCaseEvent[];
}

export interface SupportCaseListQuery {
   queue?: SupportQueueKind;
   status?: SupportCaseStatus | SupportCaseStatus[];
   departmentId?: string;
   assigneeMembershipId?: string;
   priority?: SupportCasePriority | SupportCasePriority[];
   sourceChannel?: SupportCaseSource | SupportCaseSource[];
   typeKey?: string;
   attentionReason?: SupportAttentionReason;
   q?: string;
   receivedFrom?: string;
   receivedTo?: string;
   cursor?: string;
   limit?: number;
}

export interface SupportPage<T> {
   items: T[];
   total?: number;
   nextCursor?: string | null;
   cursor?: string | null;
   counts?: SupportQueueCountsWire;
   accessEpoch?: string | number;
}

export interface CreateSupportCaseInput {
   title: string;
   description?: string;
   sourceChannel: SupportCaseSource;
   typeKey: string;
   priority?: SupportCasePriority;
   impact?: 'LOW' | 'MEDIUM' | 'HIGH';
   urgency?: 'LOW' | 'MEDIUM' | 'HIGH';
   contactId?: string;
   contact?: {
      name?: string;
      email?: string;
      phone?: string;
      externalCustomerId?: string;
   };
   departmentId?: string;
   idempotencyKey?: string;
}

type CreateSupportCallBaseInput = {
   contactId?: string;
   contact?: CreateSupportCaseInput['contact'];
   summary: string;
   internalNotes?: string;
   call: Omit<SupportCallDetail, 'id'>;
};

export type CreateSupportCallInput = CreateSupportCallBaseInput & (
   | { caseId: string; baseVersion: number; newCase?: never }
   | { newCase: CreateSupportCaseInput; caseId?: never; baseVersion?: never }
);

export type SupportCaseMutationResult =
   | SupportCase
   | {
        case: SupportCase;
        interaction: SupportInteraction;
        accessEpoch: string | number;
        internalNoteId?: string | null;
        createdNewCase?: boolean;
     };

export interface SupportSearchResult {
   cases: SupportCase[];
   contacts: SupportContact[];
   accessEpoch: string | number;
}

export interface SupportBootstrap {
   cases?: SupportCase[];
   departments?: SupportDepartment[];
   departmentMemberships?: SupportDepartmentMember[];
   grants?: SupportPermissionGrant[];
   counts?: SupportQueueCountsWire;
   access?: SupportAccessSummary;
   accessEpoch?: string | number;
   cursor?: string;
   support?: {
      interactionContentAvailable?: boolean;
      manualCallAvailable?: boolean;
   };
}

export type SupportSyncEvent =
   | {
        type: 'upsert';
        entityType: 'support_case';
        entityId: string;
        entity: SupportCase;
     }
   | {
        type: 'removeFromScope';
        entityType: 'support_case';
        entityId: string;
     }
   | {
        type: 'upsert';
        entityType: 'support_department';
        entityId: string;
        entity: SupportDepartment;
     };

export interface SupportSyncPull {
   accessEpoch: string | number;
   cursor: string;
   hasMore: boolean;
   events: SupportSyncEvent[];
}

export interface SupportAccessSummary {
   workspaceWide: boolean;
   triager: boolean;
   supervisor: boolean;
   managedDepartmentIds: string[];
   memberMembershipIds: string[];
   credentialScopes?: string[];
}

export type SupportQueueCountsWire = Partial<Record<SupportQueueKind, number>> & {
   triage?: number;
   departmentInbox?: number;
   myCases?: number;
   needsAttention?: number;
};
