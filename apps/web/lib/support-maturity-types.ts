import type { SupportCase, SupportCasePriority, SupportCaseSource, SupportCaseStatus } from '@/lib/support-types';

export const supportAssistanceKinds = [
   'TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE', 'SUMMARY', 'REPLY', 'KNOWLEDGE',
] as const;
export type SupportAssistanceKind = (typeof supportAssistanceKinds)[number];
export type SupportAssistanceDecision = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';

export interface SupportAssistanceProvenance {
   provider: string;
   modelOrRule: string;
   version: string;
   confidence: number;
   contextDigest: string;
}

type AssistanceBase = {
   id: string;
   caseId: string;
   provenance: SupportAssistanceProvenance;
   decision: SupportAssistanceDecision;
   decisionReason: string | null;
   decisionCaseVersion: number | null;
   decidedAt: string | null;
   expiresAt: string | null;
   createdAt: string;
};

export type SupportAssistanceSuggestion =
   | (AssistanceBase & { kind: 'TYPE'; payload: { typeKey: string } })
   | (AssistanceBase & { kind: 'PRIORITY'; payload: { priority: SupportCasePriority } })
   | (AssistanceBase & { kind: 'DEPARTMENT'; payload: { departmentId: string } })
   | (AssistanceBase & { kind: 'DUPLICATE'; payload: { caseId: string } })
   | (AssistanceBase & { kind: 'SUMMARY'; payload: { text: string } })
   | (AssistanceBase & { kind: 'REPLY'; payload: { text: string } })
   | (AssistanceBase & {
        kind: 'KNOWLEDGE';
        payload: { references: Array<{ pageId: string; title: string; reason?: string }> };
     });

export interface SupportCsatInvitation {
   id: string;
   scaleMin: number;
   scaleMax: number;
   expiresAt: string;
   consumedAt: string | null;
   invalidatedAt: string | null;
   createdAt: string;
   response: { score: number; comment: string | null; submittedAt: string } | null;
}

export interface SupportCsatInvitationCreated
   extends Omit<SupportCsatInvitation, 'consumedAt' | 'invalidatedAt' | 'response'> {
   token: string;
}

export interface SupportQualityCriterion {
   key: string;
   label: string;
   maxScore: number;
   weight: number;
}

export interface SupportQualityRubric {
   id: string;
   rubricKey: string;
   name: string;
   version: number;
   criteria: SupportQualityCriterion[];
   createdById: string | null;
   createdAt: string;
}

export interface SupportQualityFinding {
   criterionKey: string;
   score: number;
   finding?: string;
}

export interface SupportQualityReview {
   id: string;
   caseId: string;
   rubricId: string;
   rubricVersion: number;
   departmentId: string;
   assigneeUserId: string | null;
   reviewerId: string | null;
   reviewerKind: 'HUMAN' | 'AGENT' | null;
   sampleReason: string;
   score: number;
   findings: SupportQualityFinding[];
   completedAt: string;
   createdAt: string;
   case: { id: string; key: string; title: string };
   rubric: { id: string; rubricKey: string; name: string; version: number };
   reviewer: { id: string; name: string } | null;
   assignee: { id: string; name: string } | null;
}

export type SupportEnablementKind = 'MACRO' | 'TEMPLATE' | 'AUTOMATION';
export type SupportEnablementStatus = 'DRAFT' | 'APPROVED' | 'RETIRED';
export type SupportLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type SupportEnablementAction =
   | { type: 'SET_PRIORITY'; value: SupportCasePriority }
   | { type: 'SET_IMPACT'; value: SupportLevel | null }
   | { type: 'SET_URGENCY'; value: SupportLevel | null }
   | { type: 'SET_TYPE_KEY'; value: string }
   | { type: 'SET_NEXT_ACTION_AT'; value: string }
   | { type: 'CLEAR_NEXT_ACTION' };

export type SupportAutomationCondition =
   | { field: 'PRIORITY'; value: SupportCasePriority }
   | { field: 'IMPACT'; value: SupportLevel }
   | { field: 'URGENCY'; value: SupportLevel }
   | { field: 'STATUS'; value: SupportCaseStatus }
   | { field: 'SOURCE_CHANNEL'; value: SupportCaseSource }
   | { field: 'TYPE_KEY'; value: string }
   | { field: 'DEPARTMENT_ASSIGNED'; value: boolean };

export interface SupportEnablementDefinition {
   id: string;
   kind: SupportEnablementKind;
   definitionKey: string;
   version: number;
   name: string;
   description: string | null;
   status: SupportEnablementStatus;
   conditions: SupportAutomationCondition[] | null;
   actions: SupportEnablementAction[];
   createdById: string | null;
   approvedById: string | null;
   approvedAt: string | null;
   retiredById: string | null;
   retiredAt: string | null;
   createdAt: string;
}

export interface CreateSupportEnablementDefinitionInput {
   kind: SupportEnablementKind;
   definitionKey: string;
   name: string;
   description?: string;
   conditions?: SupportAutomationCondition[];
   actions: SupportEnablementAction[];
}

export interface SupportEnablementPreview {
   definition: SupportEnablementDefinition;
   case: { id: string; key: string; version: number };
   conditionMatched: boolean;
   conditionResults: Array<{ field: SupportAutomationCondition['field']; matched: boolean }>;
   changes: Array<{ field: string; before: string | number | null; after: string | number | null }>;
   previewHash: string;
   canApply: boolean;
   requiresHumanApply: true;
}

export interface SupportEnablementApplication {
   id: string;
   definitionId: string;
   caseId: string;
   caseVersionBefore: number;
   caseVersionAfter: number;
   previewHash: string;
   appliedAt: string;
   undoneAt: string | null;
   undoCaseVersion: number | null;
}

export interface SupportEnablementMutation {
   application: SupportEnablementApplication;
   case: SupportCase;
}

export type SupportProblemClusterStatus = 'OPEN' | 'RESOLVED' | 'ARCHIVED';

export interface SupportProblemClusterCase {
   id: string;
   key: string;
   title: string;
   status: SupportCaseStatus;
   priority: SupportCasePriority;
   departmentId: string | null;
   assigneeMembershipId: string | null;
   version: number;
   updatedAt: string;
   linkedAt: string;
}

export interface SupportProblemCluster {
   id: string;
   title: string;
   summary: string | null;
   status: SupportProblemClusterStatus;
   version: number;
   createdById: string | null;
   createdAt: string;
   updatedAt: string;
   visibleMemberCount: number;
   cases?: SupportProblemClusterCase[];
   accessEpoch?: string;
}

export interface SupportKnowledgePageSummary {
   id: string;
   title: string;
   path: string;
   summary: string | null;
   status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
   version: number;
   updatedAt: string;
}

export interface SupportKnowledgeSearchResult {
   items: SupportKnowledgePageSummary[];
   total: number;
   limit: number;
   offset: number;
   case: { id: string; key: string; version: number };
   accessDoesNotTransfer: true;
}

export type SupportKnowledgeUsefulness = 'HELPFUL' | 'PARTIAL' | 'NOT_HELPFUL';
export type SupportKnowledgeOutcome = 'RESOLVED' | 'ADVANCED' | 'NO_EFFECT';

export interface SupportKnowledgeUse {
   id: string;
   caseId: string;
   knowledgePageId: string;
   caseVersion: number;
   knowledgePageVersion: number;
   usefulness: SupportKnowledgeUsefulness;
   outcome: SupportKnowledgeOutcome;
   createdById: string | null;
   createdAt: string;
   page: { id: string; title: string; version: number; status: string };
}

export type SupportKnowledgeGapStatus = 'OPEN' | 'IN_REVIEW' | 'RESOLVED';
export type SupportKnowledgeGapKind = 'MISSING' | 'WRONG';

export interface SupportKnowledgeGap {
   id: string;
   caseId: string;
   knowledgePageId: string | null;
   kind: SupportKnowledgeGapKind;
   status: SupportKnowledgeGapStatus;
   feedback: string;
   reviewOwnerId: string | null;
   createdById: string | null;
   resolvedAt: string | null;
   version: number;
   createdAt: string;
   updatedAt: string;
   case?: { id: string; key: string; title: string; version: number };
   page?: { id: string; title: string; version: number; status: string } | null;
}

export type SupportPageResult<T> = {
   items: T[];
   total?: number;
   visibleCount?: number;
   limit?: number;
   offset?: number;
};
