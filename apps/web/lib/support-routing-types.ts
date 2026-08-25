import type {
   SupportCase,
   SupportCasePriority,
   SupportCaseSource,
   SupportDepartment,
   SupportPersonSummary,
} from '@/lib/support-types';

export const supportRoutingAssignmentModes = ['DEPARTMENT_INBOX', 'CAPACITY_AWARE'] as const;
export type SupportRoutingAssignmentMode = (typeof supportRoutingAssignmentModes)[number];

export interface SupportRoutingConditions {
   caseTypeKeys: string[];
   priorities: SupportCasePriority[];
   sourceChannels: SupportCaseSource[];
   impacts: Array<'LOW' | 'MEDIUM' | 'HIGH'>;
   urgencies: Array<'LOW' | 'MEDIUM' | 'HIGH'>;
}

export interface SupportRoutingAction {
   targetDepartmentId: string;
   assignmentMode: SupportRoutingAssignmentMode;
   requiredSkills: string[];
}

export interface SupportRoutingRule {
   id: string;
   order: number;
   name: string;
   enabled: boolean;
   conditions: SupportRoutingConditions;
   action: SupportRoutingAction;
   targetDepartment: Pick<SupportDepartment, 'id' | 'name' | 'slug' | 'active'>;
   createdAt: string;
}

export interface SupportRoutingPolicy {
   id: string;
   workspaceId: string;
   version: number;
   label: string | null;
   active: boolean;
   createdById: string | null;
   activatedById: string | null;
   activatedAt: string | null;
   createdAt: string;
   rules: SupportRoutingRule[];
}

export interface CreateSupportRoutingPolicyInput {
   label?: string;
   activate?: boolean;
   rules: Array<{
      order: number;
      name: string;
      enabled?: boolean;
      conditions: SupportRoutingConditions;
      action: SupportRoutingAction;
   }>;
}

export interface SupportRoutingMember {
   membershipId: string;
   workspaceId: string;
   departmentId: string;
   userId: string;
   role: 'MEMBER' | 'MANAGER';
   active: boolean;
   routingAvailability: 'UNAVAILABLE' | 'AVAILABLE';
   routingCapacity: number;
   routingSkills: string[];
   activeCaseLoad: number;
   availableSlots: number;
   updatedAt: string;
   user: SupportPersonSummary;
}

export interface SupportPrioritySuggestion {
   method: 'IMPACT_BY_URGENCY';
   suggestedPriority: SupportCasePriority | null;
   available: boolean;
   requiresHumanDecision: true;
}

export type SupportRoutingFallbackReason =
   | 'NO_ACTIVE_POLICY'
   | 'NO_MATCHING_RULE'
   | 'TARGET_DEPARTMENT_UNAVAILABLE'
   | null;

export interface SupportRoutingAssignmentExplanation {
   mode: SupportRoutingAssignmentMode;
   result: 'DEPARTMENT_INBOX' | 'MEMBER_SELECTED' | 'NO_ELIGIBLE_MEMBER_DEPARTMENT_INBOX';
   selectionAlgorithm: 'LOWEST_UTILIZATION_THEN_LOAD_THEN_MEMBERSHIP_ID' | null;
   capacityDetailsRedacted: boolean;
   consideredMemberCount?: number;
   eligibleMemberCount?: number;
   selectedMember?: {
      membershipId: string;
      userId?: string;
      activeCaseLoad: number;
      capacity: number;
      availableSlots: number;
      skills: string[];
   } | null;
}

export interface SupportRoutingDecision {
   explanationVersion: 1;
   outcome: 'ROUTE' | 'TRIAGE';
   case: {
      id: string;
      key: string;
      version: number;
      typeKey: string;
      priority: SupportCasePriority;
      sourceChannel: SupportCaseSource;
      impact: 'LOW' | 'MEDIUM' | 'HIGH' | null;
      urgency: 'LOW' | 'MEDIUM' | 'HIGH' | null;
   };
   policy: { id: string; version: number; label: string | null } | null;
   evaluatedRules: Array<{
      ruleId: string;
      order: number;
      name: string;
      result: 'DISABLED' | 'NO_MATCH' | 'MATCH';
      mismatches: Array<'CASE_TYPE' | 'PRIORITY' | 'SOURCE_CHANNEL' | 'IMPACT_MISSING' | 'IMPACT' | 'URGENCY_MISSING' | 'URGENCY'>;
   }>;
   matchedRule: { id: string; order: number; name: string } | null;
   fallbackReason: SupportRoutingFallbackReason;
   route: {
      departmentId: string;
      departmentName: string | null;
      assignment: SupportRoutingAssignmentExplanation | null;
   } | null;
   prioritySuggestion: SupportPrioritySuggestion;
   decisionFingerprint: string;
}

export type SupportRoutingApplyResult = SupportRoutingDecision & {
   applied: true;
   caseVersion: number;
} | {
   outcome: 'ROUTED';
   applied: true;
   case: Pick<SupportCase, 'id' | 'key' | 'version' | 'status' | 'departmentId'> & {
      assigneeMembershipId?: string | null;
   };
   policy: { id?: string; version?: number };
   matchedRule: { id: string; order: number; name: string };
   assignment: SupportRoutingAssignmentExplanation | null;
   decisionFingerprint: string;
   prioritySuggestion: SupportPrioritySuggestion;
   accessEpoch: string;
};

export interface SupportPriorityDecisionResult {
   case: SupportCase;
   priorityDecision: {
      decision: 'ACCEPT_SUGGESTION' | 'OVERRIDE';
      suggestion: SupportCasePriority | null;
      appliedPriority: SupportCasePriority;
   };
}
