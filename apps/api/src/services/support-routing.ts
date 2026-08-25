import { createHash } from 'node:crypto';
import {
  Prisma,
  prisma,
  type SupportCaseImpact,
  type SupportCasePriority,
  type SupportCaseSourceChannel,
  type SupportCaseUrgency,
  type SupportRoutingAssignmentMode
} from '@taskara/db';
import { z } from 'zod';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import {
  assertCanConfigureSupport,
  assertCanTriage,
  assertCanWorkCase,
  canReadSupportCase,
  resolveSupportAccess,
  type SupportAccess
} from './support-access';
import {
  appendSupportCaseEvent,
  caseEventSnapshot,
  findSupportCaseForAccess,
  routeSupportCase,
  serializeSupportCase,
  supportCaseInclude,
  type SupportCaseView
} from './support-cases';
import { appendSupportCaseSyncEvent } from './support-sync';
import { assertSupportWorkspace } from './workspace-mode';

const supportPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const supportSources = ['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING'] as const;
const supportImpacts = ['LOW', 'MEDIUM', 'HIGH'] as const;
const supportUrgencies = ['LOW', 'MEDIUM', 'HIGH'] as const;
const routingAssignmentModes = ['DEPARTMENT_INBOX', 'CAPACITY_AWARE'] as const;
const nonTerminalStatuses = ['NEW', 'OPEN', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL'] as const;

const caseTypeKeySchema = z.string().trim().toLowerCase().min(1).max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);
const routingSkillSchema = z.string().trim().toLowerCase().min(1).max(64)
  .regex(/^[a-z][a-z0-9:_-]*$/);

function uniqueArray<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.array(item).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Values must be unique' });
    }
  });
}

export const supportRoutingConditionsSchema = z.object({
  caseTypeKeys: uniqueArray(caseTypeKeySchema, 64).default([]),
  priorities: uniqueArray(z.enum(supportPriorities), supportPriorities.length).default([]),
  sourceChannels: uniqueArray(z.enum(supportSources), supportSources.length).default([]),
  impacts: uniqueArray(z.enum(supportImpacts), supportImpacts.length).default([]),
  urgencies: uniqueArray(z.enum(supportUrgencies), supportUrgencies.length).default([])
}).strict();

export const supportRoutingActionSchema = z.object({
  targetDepartmentId: z.string().uuid(),
  assignmentMode: z.enum(routingAssignmentModes).default('DEPARTMENT_INBOX'),
  requiredSkills: uniqueArray(routingSkillSchema, 64).default([])
}).strict().superRefine((action, context) => {
  if (action.assignmentMode === 'DEPARTMENT_INBOX' && action.requiredSkills.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requiredSkills'],
      message: 'Skills only apply to capacity-aware assignment'
    });
  }
});

export const createSupportRoutingPolicySchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  activate: z.boolean().default(false),
  rules: z.array(z.object({
    order: z.number().int().positive().max(10_000),
    name: z.string().trim().min(1).max(160),
    enabled: z.boolean().default(true),
    conditions: supportRoutingConditionsSchema.default({}),
    action: supportRoutingActionSchema
  }).strict()).min(1).max(200)
}).strict().superRefine((input, context) => {
  const orders = input.rules.map((rule) => rule.order);
  if (new Set(orders).size !== orders.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rules'],
      message: 'Routing rule order values must be unique'
    });
  }
  if (!input.rules.some((rule) => rule.enabled)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rules'],
      message: 'A routing policy needs at least one enabled rule'
    });
  }
});

export const updateSupportRoutingMemberSchema = z.object({
  routingAvailability: z.enum(['UNAVAILABLE', 'AVAILABLE']).optional(),
  routingCapacity: z.number().int().min(0).max(1000).optional(),
  routingSkills: uniqueArray(routingSkillSchema, 64).optional()
}).strict().refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: 'At least one routing member field is required'
});

export const supportRoutingSimulationSchema = z.object({
  baseVersion: z.number().int().positive()
}).strict();

export const applySupportRoutingSchema = supportRoutingSimulationSchema;

export const decideSupportPrioritySchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('ACCEPT_SUGGESTION'),
    baseVersion: z.number().int().positive()
  }).strict(),
  z.object({
    decision: z.literal('OVERRIDE'),
    priority: z.enum(supportPriorities),
    reason: z.string().trim().min(3).max(1000),
    baseVersion: z.number().int().positive()
  }).strict()
]);

export type CreateSupportRoutingPolicyInput = z.infer<typeof createSupportRoutingPolicySchema>;
export type UpdateSupportRoutingMemberInput = z.infer<typeof updateSupportRoutingMemberSchema>;
export type SupportRoutingSimulationInput = z.infer<typeof supportRoutingSimulationSchema>;
export type DecideSupportPriorityInput = z.infer<typeof decideSupportPrioritySchema>;

const routingPolicyInclude = {
  rules: {
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    include: {
      targetDepartment: {
        select: { id: true, name: true, slug: true, active: true }
      }
    }
  }
} satisfies Prisma.SupportRoutingPolicyInclude;

type RoutingPolicyView = Prisma.SupportRoutingPolicyGetPayload<{
  include: typeof routingPolicyInclude;
}>;
type RoutingRuleView = RoutingPolicyView['rules'][number];

export interface SupportRoutingCaseFacts {
  id: string;
  key: string;
  version: number;
  typeKey: string;
  priority: SupportCasePriority;
  sourceChannel: SupportCaseSourceChannel;
  impact: SupportCaseImpact | null;
  urgency: SupportCaseUrgency | null;
}

export interface CapacityRoutingCandidate {
  membershipId: string;
  userId?: string;
  active: boolean;
  available: boolean;
  capacity: number;
  activeCaseLoad: number;
  skills: readonly string[];
}

type RuleMismatch =
  | 'CASE_TYPE'
  | 'PRIORITY'
  | 'SOURCE_CHANNEL'
  | 'IMPACT_MISSING'
  | 'IMPACT'
  | 'URGENCY_MISSING'
  | 'URGENCY';

interface InternalRoutingDecision {
  outcome: 'ROUTE' | 'TRIAGE';
  caseFacts: SupportRoutingCaseFacts;
  access: SupportAccess;
  policy: RoutingPolicyView | null;
  evaluations: Array<{
    ruleId: string;
    order: number;
    name: string;
    result: 'DISABLED' | 'NO_MATCH' | 'MATCH';
    mismatches: RuleMismatch[];
  }>;
  matchedRule: RoutingRuleView | null;
  fallbackReason: 'NO_ACTIVE_POLICY' | 'NO_MATCHING_RULE' | 'TARGET_DEPARTMENT_UNAVAILABLE' | null;
  targetDepartmentId: string | null;
  targetDepartmentName: string | null;
  assignmentMode: SupportRoutingAssignmentMode | null;
  targetAssigneeMembershipId: string | null;
  candidates: CapacityRoutingCandidate[];
  selectedCandidate: CapacityRoutingCandidate | null;
  assignmentResult: 'DEPARTMENT_INBOX' | 'MEMBER_SELECTED' | 'NO_ELIGIBLE_MEMBER_DEPARTMENT_INBOX' | null;
  decisionFingerprint: string;
}

export function suggestSupportPriority(
  impact: SupportCaseImpact | null,
  urgency: SupportCaseUrgency | null
): SupportCasePriority | null {
  if (!impact || !urgency) return null;
  const matrix: Record<SupportCaseImpact, Record<SupportCaseUrgency, SupportCasePriority>> = {
    LOW: { LOW: 'LOW', MEDIUM: 'NORMAL', HIGH: 'HIGH' },
    MEDIUM: { LOW: 'NORMAL', MEDIUM: 'HIGH', HIGH: 'URGENT' },
    HIGH: { LOW: 'HIGH', MEDIUM: 'URGENT', HIGH: 'URGENT' }
  };
  return matrix[impact][urgency];
}

/** All non-empty condition dimensions must match. Empty arrays are explicit wildcards. */
export function supportRoutingRuleMismatches(
  facts: Pick<SupportRoutingCaseFacts, 'typeKey' | 'priority' | 'sourceChannel' | 'impact' | 'urgency'>,
  rule: Pick<RoutingRuleView, 'caseTypeKeys' | 'priorities' | 'sourceChannels' | 'impacts' | 'urgencies'>
): RuleMismatch[] {
  const mismatches: RuleMismatch[] = [];
  if (rule.caseTypeKeys.length && !rule.caseTypeKeys.includes(facts.typeKey)) {
    mismatches.push('CASE_TYPE');
  }
  if (rule.priorities.length && !rule.priorities.includes(facts.priority)) {
    mismatches.push('PRIORITY');
  }
  if (rule.sourceChannels.length && !rule.sourceChannels.includes(facts.sourceChannel)) {
    mismatches.push('SOURCE_CHANNEL');
  }
  if (rule.impacts.length) {
    if (!facts.impact) mismatches.push('IMPACT_MISSING');
    else if (!rule.impacts.includes(facts.impact)) mismatches.push('IMPACT');
  }
  if (rule.urgencies.length) {
    if (!facts.urgency) mismatches.push('URGENCY_MISSING');
    else if (!rule.urgencies.includes(facts.urgency)) mismatches.push('URGENCY');
  }
  return mismatches;
}

/**
 * Selects the lowest utilization ratio without floating-point arithmetic. Remaining ties use load,
 * then the opaque membership UUID, so every process returns the same member for one DB snapshot.
 */
export function selectCapacityAwareMember(
  candidates: readonly CapacityRoutingCandidate[],
  requiredSkills: readonly string[]
): CapacityRoutingCandidate | null {
  const required = new Set(requiredSkills.map(normalizeSkill));
  const eligible = candidates.filter((candidate) => {
    if (!candidate.active || !candidate.available || candidate.capacity <= candidate.activeCaseLoad) {
      return false;
    }
    const candidateSkills = new Set(candidate.skills.map(normalizeSkill));
    return [...required].every((skill) => candidateSkills.has(skill));
  });
  eligible.sort((left, right) => {
    const utilizationComparison = (left.activeCaseLoad * right.capacity)
      - (right.activeCaseLoad * left.capacity);
    if (utilizationComparison !== 0) return utilizationComparison;
    if (left.activeCaseLoad !== right.activeCaseLoad) {
      return left.activeCaseLoad - right.activeCaseLoad;
    }
    return left.membershipId.localeCompare(right.membershipId);
  });
  return eligible[0] ?? null;
}

export async function listSupportRoutingPolicies(actor: RequestActor) {
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const policies = await prisma.supportRoutingPolicy.findMany({
    where: { workspaceId: actor.workspace.id },
    orderBy: { version: 'desc' },
    include: routingPolicyInclude
  });
  return { items: policies.map(serializeRoutingPolicy) };
}

export async function createSupportRoutingPolicyVersion(
  actor: RequestActor,
  rawInput: CreateSupportRoutingPolicyInput
) {
  const input = createSupportRoutingPolicySchema.parse(rawInput);
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  const departmentIds = [...new Set(input.rules.map((rule) => rule.action.targetDepartmentId))];

  return prisma.$transaction(async (tx) => {
    await lockRoutingPolicyVersions(tx, actor.workspace.id);
    const departments = await tx.department.findMany({
      where: {
        workspaceId: actor.workspace.id,
        id: { in: departmentIds },
        active: true
      },
      select: { id: true }
    });
    if (departments.length !== departmentIds.length) {
      throw new HttpError(400, 'Every routing target must be an active Department in this workspace');
    }

    const latest = await tx.supportRoutingPolicy.aggregate({
      where: { workspaceId: actor.workspace.id },
      _max: { version: true }
    });
    const version = (latest._max.version ?? 0) + 1;
    const activatedAt = input.activate ? new Date() : null;
    if (input.activate) {
      await tx.supportRoutingPolicy.updateMany({
        where: { workspaceId: actor.workspace.id, active: true },
        data: { active: false }
      });
    }
    const policy = await tx.supportRoutingPolicy.create({
      data: {
        workspaceId: actor.workspace.id,
        version,
        label: input.label,
        active: input.activate,
        createdById: actor.user.id,
        activatedById: input.activate ? actor.user.id : null,
        activatedAt,
        rules: {
          create: input.rules.map((rule) => ({
            order: rule.order,
            name: rule.name,
            enabled: rule.enabled,
            caseTypeKeys: normalized(rule.conditions.caseTypeKeys),
            priorities: rule.conditions.priorities,
            sourceChannels: rule.conditions.sourceChannels,
            impacts: rule.conditions.impacts,
            urgencies: rule.conditions.urgencies,
            targetDepartmentId: rule.action.targetDepartmentId,
            assignmentMode: rule.action.assignmentMode,
            requiredSkills: normalized(rule.action.requiredSkills)
          }))
        }
      },
      include: routingPolicyInclude
    });
    return serializeRoutingPolicy(policy);
  });
}

export async function activateSupportRoutingPolicy(actor: RequestActor, policyId: string) {
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  return prisma.$transaction(async (tx) => {
    await lockRoutingPolicyVersions(tx, actor.workspace.id);
    const policy = await tx.supportRoutingPolicy.findFirst({
      where: { id: policyId, workspaceId: actor.workspace.id },
      include: routingPolicyInclude
    });
    if (!policy) throw new HttpError(404, 'Support routing policy not found');
    if (!policy.rules.some((rule) => rule.enabled)) {
      throw new HttpError(409, 'A routing policy needs at least one enabled rule');
    }
    if (policy.rules.some((rule) => rule.enabled && !rule.targetDepartment.active)) {
      throw new HttpError(409, 'Routing policy targets must be active before activation');
    }
    await tx.supportRoutingPolicy.updateMany({
      where: { workspaceId: actor.workspace.id, active: true },
      data: { active: false }
    });
    const activated = await tx.supportRoutingPolicy.update({
      where: { id: policy.id },
      data: { active: true, activatedById: actor.user.id, activatedAt: new Date() },
      include: routingPolicyInclude
    });
    return serializeRoutingPolicy(activated);
  });
}

export async function listDepartmentRoutingMembers(actor: RequestActor, departmentId: string) {
  await assertCanManageDepartmentRouting(actor, departmentId);
  const members = await prisma.departmentMember.findMany({
    where: { workspaceId: actor.workspace.id, departmentId },
    orderBy: [{ active: 'desc' }, { role: 'desc' }, { id: 'asc' }],
    include: {
      workspaceMember: {
        select: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } }
      }
    }
  });
  const loads = await activeLoadsByMembership(
    actor.workspace.id,
    departmentId,
    members.map((member) => member.id)
  );
  return {
    departmentId,
    items: members.map((member) => serializeRoutingMember(member, loads.get(member.id) ?? 0))
  };
}

export async function updateDepartmentRoutingMember(
  actor: RequestActor,
  departmentId: string,
  userId: string,
  rawInput: UpdateSupportRoutingMemberInput
) {
  const input = updateSupportRoutingMemberSchema.parse(rawInput);
  await assertCanManageDepartmentRouting(actor, departmentId);
  const existing = await prisma.departmentMember.findUnique({
    where: {
      workspaceId_departmentId_userId: {
        workspaceId: actor.workspace.id,
        departmentId,
        userId
      }
    },
    select: { id: true }
  });
  if (!existing) throw new HttpError(404, 'Department member not found');
  const member = await prisma.departmentMember.update({
    where: { id: existing.id },
    data: {
      routingAvailability: input.routingAvailability,
      routingCapacity: input.routingCapacity,
      routingSkills: input.routingSkills === undefined ? undefined : normalized(input.routingSkills)
    },
    include: {
      workspaceMember: {
        select: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } }
      }
    }
  });
  const loads = await activeLoadsByMembership(actor.workspace.id, departmentId, [member.id]);
  return serializeRoutingMember(member, loads.get(member.id) ?? 0);
}

export async function simulateSupportRouting(
  actor: RequestActor,
  idOrKey: string,
  rawInput: SupportRoutingSimulationInput
) {
  const input = supportRoutingSimulationSchema.parse(rawInput);
  const decision = await resolveRoutingDecision(actor, idOrKey, input.baseVersion);
  return publicRoutingDecision(decision);
}

export async function applySupportRouting(
  actor: RequestActor,
  idOrKey: string,
  rawInput: SupportRoutingSimulationInput
) {
  const input = applySupportRoutingSchema.parse(rawInput);
  const decision = await resolveRoutingDecision(actor, idOrKey, input.baseVersion);
  if (decision.outcome === 'TRIAGE') {
    await auditRoutingFallback(actor, decision);
    return {
      ...publicRoutingDecision(decision),
      applied: true,
      caseVersion: decision.caseFacts.version
    };
  }

  const matchedRule = decision.matchedRule;
  if (!matchedRule || !decision.targetDepartmentId) {
    throw new Error('A route decision must carry its matched rule and Department');
  }
  const reason = [
    `Deterministic routing policy v${decision.policy?.version}`,
    `rule ${matchedRule.order} (${matchedRule.id})`,
    `decision ${decision.decisionFingerprint}`
  ].join('; ');
  const routed = await routeSupportCase(actor, idOrKey, {
    targetDepartmentId: decision.targetDepartmentId,
    targetAssigneeMembershipId: decision.targetAssigneeMembershipId,
    baseVersion: input.baseVersion,
    reason
  });
  const canSeeCapacity = capacityDetailsVisible(
    decision.access,
    decision.targetDepartmentId
  );
  return {
    outcome: 'ROUTED' as const,
    applied: true,
    case: {
      id: routed.supportCase.id,
      key: routed.supportCase.key,
      version: routed.supportCase.version,
      status: routed.supportCase.status,
      departmentId: routed.supportCase.departmentId,
      ...(canSeeCapacity
        ? { assigneeMembershipId: routed.supportCase.assigneeMembershipId }
        : {})
    },
    policy: { id: decision.policy?.id, version: decision.policy?.version },
    matchedRule: { id: matchedRule.id, order: matchedRule.order, name: matchedRule.name },
    assignment: publicAssignment(decision),
    decisionFingerprint: decision.decisionFingerprint,
    prioritySuggestion: prioritySuggestion(decision.caseFacts),
    accessEpoch: routed.access.epoch.toString()
  };
}

export async function decideSupportCasePriority(
  actor: RequestActor,
  idOrKey: string,
  rawInput: DecideSupportPriorityInput
) {
  const input = decideSupportPrioritySchema.parse(rawInput);
  if (actor.user.kind !== 'HUMAN' || actor.credential) {
    throw new HttpError(403, 'A human Support user must accept or override a priority suggestion');
  }
  return prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    const current = await lockSupportCase(tx, actor.workspace.id, idOrKey);
    if (!current || !canReadSupportCase(access, current)) {
      throw new HttpError(404, 'Support Case not found');
    }
    assertCaseVersion(current, input.baseVersion, access);
    assertCanWorkCase(access, current);
    if (current.status === 'RESOLVED' || current.status === 'CLOSED') {
      throw new HttpError(409, 'Terminal Support Cases must be reopened before changing priority');
    }
    const suggestion = suggestSupportPriority(current.impact, current.urgency);
    if (input.decision === 'ACCEPT_SUGGESTION' && !suggestion) {
      throw new HttpError(409, 'Impact and urgency are required before accepting a priority suggestion');
    }
    const priority = input.decision === 'ACCEPT_SUGGESTION' ? suggestion! : input.priority;
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: { priority, version: { increment: 1 } },
      include: supportCaseInclude
    });
    const auditReason = input.decision === 'ACCEPT_SUGGESTION'
      ? `Human accepted impact-by-urgency suggestion ${suggestion}`
      : `Human overrode impact-by-urgency suggestion ${suggestion ?? 'UNAVAILABLE'} with ${priority}: ${input.reason}`;
    await appendSupportCaseEvent(tx, actor, updated, {
      action: input.decision === 'ACCEPT_SUGGESTION'
        ? 'case.priority_suggestion_accepted'
        : 'case.priority_suggestion_overridden',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: auditReason
    });
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
    return {
      case: serializeSupportCase(updated, access),
      priorityDecision: {
        decision: input.decision,
        suggestion,
        appliedPriority: priority
      }
    };
  });
}

async function resolveRoutingDecision(
  actor: RequestActor,
  idOrKey: string,
  baseVersion: number
): Promise<InternalRoutingDecision> {
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  assertCaseVersion(supportCase, baseVersion, access);
  assertCanTriage(access);
  if (supportCase.departmentId !== null) {
    throw new HttpError(409, 'Deterministic routing only applies to unrouted Triage Cases');
  }
  if (supportCase.status === 'RESOLVED' || supportCase.status === 'CLOSED') {
    throw new HttpError(409, 'Terminal Support Cases must be reopened before routing');
  }

  const caseFacts = routingFacts(supportCase);
  const policy = await prisma.supportRoutingPolicy.findFirst({
    where: { workspaceId: actor.workspace.id, active: true },
    orderBy: { version: 'desc' },
    include: routingPolicyInclude
  });
  if (!policy) {
    return fallbackDecision(caseFacts, access, null, [], 'NO_ACTIVE_POLICY');
  }

  const evaluations: InternalRoutingDecision['evaluations'] = [];
  let matchedRule: RoutingRuleView | null = null;
  for (const rule of policy.rules) {
    if (!rule.enabled) {
      evaluations.push({
        ruleId: rule.id,
        order: rule.order,
        name: rule.name,
        result: 'DISABLED',
        mismatches: []
      });
      continue;
    }
    const mismatches = supportRoutingRuleMismatches(caseFacts, rule);
    const result = mismatches.length ? 'NO_MATCH' : 'MATCH';
    evaluations.push({ ruleId: rule.id, order: rule.order, name: rule.name, result, mismatches });
    if (result === 'MATCH') {
      matchedRule = rule;
      break;
    }
  }
  if (!matchedRule) {
    return fallbackDecision(caseFacts, access, policy, evaluations, 'NO_MATCHING_RULE');
  }
  if (!matchedRule.targetDepartment.active) {
    return fallbackDecision(
      caseFacts,
      access,
      policy,
      evaluations,
      'TARGET_DEPARTMENT_UNAVAILABLE',
      matchedRule
    );
  }

  let candidates: CapacityRoutingCandidate[] = [];
  let selectedCandidate: CapacityRoutingCandidate | null = null;
  let assignmentResult: InternalRoutingDecision['assignmentResult'] = 'DEPARTMENT_INBOX';
  if (matchedRule.assignmentMode === 'CAPACITY_AWARE') {
    const members = await prisma.departmentMember.findMany({
      where: {
        workspaceId: actor.workspace.id,
        departmentId: matchedRule.targetDepartmentId,
        active: true,
        routingAvailability: 'AVAILABLE',
        routingCapacity: { gt: 0 }
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        userId: true,
        active: true,
        routingAvailability: true,
        routingCapacity: true,
        routingSkills: true
      }
    });
    const loads = await activeLoadsByMembership(
      actor.workspace.id,
      matchedRule.targetDepartmentId,
      members.map((member) => member.id)
    );
    candidates = members.map((member) => ({
      membershipId: member.id,
      userId: member.userId,
      active: member.active,
      available: member.routingAvailability === 'AVAILABLE',
      capacity: member.routingCapacity,
      activeCaseLoad: loads.get(member.id) ?? 0,
      skills: member.routingSkills
    }));
    selectedCandidate = selectCapacityAwareMember(candidates, matchedRule.requiredSkills);
    assignmentResult = selectedCandidate
      ? 'MEMBER_SELECTED'
      : 'NO_ELIGIBLE_MEMBER_DEPARTMENT_INBOX';
  }

  const fingerprint = routingDecisionFingerprint({
    caseFacts,
    policy,
    matchedRule,
    outcome: 'ROUTE',
    fallbackReason: null
  });
  return {
    outcome: 'ROUTE',
    caseFacts,
    access,
    policy,
    evaluations,
    matchedRule,
    fallbackReason: null,
    targetDepartmentId: matchedRule.targetDepartmentId,
    targetDepartmentName: matchedRule.targetDepartment.name,
    assignmentMode: matchedRule.assignmentMode,
    targetAssigneeMembershipId: selectedCandidate?.membershipId ?? null,
    candidates,
    selectedCandidate,
    assignmentResult,
    decisionFingerprint: fingerprint
  };
}

function fallbackDecision(
  caseFacts: SupportRoutingCaseFacts,
  access: SupportAccess,
  policy: RoutingPolicyView | null,
  evaluations: InternalRoutingDecision['evaluations'],
  fallbackReason: Exclude<InternalRoutingDecision['fallbackReason'], null>,
  matchedRule: RoutingRuleView | null = null
): InternalRoutingDecision {
  return {
    outcome: 'TRIAGE',
    caseFacts,
    access,
    policy,
    evaluations,
    matchedRule,
    fallbackReason,
    targetDepartmentId: null,
    targetDepartmentName: null,
    assignmentMode: null,
    targetAssigneeMembershipId: null,
    candidates: [],
    selectedCandidate: null,
    assignmentResult: null,
    decisionFingerprint: routingDecisionFingerprint({
      caseFacts,
      policy,
      matchedRule,
      outcome: 'TRIAGE',
      fallbackReason
    })
  };
}

function publicRoutingDecision(decision: InternalRoutingDecision) {
  return {
    explanationVersion: 1,
    outcome: decision.outcome,
    case: decision.caseFacts,
    policy: decision.policy
      ? { id: decision.policy.id, version: decision.policy.version, label: decision.policy.label }
      : null,
    evaluatedRules: decision.evaluations,
    matchedRule: decision.matchedRule
      ? {
          id: decision.matchedRule.id,
          order: decision.matchedRule.order,
          name: decision.matchedRule.name
        }
      : null,
    fallbackReason: decision.fallbackReason,
    route: decision.targetDepartmentId
      ? {
          departmentId: decision.targetDepartmentId,
          departmentName: decision.targetDepartmentName,
          assignment: publicAssignment(decision)
        }
      : null,
    prioritySuggestion: prioritySuggestion(decision.caseFacts),
    decisionFingerprint: decision.decisionFingerprint
  };
}

function publicAssignment(decision: InternalRoutingDecision) {
  if (!decision.assignmentMode || !decision.assignmentResult) return null;
  const visible = Boolean(
    decision.targetDepartmentId
    && capacityDetailsVisible(decision.access, decision.targetDepartmentId)
  );
  return {
    mode: decision.assignmentMode,
    result: decision.assignmentResult,
    selectionAlgorithm: decision.assignmentMode === 'CAPACITY_AWARE'
      ? 'LOWEST_UTILIZATION_THEN_LOAD_THEN_MEMBERSHIP_ID'
      : null,
    capacityDetailsRedacted: decision.assignmentMode === 'CAPACITY_AWARE' && !visible,
    ...(visible && decision.assignmentMode === 'CAPACITY_AWARE'
      ? {
          consideredMemberCount: decision.candidates.length,
          eligibleMemberCount: decision.candidates.filter((candidate) =>
            candidate.active
            && candidate.available
            && candidate.capacity > candidate.activeCaseLoad
            && decision.matchedRule?.requiredSkills.every((skill) =>
              candidate.skills.map(normalizeSkill).includes(normalizeSkill(skill))
            )
          ).length,
          selectedMember: decision.selectedCandidate
            ? {
                membershipId: decision.selectedCandidate.membershipId,
                userId: decision.selectedCandidate.userId,
                activeCaseLoad: decision.selectedCandidate.activeCaseLoad,
                capacity: decision.selectedCandidate.capacity,
                availableSlots: decision.selectedCandidate.capacity
                  - decision.selectedCandidate.activeCaseLoad,
                skills: [...decision.selectedCandidate.skills]
              }
            : null
        }
      : {})
  };
}

function prioritySuggestion(facts: SupportRoutingCaseFacts) {
  const suggestedPriority = suggestSupportPriority(facts.impact, facts.urgency);
  return {
    method: 'IMPACT_BY_URGENCY' as const,
    suggestedPriority,
    available: suggestedPriority !== null,
    requiresHumanDecision: true
  };
}

async function auditRoutingFallback(actor: RequestActor, decision: InternalRoutingDecision) {
  await prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    const current = await lockSupportCase(tx, actor.workspace.id, decision.caseFacts.id);
    if (!current || !canReadSupportCase(access, current)) {
      throw new HttpError(404, 'Support Case not found');
    }
    assertCaseVersion(current, decision.caseFacts.version, access);
    assertCanWorkCase(access, current);
    if (current.departmentId !== null) {
      throw new HttpError(409, 'Deterministic routing only applies to unrouted Triage Cases');
    }
    await appendSupportCaseEvent(tx, actor, current, {
      action: 'case.routing_fallback_to_triage',
      after: caseEventSnapshot(current),
      reason: `${decision.fallbackReason}; decision ${decision.decisionFingerprint}`
    });
  });
}

async function assertCanManageDepartmentRouting(actor: RequestActor, departmentId: string) {
  const access = await resolveSupportAccess(actor);
  if (access.credentialActor) {
    throw new HttpError(403, 'Human Department manager or workspace admin access required');
  }
  const department = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId: actor.workspace.id },
    select: { id: true }
  });
  if (!department) throw new HttpError(404, 'Department not found');
  if (access.canConfigure || access.managedDepartmentIds.includes(departmentId)) return access;
  throw new HttpError(404, 'Department not found');
}

async function activeLoadsByMembership(
  workspaceId: string,
  departmentId: string,
  membershipIds: string[]
): Promise<Map<string, number>> {
  if (!membershipIds.length) return new Map();
  const rows = await prisma.supportCase.groupBy({
    by: ['assigneeMembershipId'],
    where: {
      workspaceId,
      departmentId,
      assigneeMembershipId: { in: membershipIds },
      status: { in: [...nonTerminalStatuses] }
    },
    _count: { _all: true }
  });
  return new Map(rows.flatMap((row) =>
    row.assigneeMembershipId ? [[row.assigneeMembershipId, row._count._all] as const] : []
  ));
}

async function lockRoutingPolicyVersions(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`support-routing-policy:${workspaceId}`}))
  `);
}

async function lockSupportCase(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  idOrKey: string
): Promise<SupportCaseView | null> {
  assertSupportWorkspace((await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { mode: true }
  })));
  const normalizedIdentifier = idOrKey.trim();
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "SupportCase"
    WHERE "workspaceId" = ${workspaceId}::uuid
      AND ("id"::text = ${normalizedIdentifier} OR "key" = ${normalizedIdentifier.toUpperCase()})
    FOR UPDATE
  `);
  if (!rows[0]) return null;
  return tx.supportCase.findUnique({ where: { id: rows[0].id }, include: supportCaseInclude });
}

function assertCaseVersion(current: SupportCaseView, baseVersion: number, access: SupportAccess) {
  if (current.version === baseVersion) return;
  throw new HttpError(409, 'Support Case changed on another client', {
    code: 'SUPPORT_VERSION_CONFLICT',
    current: serializeSupportCase(current, access)
  });
}

function routingFacts(supportCase: SupportCaseView): SupportRoutingCaseFacts {
  return {
    id: supportCase.id,
    key: supportCase.key,
    version: supportCase.version,
    typeKey: supportCase.typeKey,
    priority: supportCase.priority,
    sourceChannel: supportCase.sourceChannel,
    impact: supportCase.impact,
    urgency: supportCase.urgency
  };
}

function routingDecisionFingerprint(input: {
  caseFacts: SupportRoutingCaseFacts;
  policy: RoutingPolicyView | null;
  matchedRule: RoutingRuleView | null;
  outcome: InternalRoutingDecision['outcome'];
  fallbackReason: InternalRoutingDecision['fallbackReason'];
}) {
  return createHash('sha256').update(JSON.stringify({
    explanationVersion: 1,
    case: input.caseFacts,
    policy: input.policy
      ? {
          id: input.policy.id,
          version: input.policy.version,
          rules: input.policy.rules.map((rule) => ({
            id: rule.id,
            order: rule.order,
            enabled: rule.enabled,
            caseTypeKeys: rule.caseTypeKeys,
            priorities: rule.priorities,
            sourceChannels: rule.sourceChannels,
            impacts: rule.impacts,
            urgencies: rule.urgencies,
            targetDepartmentId: rule.targetDepartmentId,
            targetDepartmentActive: rule.targetDepartment.active,
            assignmentMode: rule.assignmentMode,
            requiredSkills: rule.requiredSkills
          }))
        }
      : null,
    matchedRuleId: input.matchedRule?.id ?? null,
    outcome: input.outcome,
    fallbackReason: input.fallbackReason
  })).digest('hex');
}

function capacityDetailsVisible(access: SupportAccess, departmentId: string) {
  return !access.credentialActor
    && (access.canConfigure || access.managedDepartmentIds.includes(departmentId));
}

function serializeRoutingPolicy(policy: RoutingPolicyView) {
  return {
    id: policy.id,
    workspaceId: policy.workspaceId,
    version: policy.version,
    label: policy.label,
    active: policy.active,
    createdById: policy.createdById,
    activatedById: policy.activatedById,
    activatedAt: policy.activatedAt?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
    rules: policy.rules.map((rule) => ({
      id: rule.id,
      order: rule.order,
      name: rule.name,
      enabled: rule.enabled,
      conditions: {
        caseTypeKeys: rule.caseTypeKeys,
        priorities: rule.priorities,
        sourceChannels: rule.sourceChannels,
        impacts: rule.impacts,
        urgencies: rule.urgencies
      },
      action: {
        targetDepartmentId: rule.targetDepartmentId,
        assignmentMode: rule.assignmentMode,
        requiredSkills: rule.requiredSkills
      },
      targetDepartment: rule.targetDepartment,
      createdAt: rule.createdAt.toISOString()
    }))
  };
}

function serializeRoutingMember<
  T extends {
    id: string;
    workspaceId: string;
    departmentId: string;
    userId: string;
    role: string;
    active: boolean;
    routingAvailability: string;
    routingCapacity: number;
    routingSkills: string[];
    updatedAt: Date;
    workspaceMember: { user: { id: string; name: string; email: string; avatarUrl: string | null } };
  }
>(member: T, activeCaseLoad: number) {
  return {
    membershipId: member.id,
    workspaceId: member.workspaceId,
    departmentId: member.departmentId,
    userId: member.userId,
    role: member.role,
    active: member.active,
    routingAvailability: member.routingAvailability,
    routingCapacity: member.routingCapacity,
    routingSkills: member.routingSkills,
    activeCaseLoad,
    availableSlots: Math.max(0, member.routingCapacity - activeCaseLoad),
    updatedAt: member.updatedAt.toISOString(),
    user: member.workspaceMember.user
  };
}

function normalized(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

function normalizeSkill(value: string) {
  return value.trim().toLowerCase();
}
