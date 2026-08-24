import { taskaraRequest } from '@/lib/taskara-client';
import type { SupportCase, SupportCasePriority, SupportCaseSource, SupportCaseStatus } from '@/lib/support-types';
import type {
   CreateSupportEnablementDefinitionInput,
   SupportAssistanceDecision,
   SupportAssistanceKind,
   SupportAssistanceSuggestion,
   SupportAutomationCondition,
   SupportCsatInvitation,
   SupportCsatInvitationCreated,
   SupportEnablementAction,
   SupportEnablementApplication,
   SupportEnablementDefinition,
   SupportEnablementKind,
   SupportEnablementMutation,
   SupportEnablementPreview,
   SupportEnablementStatus,
   SupportKnowledgeGap,
   SupportKnowledgeGapStatus,
   SupportKnowledgeOutcome,
   SupportKnowledgeSearchResult,
   SupportKnowledgeUse,
   SupportKnowledgeUsefulness,
   SupportPageResult,
   SupportProblemCluster,
   SupportProblemClusterStatus,
   SupportQualityCriterion,
   SupportQualityFinding,
   SupportQualityReview,
   SupportQualityRubric,
} from '@/lib/support-maturity-types';

type ListQuery = { limit?: number; offset?: number };
type ClusterQuery = ListQuery & { q?: string; status?: SupportProblemClusterStatus };
type DefinitionQuery = ListQuery & { kind?: SupportEnablementKind; status?: SupportEnablementStatus };
type GapQuery = ListQuery & { status?: SupportKnowledgeGapStatus };

function segment(value: string): string {
   return encodeURIComponent(value);
}

function queryPath(path: string, query: Record<string, string | number | undefined>): string {
   const params = new URLSearchParams();
   for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
   }
   return `${path}${params.size ? `?${params.toString()}` : ''}`;
}

export function supportCaseAssistancePath(idOrKey: string): string {
   return `/support/cases/${segment(idOrKey)}/assistance`;
}

export function supportAssistanceDecisionPath(suggestionId: string): string {
   return `/support/assistance/${segment(suggestionId)}/decide`;
}

export function supportCaseCsatPath(idOrKey: string, invitations = false): string {
   const base = `/support/cases/${segment(idOrKey)}/csat`;
   return invitations ? `${base}/invitations` : base;
}

export function supportQualityRubricsPath(): string {
   return '/support/quality/rubrics';
}

export function supportQualityReviewsPath(): string {
   return '/support/quality/reviews';
}

export function supportEnablementDefinitionsPath(query: DefinitionQuery = {}): string {
   return queryPath('/support/enablement/definitions', query);
}

export function supportEnablementLifecyclePath(id: string, action: 'approve' | 'retire'): string {
   return `/support/enablement/definitions/${segment(id)}/${action}`;
}

export function supportCaseEnablementPath(
   idOrKey: string,
   definitionId: string,
   action: 'preview' | 'apply'
): string {
   return `/support/cases/${segment(idOrKey)}/enablement/${segment(definitionId)}/${action}`;
}

export function supportCaseAutomationEvaluationsPath(idOrKey: string): string {
   return `/support/cases/${segment(idOrKey)}/automation-evaluations`;
}

export function supportEnablementUndoPath(applicationId: string): string {
   return `/support/enablement/applications/${segment(applicationId)}/undo`;
}

export function supportProblemClustersPath(query: ClusterQuery = {}): string {
   return queryPath('/support/problem-clusters', query);
}

export function supportProblemClusterPath(id: string): string {
   return `/support/problem-clusters/${segment(id)}`;
}

export function supportProblemClusterCasePath(clusterId: string, idOrKey: string): string {
   return `${supportProblemClusterPath(clusterId)}/cases/${segment(idOrKey)}`;
}

export function supportCaseKnowledgePath(idOrKey: string, resource: 'search' | 'uses' | 'gaps'): string {
   return `/support/cases/${segment(idOrKey)}/knowledge/${resource}`;
}

export function supportKnowledgeGapsPath(query: GapQuery = {}): string {
   return queryPath('/support/knowledge/gaps', query);
}

export function supportKnowledgeGapPath(id: string): string {
   return `/support/knowledge/gaps/${segment(id)}`;
}

export const supportMaturityClient = {
   listAssistance: async (idOrKey: string) => {
      const result = record(await taskaraRequest<unknown>(supportCaseAssistancePath(idOrKey)));
      return {
         items: array(result.items).map(normalizeSupportAssistanceSuggestion),
         accessEpoch: text(result.accessEpoch),
      };
   },
   decideAssistance: async (
      suggestionId: string,
      input: { decision: 'REJECTED'; reason: string } | { decision: 'ACCEPTED'; reason: string; baseVersion?: number }
   ) => normalizeSupportAssistanceSuggestion(await taskaraRequest<unknown>(supportAssistanceDecisionPath(suggestionId), {
      method: 'POST', body: JSON.stringify(input),
   })),
   getCsat: async (idOrKey: string) => {
      const result = record(await taskaraRequest<unknown>(supportCaseCsatPath(idOrKey)));
      return array(result.items).map(normalizeCsatInvitation);
   },
   inviteCsat: async (idOrKey: string, input: { expiresInDays: number; scaleMin: number; scaleMax: number }) =>
      normalizeCsatCreated(await taskaraRequest<unknown>(supportCaseCsatPath(idOrKey, true), {
         method: 'POST', body: JSON.stringify(input),
      })),
   listRubrics: async () => {
      const result = record(await taskaraRequest<unknown>(supportQualityRubricsPath()));
      return array(result.items).map(normalizeSupportQualityRubric);
   },
   createRubric: async (input: { rubricKey: string; name: string; criteria: SupportQualityCriterion[] }) =>
      normalizeSupportQualityRubric(await taskaraRequest<unknown>(supportQualityRubricsPath(), {
         method: 'POST', body: JSON.stringify(input),
      })),
   listReviews: async () => {
      const result = record(await taskaraRequest<unknown>(supportQualityReviewsPath()));
      return array(result.items).map(normalizeSupportQualityReview);
   },
   createReview: async (input: {
      caseId: string;
      rubricId: string;
      sampleReason: string;
      findings: SupportQualityFinding[];
   }) => normalizeSupportQualityReview(await taskaraRequest<unknown>(supportQualityReviewsPath(), {
      method: 'POST', body: JSON.stringify(input),
   })),
   listDefinitions: async (query: DefinitionQuery = {}) => {
      const result = record(await taskaraRequest<unknown>(supportEnablementDefinitionsPath(query)));
      return {
         items: array(result.items).map(normalizeSupportEnablementDefinition),
         total: integer(result.total), limit: integer(result.limit), offset: integer(result.offset),
      };
   },
   createDefinition: async (input: CreateSupportEnablementDefinitionInput) =>
      normalizeSupportEnablementDefinition(await taskaraRequest<unknown>(supportEnablementDefinitionsPath(), {
         method: 'POST', body: JSON.stringify(input),
      })),
   approveDefinition: async (id: string) => normalizeSupportEnablementDefinition(
      await taskaraRequest<unknown>(supportEnablementLifecyclePath(id, 'approve'), { method: 'POST' })
   ),
   retireDefinition: async (id: string) => normalizeSupportEnablementDefinition(
      await taskaraRequest<unknown>(supportEnablementLifecyclePath(id, 'retire'), { method: 'POST' })
   ),
   previewDefinition: async (idOrKey: string, definitionId: string, baseVersion: number) =>
      normalizeSupportEnablementPreview(await taskaraRequest<unknown>(supportCaseEnablementPath(idOrKey, definitionId, 'preview'), {
         method: 'POST', body: JSON.stringify({ baseVersion }),
      })),
   evaluateAutomations: async (idOrKey: string, baseVersion: number) => {
      const result = record(await taskaraRequest<unknown>(supportCaseAutomationEvaluationsPath(idOrKey), {
         method: 'POST', body: JSON.stringify({ baseVersion }),
      }));
      return {
         items: array(result.items).map(normalizeSupportEnablementPreview),
         matchedCount: integer(result.matchedCount),
         requiresHumanApply: true as const,
         caseVersion: integer(result.caseVersion),
      };
   },
   applyDefinition: async (idOrKey: string, definitionId: string, input: { baseVersion: number; previewHash: string }) =>
      normalizeSupportEnablementMutation(await taskaraRequest<unknown>(supportCaseEnablementPath(idOrKey, definitionId, 'apply'), {
         method: 'POST', body: JSON.stringify(input),
      })),
   undoApplication: async (applicationId: string, baseVersion: number) => normalizeSupportEnablementMutation(
      await taskaraRequest<unknown>(supportEnablementUndoPath(applicationId), {
         method: 'POST', body: JSON.stringify({ baseVersion }),
      })
   ),
   listClusters: async (query: ClusterQuery = {}): Promise<SupportPageResult<SupportProblemCluster>> => {
      const result = record(await taskaraRequest<unknown>(supportProblemClustersPath(query)));
      return {
         items: array(result.items).map(normalizeSupportProblemCluster),
         total: integer(result.total), limit: integer(result.limit), offset: integer(result.offset),
      };
   },
   getCluster: async (id: string) => normalizeSupportProblemCluster(
      await taskaraRequest<unknown>(supportProblemClusterPath(id))
   ),
   createCluster: async (input: { title: string; summary?: string }) => normalizeSupportProblemCluster(
      await taskaraRequest<unknown>(supportProblemClustersPath(), {
         method: 'POST', body: JSON.stringify(input),
      })
   ),
   updateCluster: async (id: string, input: {
      baseVersion: number;
      title?: string;
      summary?: string | null;
      status?: SupportProblemClusterStatus;
   }) => normalizeSupportProblemCluster(await taskaraRequest<unknown>(supportProblemClusterPath(id), {
      method: 'PATCH', body: JSON.stringify(input),
   })),
   linkClusterCase: async (clusterId: string, idOrKey: string, input: { clusterBaseVersion: number; caseBaseVersion: number }) =>
      normalizeSupportProblemCluster(await taskaraRequest<unknown>(supportProblemClusterCasePath(clusterId, idOrKey), {
         method: 'POST', body: JSON.stringify(input),
      })),
   unlinkClusterCase: (clusterId: string, idOrKey: string, input: { clusterBaseVersion: number; caseBaseVersion: number }) =>
      taskaraRequest<void>(supportProblemClusterCasePath(clusterId, idOrKey), {
         method: 'DELETE', body: JSON.stringify(input),
      }),
   searchKnowledge: async (idOrKey: string, q: string, limit = 20, offset = 0) =>
      normalizeSupportKnowledgeSearch(await taskaraRequest<unknown>(
         queryPath(supportCaseKnowledgePath(idOrKey, 'search'), { q, limit, offset })
      )),
   listKnowledgeUses: async (idOrKey: string) => {
      const result = record(await taskaraRequest<unknown>(supportCaseKnowledgePath(idOrKey, 'uses')));
      return array(result.items).map(normalizeSupportKnowledgeUse);
   },
   recordKnowledgeUse: async (idOrKey: string, input: {
      pageId: string;
      caseBaseVersion: number;
      usefulness: SupportKnowledgeUsefulness;
      outcome: SupportKnowledgeOutcome;
   }) => normalizeSupportKnowledgeUse(await taskaraRequest<unknown>(supportCaseKnowledgePath(idOrKey, 'uses'), {
      method: 'POST', body: JSON.stringify(input),
   })),
   createKnowledgeGap: async (idOrKey: string, input:
      | { kind: 'MISSING'; caseBaseVersion: number; feedback: string }
      | { kind: 'WRONG'; pageId: string; caseBaseVersion: number; feedback: string }
   ) => normalizeSupportKnowledgeGap(await taskaraRequest<unknown>(supportCaseKnowledgePath(idOrKey, 'gaps'), {
      method: 'POST', body: JSON.stringify(input),
   })),
   listKnowledgeGaps: async (query: GapQuery = {}): Promise<SupportPageResult<SupportKnowledgeGap>> => {
      const result = record(await taskaraRequest<unknown>(supportKnowledgeGapsPath(query)));
      return {
         items: array(result.items).map(normalizeSupportKnowledgeGap),
         visibleCount: integer(result.visibleCount), limit: integer(result.limit), offset: integer(result.offset),
      };
   },
   updateKnowledgeGap: async (id: string, input: {
      baseVersion: number;
      status?: SupportKnowledgeGapStatus;
      reviewOwnerId?: string | null;
   }) => normalizeSupportKnowledgeGap(await taskaraRequest<unknown>(supportKnowledgeGapPath(id), {
      method: 'PATCH', body: JSON.stringify(input),
   })),
};

export function normalizeSupportAssistanceSuggestion(value: unknown): SupportAssistanceSuggestion {
   const item = record(value);
   const kind = enumValue(item.kind, ['TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE', 'SUMMARY', 'REPLY', 'KNOWLEDGE'] as const);
   const payload = normalizeAssistancePayload(kind, item.payload);
   const provenance = record(item.provenance);
   const base = {
      id: text(item.id), caseId: text(item.caseId),
      provenance: {
         provider: text(provenance.provider), modelOrRule: text(provenance.modelOrRule),
         version: text(provenance.version), confidence: finiteNumber(provenance.confidence),
         contextDigest: text(provenance.contextDigest),
      },
      decision: enumValue(item.decision, ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const),
      decisionReason: optionalText(item.decisionReason),
      decisionCaseVersion: optionalInteger(item.decisionCaseVersion),
      decidedAt: optionalDateText(item.decidedAt), expiresAt: optionalDateText(item.expiresAt),
      createdAt: dateText(item.createdAt),
   };
   return { ...base, kind, payload } as SupportAssistanceSuggestion;
}

export function normalizeSupportProblemCluster(value: unknown): SupportProblemCluster {
   const item = record(value);
   const cases = Array.isArray(item.cases)
      ? item.cases.map((rawCase) => {
           const supportCase = record(rawCase);
           return {
              id: text(supportCase.id), key: text(supportCase.key), title: text(supportCase.title),
              status: enumValue(supportCase.status, ['NEW', 'OPEN', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'RESOLVED', 'CLOSED'] as const),
              priority: enumValue(supportCase.priority, ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const),
              departmentId: optionalText(supportCase.departmentId),
              assigneeMembershipId: optionalText(supportCase.assigneeMembershipId),
              version: integer(supportCase.version), updatedAt: dateText(supportCase.updatedAt),
              linkedAt: dateText(supportCase.linkedAt),
           };
        })
      : undefined;
   return {
      id: text(item.id), title: text(item.title), summary: optionalText(item.summary),
      status: enumValue(item.status, ['OPEN', 'RESOLVED', 'ARCHIVED'] as const),
      version: integer(item.version), createdById: optionalText(item.createdById),
      createdAt: dateText(item.createdAt), updatedAt: dateText(item.updatedAt),
      visibleMemberCount: integer(item.visibleMemberCount),
      ...(cases ? { cases } : {}),
      ...(item.accessEpoch !== undefined ? { accessEpoch: text(item.accessEpoch) } : {}),
   };
}

export function normalizeSupportQualityReview(value: unknown): SupportQualityReview {
   const item = record(value);
   const supportCase = record(item.case);
   const rubric = record(item.rubric);
   return {
      id: text(item.id), caseId: text(item.caseId), rubricId: text(item.rubricId),
      rubricVersion: integer(item.rubricVersion), departmentId: text(item.departmentId),
      assigneeUserId: optionalText(item.assigneeUserId), reviewerId: optionalText(item.reviewerId),
      reviewerKind: item.reviewerKind === null || item.reviewerKind === undefined
         ? null : enumValue(item.reviewerKind, ['HUMAN', 'AGENT'] as const),
      sampleReason: text(item.sampleReason), score: integer(item.score),
      findings: array(item.findings).map(normalizeFinding),
      completedAt: dateText(item.completedAt), createdAt: dateText(item.createdAt),
      case: { id: text(supportCase.id), key: text(supportCase.key), title: text(supportCase.title) },
      rubric: {
         id: text(rubric.id), rubricKey: text(rubric.rubricKey), name: text(rubric.name), version: integer(rubric.version),
      },
      reviewer: personSummary(item.reviewer), assignee: personSummary(item.assignee),
   };
}

export function normalizeSupportKnowledgeSearch(value: unknown): SupportKnowledgeSearchResult {
   const result = record(value);
   const supportCase = record(result.case);
   return {
      items: array(result.items).map((rawPage) => {
         const page = record(rawPage);
         return {
            id: text(page.id), title: text(page.title), path: text(page.path),
            summary: optionalText(page.summary), status: enumValue(page.status, ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const),
            version: integer(page.version), updatedAt: dateText(page.updatedAt),
         };
      }),
      total: integer(result.total), limit: integer(result.limit), offset: integer(result.offset),
      case: { id: text(supportCase.id), key: text(supportCase.key), version: integer(supportCase.version) },
      accessDoesNotTransfer: true,
   };
}

function normalizeCsatInvitation(value: unknown): SupportCsatInvitation {
   const item = record(value);
   const response = item.response === null || item.response === undefined ? null : record(item.response);
   return {
      id: text(item.id), scaleMin: integer(item.scaleMin), scaleMax: integer(item.scaleMax),
      expiresAt: dateText(item.expiresAt), consumedAt: optionalDateText(item.consumedAt),
      invalidatedAt: optionalDateText(item.invalidatedAt), createdAt: dateText(item.createdAt),
      response: response ? {
         score: integer(response.score), comment: optionalText(response.comment), submittedAt: dateText(response.submittedAt),
      } : null,
   };
}

function normalizeCsatCreated(value: unknown): SupportCsatInvitationCreated {
   const item = record(value);
   return {
      id: text(item.id), scaleMin: integer(item.scaleMin), scaleMax: integer(item.scaleMax),
      expiresAt: dateText(item.expiresAt), createdAt: dateText(item.createdAt), token: text(item.token),
   };
}

function normalizeSupportQualityRubric(value: unknown): SupportQualityRubric {
   const item = record(value);
   return {
      id: text(item.id), rubricKey: text(item.rubricKey), name: text(item.name),
      version: integer(item.version), criteria: array(item.criteria).map(normalizeCriterion),
      createdById: optionalText(item.createdById), createdAt: dateText(item.createdAt),
   };
}

function normalizeCriterion(value: unknown): SupportQualityCriterion {
   const item = record(value);
   return { key: text(item.key), label: text(item.label), maxScore: integer(item.maxScore), weight: integer(item.weight) };
}

function normalizeFinding(value: unknown): SupportQualityFinding {
   const item = record(value);
   return {
      criterionKey: text(item.criterionKey), score: integer(item.score),
      ...(optionalText(item.finding) ? { finding: optionalText(item.finding)! } : {}),
   };
}

function normalizeSupportEnablementDefinition(value: unknown): SupportEnablementDefinition {
   const item = record(value);
   return {
      id: text(item.id), kind: enumValue(item.kind, ['MACRO', 'TEMPLATE', 'AUTOMATION'] as const),
      definitionKey: text(item.definitionKey), version: integer(item.version), name: text(item.name),
      description: optionalText(item.description), status: enumValue(item.status, ['DRAFT', 'APPROVED', 'RETIRED'] as const),
      conditions: item.conditions === null || item.conditions === undefined
         ? null : array(item.conditions).map(normalizeCondition),
      actions: array(item.actions).map(normalizeAction),
      createdById: optionalText(item.createdById), approvedById: optionalText(item.approvedById),
      approvedAt: optionalDateText(item.approvedAt), retiredById: optionalText(item.retiredById),
      retiredAt: optionalDateText(item.retiredAt), createdAt: dateText(item.createdAt),
   };
}

function normalizeAction(value: unknown): SupportEnablementAction {
   const item = record(value);
   const type = enumValue(item.type, ['SET_PRIORITY', 'SET_IMPACT', 'SET_URGENCY', 'SET_TYPE_KEY', 'SET_NEXT_ACTION_AT', 'CLEAR_NEXT_ACTION'] as const);
   if (type === 'CLEAR_NEXT_ACTION') return { type };
   if (type === 'SET_PRIORITY') return { type, value: enumValue(item.value, ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const) };
   if (type === 'SET_IMPACT' || type === 'SET_URGENCY') {
      return { type, value: item.value === null ? null : enumValue(item.value, ['LOW', 'MEDIUM', 'HIGH'] as const) };
   }
   return { type, value: text(item.value) } as SupportEnablementAction;
}

function normalizeCondition(value: unknown): SupportAutomationCondition {
   const item = record(value);
   const field = enumValue(item.field, ['PRIORITY', 'IMPACT', 'URGENCY', 'STATUS', 'SOURCE_CHANNEL', 'TYPE_KEY', 'DEPARTMENT_ASSIGNED'] as const);
   if (field === 'DEPARTMENT_ASSIGNED') return { field, value: Boolean(item.value) };
   if (field === 'PRIORITY') return { field, value: enumValue(item.value, ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const) };
   if (field === 'IMPACT' || field === 'URGENCY') return { field, value: enumValue(item.value, ['LOW', 'MEDIUM', 'HIGH'] as const) };
   if (field === 'STATUS') return { field, value: enumValue(item.value, ['NEW', 'OPEN', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'RESOLVED', 'CLOSED'] as const) };
   if (field === 'SOURCE_CHANNEL') return { field, value: enumValue(item.value, ['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING'] as const) };
   return { field, value: text(item.value) };
}

function normalizeSupportEnablementPreview(value: unknown): SupportEnablementPreview {
   const item = record(value);
   const supportCase = record(item.case);
   return {
      definition: normalizeSupportEnablementDefinition(item.definition),
      case: { id: text(supportCase.id), key: text(supportCase.key), version: integer(supportCase.version) },
      conditionMatched: Boolean(item.conditionMatched),
      conditionResults: array(item.conditionResults).map((rawResult) => {
         const result = record(rawResult);
         return {
            field: enumValue(result.field, ['PRIORITY', 'IMPACT', 'URGENCY', 'STATUS', 'SOURCE_CHANNEL', 'TYPE_KEY', 'DEPARTMENT_ASSIGNED'] as const),
            matched: Boolean(result.matched),
         };
      }),
      changes: array(item.changes).map((rawChange) => {
         const change = record(rawChange);
         return {
            field: text(change.field), before: scalarOrNull(change.before), after: scalarOrNull(change.after),
         };
      }),
      previewHash: text(item.previewHash), canApply: Boolean(item.canApply), requiresHumanApply: true,
   };
}

function normalizeSupportEnablementMutation(value: unknown): SupportEnablementMutation {
   const item = record(value);
   return {
      application: normalizeApplication(item.application),
      case: record(item.case) as unknown as SupportCase,
   };
}

function normalizeApplication(value: unknown): SupportEnablementApplication {
   const item = record(value);
   return {
      id: text(item.id), definitionId: text(item.definitionId), caseId: text(item.caseId),
      caseVersionBefore: integer(item.caseVersionBefore), caseVersionAfter: integer(item.caseVersionAfter),
      previewHash: text(item.previewHash), appliedAt: dateText(item.appliedAt),
      undoneAt: optionalDateText(item.undoneAt), undoCaseVersion: optionalInteger(item.undoCaseVersion),
   };
}

function normalizeSupportKnowledgeUse(value: unknown): SupportKnowledgeUse {
   const item = record(value);
   const page = record(item.page);
   return {
      id: text(item.id), caseId: text(item.caseId), knowledgePageId: text(item.knowledgePageId),
      caseVersion: integer(item.caseVersion), knowledgePageVersion: integer(item.knowledgePageVersion),
      usefulness: enumValue(item.usefulness, ['HELPFUL', 'PARTIAL', 'NOT_HELPFUL'] as const),
      outcome: enumValue(item.outcome, ['RESOLVED', 'ADVANCED', 'NO_EFFECT'] as const),
      createdById: optionalText(item.createdById), createdAt: dateText(item.createdAt),
      page: { id: text(page.id), title: text(page.title), version: integer(page.version), status: text(page.status) },
   };
}

function normalizeSupportKnowledgeGap(value: unknown): SupportKnowledgeGap {
   const item = record(value);
   const supportCase = item.case === undefined ? undefined : record(item.case);
   const page = item.page === undefined || item.page === null ? item.page : record(item.page);
   return {
      id: text(item.id), caseId: text(item.caseId), knowledgePageId: optionalText(item.knowledgePageId),
      kind: enumValue(item.kind, ['MISSING', 'WRONG'] as const),
      status: enumValue(item.status, ['OPEN', 'IN_REVIEW', 'RESOLVED'] as const),
      feedback: text(item.feedback), reviewOwnerId: optionalText(item.reviewOwnerId),
      createdById: optionalText(item.createdById), resolvedAt: optionalDateText(item.resolvedAt),
      version: integer(item.version), createdAt: dateText(item.createdAt), updatedAt: dateText(item.updatedAt),
      ...(supportCase ? { case: {
         id: text(supportCase.id), key: text(supportCase.key), title: text(supportCase.title), version: integer(supportCase.version),
      } } : {}),
      ...(page === null ? { page: null } : page ? { page: {
         id: text(page.id), title: text(page.title), version: integer(page.version), status: text(page.status),
      } } : {}),
   };
}

function normalizeAssistancePayload(kind: SupportAssistanceKind, value: unknown): SupportAssistanceSuggestion['payload'] {
   const payload = record(value);
   if (kind === 'TYPE') return { typeKey: text(payload.typeKey) };
   if (kind === 'PRIORITY') return { priority: enumValue(payload.priority, ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const) };
   if (kind === 'DEPARTMENT') return { departmentId: text(payload.departmentId) };
   if (kind === 'DUPLICATE') return { caseId: text(payload.caseId) };
   if (kind === 'SUMMARY' || kind === 'REPLY') return { text: text(payload.text) };
   return {
      references: array(payload.references).map((rawReference) => {
         const reference = record(rawReference);
         return {
            pageId: text(reference.pageId), title: text(reference.title),
            ...(optionalText(reference.reason) ? { reason: optionalText(reference.reason)! } : {}),
         };
      }),
   };
}

function personSummary(value: unknown): { id: string; name: string } | null {
   if (value === null || value === undefined) return null;
   const item = record(value);
   return { id: text(item.id), name: text(item.name) };
}

function record(value: unknown): Record<string, unknown> {
   return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
   return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
   return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function optionalText(value: unknown): string | null {
   return typeof value === 'string' && value ? value : null;
}

function dateText(value: unknown): string {
   if (value instanceof Date) return value.toISOString();
   return text(value);
}

function optionalDateText(value: unknown): string | null {
   if (value instanceof Date) return value.toISOString();
   return optionalText(value);
}

function integer(value: unknown): number {
   const number = typeof value === 'number' ? value : Number(value);
   return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function optionalInteger(value: unknown): number | null {
   return value === null || value === undefined ? null : integer(value);
}

function finiteNumber(value: unknown): number {
   const number = typeof value === 'number' ? value : Number(value);
   return Number.isFinite(number) ? number : 0;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
   const normalized = text(value);
   if ((allowed as readonly string[]).includes(normalized)) return normalized as T[number];
   throw new Error(`Unsupported Support API value: ${normalized || '(empty)'}`);
}

function scalarOrNull(value: unknown): string | number | null {
   return typeof value === 'string' || typeof value === 'number' ? value : null;
}

// Keep the imported wire unions tied to the normalizers above.
type _WireUnions = SupportCasePriority | SupportCaseSource | SupportCaseStatus | SupportAssistanceDecision;
void (0 as unknown as _WireUnions);
