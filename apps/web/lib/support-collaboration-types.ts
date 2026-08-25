import type {
   SupportAttentionReason,
   SupportCase,
   SupportCasePriority,
   SupportCaseSource,
   SupportCaseStatus,
   SupportQueueKind,
   SupportPersonSummary,
} from '@/lib/support-types';

export type SupportSavedQueueVisibility = 'PRIVATE' | 'DEPARTMENT' | 'WORKSPACE';

export interface SupportSavedQueueFilters {
   schemaVersion: 1;
   queue?: SupportQueueKind;
   statuses: SupportCaseStatus[];
   departmentId?: string;
   assigneeMembershipId?: string;
   priorities: SupportCasePriority[];
   sourceChannels: SupportCaseSource[];
   typeKey?: string;
   attentionReason?: SupportAttentionReason;
   receivedWithinHours?: number;
}

export interface SupportSavedQueue {
   id: string;
   workspaceId: string;
   ownerId: string;
   name: string;
   visibility: SupportSavedQueueVisibility;
   departmentId: string | null;
   filters: SupportSavedQueueFilters;
   version: number;
   createdAt: string;
   updatedAt: string;
}

export interface CreateSupportSavedQueueInput {
   name: string;
   visibility: SupportSavedQueueVisibility;
   departmentId?: string;
   filters: SupportSavedQueueFilters;
}

export interface SupportSavedQueueCasePage {
   savedView: SupportSavedQueue;
   items: SupportCase[];
   total: number;
   nextCursor: string | null;
   accessEpoch: string;
}

export interface SupportPresenceReader {
   user: Pick<SupportPersonSummary, 'id' | 'name' | 'avatarUrl'>;
   /** Opaque and intentionally never presented by the UI. */
   clientId: string;
   intent: 'VIEWING' | 'EDITING';
   caseVersion: number;
   staleVersion: boolean;
   expiresAt: string;
}

export interface SupportPresenceCollision {
   hasConcurrentEditor: boolean;
   hasVersionSkew: boolean;
   readers: SupportPresenceReader[];
}

export interface SupportPresenceResponse {
   caseId: string;
   caseVersion: number;
   expiresAt?: string;
   collision: SupportPresenceCollision;
}
