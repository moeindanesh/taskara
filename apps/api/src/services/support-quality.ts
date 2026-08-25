import { createHash, randomBytes } from 'node:crypto';
import {
  prisma,
  type Prisma,
  type SupportAssistanceKind,
  type SupportCasePriority
} from '@taskara/db';
import { z } from 'zod';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import { requireKnowledgePageForView } from './knowledge';
import {
  assertCanDispatch,
  assertCanWorkCase,
  bumpSupportAccessEpochs,
  canReadSupportCase,
  resolveSupportAccess,
  supportCaseWhereForAccess,
  type SupportAccess
} from './support-access';
import { appendSupportCaseEvent, lockSupportOwnershipGraph } from './support-cases';
import { applySupportSlaCaseEvent } from './support-sla';
import { appendSupportCaseSyncEvent } from './support-sync';

const provenanceShape = {
  provider: z.string().trim().min(1).max(120),
  modelOrRule: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(120),
  confidence: z.number().min(0).max(1),
  contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.string().datetime({ offset: true }).optional()
} as const;

const supportTypeKeySchema = z.string().trim().toLowerCase().min(1).max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

const suggestionVariants = [
  z.object({ ...provenanceShape, kind: z.literal('TYPE'), payload: z.object({ typeKey: supportTypeKeySchema }).strict() }).strict(),
  z.object({ ...provenanceShape, kind: z.literal('PRIORITY'), payload: z.object({ priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']) }).strict() }).strict(),
  z.object({ ...provenanceShape, kind: z.literal('DEPARTMENT'), payload: z.object({ departmentId: z.string().uuid() }).strict() }).strict(),
  z.object({ ...provenanceShape, kind: z.literal('DUPLICATE'), payload: z.object({ caseId: z.string().uuid() }).strict() }).strict(),
  z.object({ ...provenanceShape, kind: z.literal('SUMMARY'), payload: z.object({ text: z.string().trim().min(1).max(20_000) }).strict() }).strict(),
  z.object({ ...provenanceShape, kind: z.literal('REPLY'), payload: z.object({ text: z.string().trim().min(1).max(20_000) }).strict() }).strict(),
  z.object({
    ...provenanceShape,
    kind: z.literal('KNOWLEDGE'),
    payload: z.object({
      references: z.array(z.object({
        pageId: z.string().uuid(),
        title: z.string().trim().min(1).max(300),
        reason: z.string().trim().min(1).max(2000).optional()
      }).strict()).min(1).max(20)
    }).strict()
  }).strict()
] as const;

export const createSupportSuggestionSchema = z.discriminatedUnion('kind', suggestionVariants);

export const decideSupportSuggestionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('ACCEPTED'),
    reason: z.string().trim().min(3).max(2000),
    baseVersion: z.number().int().positive().optional()
  }).strict(),
  z.object({
    decision: z.literal('REJECTED'),
    reason: z.string().trim().min(3).max(2000)
  }).strict()
]);

const qualityCriterionSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  label: z.string().trim().min(1).max(200),
  maxScore: z.number().int().min(1).max(100),
  weight: z.number().int().min(1).max(100)
}).strict();

export const createSupportQualityRubricSchema = z.object({
  rubricKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/),
  name: z.string().trim().min(1).max(200),
  criteria: z.array(qualityCriterionSchema).min(1).max(50)
}).strict().superRefine((input, context) => {
  const keys = input.criteria.map((criterion) => criterion.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'Criterion keys must be unique' });
  }
});

export const createSupportQualityReviewSchema = z.object({
  caseId: z.string().uuid(),
  rubricId: z.string().uuid(),
  sampleReason: z.string().trim().min(3).max(2000),
  findings: z.array(z.object({
    criterionKey: z.string().trim().min(1).max(80),
    score: z.number().int().min(0).max(100),
    finding: z.string().trim().max(4000).optional()
  }).strict()).min(1).max(50)
}).strict();

export const createSupportCsatInvitationSchema = z.object({
  expiresInDays: z.number().int().min(1).max(90).default(30),
  scaleMin: z.number().int().min(0).max(9).default(1),
  scaleMax: z.number().int().min(1).max(10).default(5)
}).strict().refine((input) => input.scaleMax > input.scaleMin, {
  message: 'scaleMax must be greater than scaleMin'
});

// Deliberately accepts the full supported score range. Token-specific scale failures receive the
// same acknowledgement as unknown, expired, and already-used tokens.
export const submitSupportCsatSchema = z.object({
  token: z.string().trim().min(20).max(200),
  score: z.number().int().min(0).max(10),
  comment: z.string().trim().max(4000).optional()
}).strict();

type SuggestionInput = z.infer<typeof createSupportSuggestionSchema>;
type SuggestionDecisionInput = z.infer<typeof decideSupportSuggestionSchema>;
type QualityRubricInput = z.infer<typeof createSupportQualityRubricSchema>;
type QualityReviewInput = z.infer<typeof createSupportQualityReviewSchema>;

const caseAccessSelect = {
  id: true,
  workspaceId: true,
  key: true,
  title: true,
  typeKey: true,
  priority: true,
  status: true,
  departmentId: true,
  assigneeMembershipId: true,
  duplicateOfCaseId: true,
  version: true,
  assigneeMembership: { select: { userId: true } }
} satisfies Prisma.SupportCaseSelect;

type CaseAccessView = Prisma.SupportCaseGetPayload<{ select: typeof caseAccessSelect }>;

export async function createSupportSuggestion(
  actor: RequestActor,
  idOrKey: string,
  rawInput: SuggestionInput
) {
  const input = createSupportSuggestionSchema.parse(rawInput);
  const access = await resolveSupportAccess(actor);
  const supportCase = await findCase(actor.workspace.id, idOrKey);
  if (!supportCase || !canReadSupportCase(access, supportCase)) {
    throw new HttpError(404, 'Support Case not found');
  }
  assertCanWorkCase(access, supportCase);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt <= new Date()) throw new HttpError(400, 'Suggestion expiry must be in the future');
  const payload = await validateSuggestionTarget(actor, access, supportCase, input);
  const suggestion = await prisma.supportAssistanceSuggestion.create({
    data: {
      workspaceId: actor.workspace.id,
      caseId: supportCase.id,
      kind: input.kind,
      payload,
      provider: input.provider,
      modelOrRule: input.modelOrRule,
      version: input.version,
      confidence: input.confidence,
      contextDigest: input.contextDigest,
      expiresAt,
      createdById: actor.user.id
    }
  });
  return serializeSuggestion(suggestion);
}

export async function listSupportSuggestions(actor: RequestActor, idOrKey: string) {
  const access = await resolveSupportAccess(actor);
  const supportCase = await findCase(actor.workspace.id, idOrKey);
  if (!supportCase || !canReadSupportCase(access, supportCase)) {
    throw new HttpError(404, 'Support Case not found');
  }
  const now = new Date();
  await prisma.supportAssistanceSuggestion.updateMany({
    where: {
      workspaceId: actor.workspace.id,
      caseId: supportCase.id,
      decision: 'PENDING',
      expiresAt: { lte: now }
    },
    data: { decision: 'EXPIRED', decidedAt: now }
  });
  const items = await prisma.supportAssistanceSuggestion.findMany({
    where: { workspaceId: actor.workspace.id, caseId: supportCase.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  const visibleItems = (await Promise.all(items.map(async (suggestion) => {
    return await suggestionTargetIsVisible(actor, access, suggestion.kind, suggestion.payload)
      ? serializeSuggestion(suggestion)
      : null;
  }))).filter((item) => item !== null);
  return { items: visibleItems, accessEpoch: access.epoch.toString() };
}

export async function decideSupportSuggestion(
  actor: RequestActor,
  suggestionId: string,
  rawInput: SuggestionDecisionInput
) {
  const input = decideSupportSuggestionSchema.parse(rawInput);
  if (actor.user.kind !== 'HUMAN' || actor.credential) {
    throw new HttpError(403, 'A human Support user must decide assistance suggestions');
  }
  return prisma.$transaction(async (tx) => {
    await lockSupportOwnershipGraph(tx, actor.workspace.id);
    const access = await resolveSupportAccess(actor, tx);
    const suggestion = await tx.supportAssistanceSuggestion.findFirst({
      where: { id: suggestionId, workspaceId: actor.workspace.id },
      include: { case: { select: caseAccessSelect } }
    });
    if (!suggestion || !canReadSupportCase(access, suggestion.case)) {
      throw new HttpError(404, 'Support suggestion not found');
    }
    assertCanWorkCase(access, suggestion.case);
    // A persisted target is a reference, never a durable read capability. Re-authorize it before
    // revealing decision state or returning the payload, including on a rejection path.
    if (!await suggestionTargetIsVisible(actor, access, suggestion.kind, suggestion.payload)) {
      throw new HttpError(404, 'Support suggestion not found');
    }
    if (suggestion.decision !== 'PENDING') throw new HttpError(409, 'Support suggestion was already decided');
    if (suggestion.expiresAt && suggestion.expiresAt <= new Date()) {
      await tx.supportAssistanceSuggestion.updateMany({
        where: { id: suggestion.id, decision: 'PENDING' },
        data: { decision: 'EXPIRED', decidedAt: new Date() }
      });
      throw new HttpError(409, 'Support suggestion has expired');
    }

    if (input.decision === 'REJECTED') {
      const claimed = await tx.supportAssistanceSuggestion.updateMany({
        where: { id: suggestion.id, decision: 'PENDING' },
        data: {
          decision: 'REJECTED',
          decisionReason: input.reason,
          decidedById: actor.user.id,
          decidedByKind: 'HUMAN',
          decidedAt: new Date()
        }
      });
      if (claimed.count !== 1) throw new HttpError(409, 'Support suggestion was already decided');
      return serializeSuggestion(await tx.supportAssistanceSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } }));
    }

    const mutating = mutatingSuggestionKinds.has(suggestion.kind);
    if (mutating && input.baseVersion === undefined) {
      throw new HttpError(400, 'baseVersion is required when accepting this suggestion');
    }
    let decisionCaseVersion: number | null = null;
    if (mutating) {
      const updated = await applySuggestionMutation(tx, actor, access, suggestion.case, {
        kind: suggestion.kind,
        payload: suggestion.payload
      }, input.baseVersion!, input.reason);
      decisionCaseVersion = updated.version;
    }
    const claimed = await tx.supportAssistanceSuggestion.updateMany({
      where: { id: suggestion.id, decision: 'PENDING' },
      data: {
        decision: 'ACCEPTED',
        decisionReason: input.reason,
        decisionCaseVersion,
        decidedById: actor.user.id,
        decidedByKind: 'HUMAN',
        decidedAt: new Date()
      }
    });
    if (claimed.count !== 1) throw new HttpError(409, 'Support suggestion was already decided');
    return serializeSuggestion(await tx.supportAssistanceSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } }));
  });
}

export async function createSupportCsatInvitation(
  actor: RequestActor,
  idOrKey: string,
  rawInput: z.infer<typeof createSupportCsatInvitationSchema>
) {
  const input = createSupportCsatInvitationSchema.parse(rawInput);
  const access = await resolveSupportAccess(actor);
  const supportCase = await findCase(actor.workspace.id, idOrKey);
  if (!supportCase || !canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  assertHumanReviewer(actor, access, supportCase);
  if (!isTerminal(supportCase.status)) throw new HttpError(409, 'CSAT invitations require a resolved Case');
  const token = `tcsat_${randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const invitation = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "SupportCase" WHERE "id" = ${supportCase.id}::uuid FOR UPDATE`;
    await tx.supportCsatInvitation.updateMany({
      where: {
        workspaceId: actor.workspace.id,
        caseId: supportCase.id,
        consumedAt: null,
        invalidatedAt: null
      },
      data: { invalidatedAt: now }
    });
    return tx.supportCsatInvitation.create({
      data: {
        workspaceId: actor.workspace.id,
        caseId: supportCase.id,
        tokenHash: csatTokenHash(token),
        scaleMin: input.scaleMin,
        scaleMax: input.scaleMax,
        expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000),
        createdById: actor.user.id
      },
      select: { id: true, scaleMin: true, scaleMax: true, expiresAt: true, createdAt: true }
    });
  });
  return { ...invitation, token };
}

export async function getSupportCsatForCase(actor: RequestActor, idOrKey: string) {
  const access = await resolveSupportAccess(actor);
  const supportCase = await findCase(actor.workspace.id, idOrKey);
  if (!supportCase || !canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  assertHumanReviewer(actor, access, supportCase);
  const invitations = await prisma.supportCsatInvitation.findMany({
    where: { workspaceId: actor.workspace.id, caseId: supportCase.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      scaleMin: true,
      scaleMax: true,
      expiresAt: true,
      consumedAt: true,
      invalidatedAt: true,
      createdAt: true,
      response: { select: { score: true, comment: true, submittedAt: true } }
    }
  });
  return { items: invitations };
}

export async function submitSupportCsat(rawInput: z.infer<typeof submitSupportCsatSchema>) {
  const input = submitSupportCsatSchema.parse(rawInput);
  const acknowledgement = { received: true } as const;
  const invitation = await prisma.supportCsatInvitation.findUnique({
    where: { tokenHash: csatTokenHash(input.token) },
    select: {
      id: true,
      scaleMin: true,
      scaleMax: true,
      expiresAt: true,
      consumedAt: true,
      invalidatedAt: true
    }
  });
  if (!invitation || invitation.consumedAt || invitation.invalidatedAt || invitation.expiresAt <= new Date()
    || input.score < invitation.scaleMin || input.score > invitation.scaleMax) {
    return acknowledgement;
  }
  try {
    await prisma.supportCsatResponse.create({
      data: { invitationId: invitation.id, score: input.score, comment: input.comment || null }
    });
  } catch {
    // Concurrent use, expiry, invalidation and an unavailable token are intentionally indistinguishable.
  }
  return acknowledgement;
}

export async function createSupportQualityRubric(actor: RequestActor, rawInput: QualityRubricInput) {
  const input = createSupportQualityRubricSchema.parse(rawInput);
  const access = await resolveSupportAccess(actor);
  if (actor.user.kind !== 'HUMAN' || actor.credential || (!access.supervisor && !access.canConfigure)) {
    throw new HttpError(403, 'Support quality configuration access required');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${actor.workspace.id}::uuid FOR UPDATE`;
    const latest = await tx.supportQualityRubric.findFirst({
      where: { workspaceId: actor.workspace.id, rubricKey: input.rubricKey },
      orderBy: { version: 'desc' },
      select: { version: true }
    });
    return tx.supportQualityRubric.create({
      data: {
        workspaceId: actor.workspace.id,
        rubricKey: input.rubricKey,
        name: input.name,
        version: (latest?.version ?? 0) + 1,
        criteria: input.criteria,
        createdById: actor.user.id
      }
    });
  });
}

export async function listSupportQualityRubrics(actor: RequestActor) {
  const access = await resolveSupportAccess(actor);
  if (!hasAnySupportRead(access)) throw new HttpError(403, 'Support access required');
  return {
    items: await prisma.supportQualityRubric.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: [{ rubricKey: 'asc' }, { version: 'desc' }]
    })
  };
}

export async function createSupportQualityReview(actor: RequestActor, rawInput: QualityReviewInput) {
  const input = createSupportQualityReviewSchema.parse(rawInput);
  const access = await resolveSupportAccess(actor);
  const supportCase = await findCase(actor.workspace.id, input.caseId);
  if (!supportCase || !canReadSupportCase(access, supportCase)) throw new HttpError(404, 'Support Case not found');
  assertHumanReviewer(actor, access, supportCase);
  if (!isTerminal(supportCase.status) || !supportCase.departmentId || !supportCase.assigneeMembership?.userId) {
    throw new HttpError(409, 'Only an assigned resolved Case can be quality reviewed');
  }
  const rubric = await prisma.supportQualityRubric.findFirst({
    where: { id: input.rubricId, workspaceId: actor.workspace.id }
  });
  if (!rubric) throw new HttpError(404, 'Support quality rubric not found');
  const criteria = z.array(qualityCriterionSchema).parse(rubric.criteria);
  const normalizedFindings = validateAndScoreFindings(criteria, input.findings);
  try {
    return await prisma.supportQualityReview.create({
      data: {
        workspaceId: actor.workspace.id,
        caseId: supportCase.id,
        rubricId: rubric.id,
        rubricVersion: rubric.version,
        departmentId: supportCase.departmentId,
        assigneeUserId: supportCase.assigneeMembership.userId,
        reviewerId: actor.user.id,
        reviewerKind: 'HUMAN',
        sampleReason: input.sampleReason,
        score: normalizedFindings.score,
        findings: normalizedFindings.findings,
        completedAt: new Date()
      },
      include: qualityReviewInclude
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new HttpError(409, 'This Case was already reviewed with that rubric version');
    throw error;
  }
}

export async function listSupportQualityReviews(actor: RequestActor) {
  const access = await resolveSupportAccess(actor);
  if (actor.user.kind !== 'HUMAN' || actor.credential) throw new HttpError(403, 'Human Support access required');
  const alternatives: Prisma.SupportQualityReviewWhereInput[] = [];
  if (access.workspaceWide) alternatives.push({ workspaceId: actor.workspace.id });
  else {
    if (access.managedDepartmentIds.length) alternatives.push({ departmentId: { in: access.managedDepartmentIds } });
    // An assignee can see only their own completed review, never a peer row or aggregate.
    alternatives.push({ assigneeUserId: actor.user.id, completedAt: { lte: new Date() } });
  }
  const items = await prisma.supportQualityReview.findMany({
    where: {
      workspaceId: actor.workspace.id,
      OR: alternatives,
      case: supportCaseWhereForAccess(access)
    },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    include: qualityReviewInclude
  });
  return { items };
}

const qualityReviewInclude = {
  case: { select: { id: true, key: true, title: true } },
  rubric: { select: { id: true, rubricKey: true, name: true, version: true } },
  reviewer: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } }
} satisfies Prisma.SupportQualityReviewInclude;

const mutatingSuggestionKinds = new Set<SupportAssistanceKind>([
  'TYPE', 'PRIORITY', 'DEPARTMENT', 'DUPLICATE'
]);

async function applySuggestionMutation(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  access: SupportAccess,
  current: CaseAccessView,
  suggestion: { kind: SupportAssistanceKind; payload: Prisma.JsonValue },
  baseVersion: number,
  decisionReason: string
): Promise<CaseAccessView> {
  if (current.version !== baseVersion) throw versionConflict(access, current.version);
  if (isTerminal(current.status)) throw new HttpError(409, 'Terminal Support Cases must be reopened before applying suggestions');
  if (suggestion.kind === 'DEPARTMENT') {
    return applyDepartmentSuggestion(tx, actor, access, current, suggestion.payload, baseVersion, decisionReason);
  }
  let data: Prisma.SupportCaseUncheckedUpdateManyInput;
  let afterValue: Prisma.InputJsonValue;
  switch (suggestion.kind) {
    case 'TYPE': {
      const { typeKey } = z.object({ typeKey: supportTypeKeySchema }).strict().parse(suggestion.payload);
      data = { typeKey, version: { increment: 1 } };
      afterValue = { typeKey };
      break;
    }
    case 'PRIORITY': {
      const { priority } = z.object({ priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']) }).strict().parse(suggestion.payload);
      data = { priority: priority as SupportCasePriority, version: { increment: 1 } };
      afterValue = { priority };
      break;
    }
    case 'DUPLICATE': {
      const { caseId } = z.object({ caseId: z.string().uuid() }).strict().parse(suggestion.payload);
      const target = await tx.supportCase.findFirst({
        where: { ...supportCaseWhereForAccess(access), id: caseId, NOT: { id: current.id } },
        select: { id: true }
      });
      if (!target) throw new HttpError(409, 'Suggested duplicate Case is no longer available');
      data = { duplicateOfCaseId: target.id, version: { increment: 1 } };
      afterValue = { duplicateOfCaseId: target.id };
      break;
    }
    default:
      throw new Error('Non-mutating suggestion reached mutation handler');
  }
  const updatedCount = await tx.supportCase.updateMany({
    where: { id: current.id, workspaceId: current.workspaceId, version: baseVersion },
    data
  });
  if (updatedCount.count !== 1) throw versionConflict(access, current.version);
  const updated = await tx.supportCase.findUniqueOrThrow({ where: { id: current.id }, select: caseAccessSelect });
  await appendSupportCaseEvent(tx, actor, updated, {
    action: 'case.assistance_suggestion_accepted',
    before: { kind: suggestion.kind, version: current.version },
    after: { kind: suggestion.kind, ...afterValue as Prisma.InputJsonObject, version: updated.version },
    reason: 'Human accepted a persisted assistance suggestion'
  });
  await appendSupportCaseSyncEvent(tx, {
    workspaceId: current.workspaceId,
    caseId: current.id,
    caseVersion: updated.version,
    operation: 'upsert',
    actorId: actor.user.id,
    removedUserIds: []
  });
  return updated;
}

async function applyDepartmentSuggestion(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  access: SupportAccess,
  current: CaseAccessView,
  payload: Prisma.JsonValue,
  baseVersion: number,
  decisionReason: string
): Promise<CaseAccessView> {
  const { departmentId } = z.object({ departmentId: z.string().uuid() }).strict().parse(payload);
  assertCanDispatch(access, current, { departmentId, assigneeMembershipId: null });
  const target = await tx.department.findFirst({
    where: { id: departmentId, workspaceId: current.workspaceId, active: true },
    select: { id: true }
  });
  if (!target) throw new HttpError(409, 'Suggested Department is no longer available');
  const updatedCount = await tx.supportCase.updateMany({
    where: { id: current.id, workspaceId: current.workspaceId, version: baseVersion },
    data: {
      departmentId,
      assigneeMembershipId: null,
      status: current.status === 'NEW' ? 'OPEN' : current.status,
      version: { increment: 1 }
    }
  });
  if (updatedCount.count !== 1) throw versionConflict(access, current.version);
  const updated = await tx.supportCase.findUniqueOrThrow({ where: { id: current.id }, select: caseAccessSelect });
  const losingUserIds = await ownershipAudienceLosingAccess(tx, current, updated);
  await bumpSupportAccessEpochs(tx, current.workspaceId, losingUserIds);
  const action = current.departmentId !== updated.departmentId
    ? (current.departmentId ? 'case.transferred' : 'case.routed')
    : current.assigneeMembershipId ? 'case.unassigned' : 'case.routing_confirmed';
  await appendSupportCaseEvent(tx, actor, updated, {
    action,
    before: {
      departmentId: current.departmentId,
      assigneeMembershipId: current.assigneeMembershipId,
      status: current.status,
      version: current.version
    },
    after: {
      departmentId: updated.departmentId,
      assigneeMembershipId: updated.assigneeMembershipId,
      status: updated.status,
      version: updated.version
    },
    reason: `Human accepted Department assistance suggestion: ${decisionReason}`
  });
  if (current.departmentId !== updated.departmentId) {
    await applySupportSlaCaseEvent(tx, {
      workspaceId: current.workspaceId,
      caseId: current.id,
      event: current.departmentId ? 'TRANSFERRED' : 'ROUTED',
      at: new Date()
    });
  } else if (current.assigneeMembershipId) {
    await applySupportSlaCaseEvent(tx, {
      workspaceId: current.workspaceId,
      caseId: current.id,
      event: 'UNASSIGNED',
      at: new Date()
    });
  }
  await appendSupportCaseSyncEvent(tx, {
    workspaceId: current.workspaceId,
    caseId: current.id,
    caseVersion: updated.version,
    operation: 'route',
    actorId: actor.user.id,
    removedUserIds: losingUserIds
  });
  return updated;
}

async function validateSuggestionTarget(
  actor: RequestActor,
  access: SupportAccess,
  supportCase: CaseAccessView,
  input: SuggestionInput
): Promise<Prisma.InputJsonValue> {
  if (input.kind === 'DEPARTMENT') {
    const target = await prisma.department.findFirst({
      where: { workspaceId: access.workspaceId, id: input.payload.departmentId, active: true },
      select: { id: true }
    });
    if (!target) throw new HttpError(400, 'Suggested Department does not exist');
  }
  if (input.kind === 'DUPLICATE') {
    const target = await prisma.supportCase.findFirst({
      where: { ...supportCaseWhereForAccess(access), id: input.payload.caseId, NOT: { id: supportCase.id } },
      select: { id: true }
    });
    if (!target) throw new HttpError(400, 'Suggested duplicate Case is not accessible');
  }
  if (input.kind === 'KNOWLEDGE') {
    if (actor.credential) throw new HttpError(403, 'Human knowledge access is required');
    const references = await Promise.all(input.payload.references.map(async (reference) => {
      const page = await requireKnowledgePageForView(actor, reference.pageId);
      return {
        pageId: page.id,
        title: page.title,
        ...(reference.reason ? { reason: reference.reason } : {})
      };
    }));
    return { references };
  }
  return input.payload;
}

async function suggestionTargetIsVisible(
  actor: RequestActor,
  access: SupportAccess,
  kind: SupportAssistanceKind,
  payload: Prisma.JsonValue
): Promise<boolean> {
  if (kind === 'DEPARTMENT') {
    const parsed = z.object({ departmentId: z.string().uuid() }).strict().safeParse(payload);
    if (!parsed.success) return false;
    return Boolean(await prisma.department.findFirst({
      where: { workspaceId: access.workspaceId, id: parsed.data.departmentId, active: true },
      select: { id: true }
    }));
  }
  if (kind === 'DUPLICATE') {
    const parsed = z.object({ caseId: z.string().uuid() }).strict().safeParse(payload);
    if (!parsed.success) return false;
    return Boolean(await prisma.supportCase.findFirst({
      where: { ...supportCaseWhereForAccess(access), id: parsed.data.caseId },
      select: { id: true }
    }));
  }
  if (kind === 'KNOWLEDGE') {
    if (actor.credential) return false;
    const parsed = z.object({
      references: z.array(z.object({
        pageId: z.string().uuid(),
        title: z.string(),
        reason: z.string().optional()
      }).strict()).min(1)
    }).strict().safeParse(payload);
    if (!parsed.success) return false;
    try {
      await Promise.all(parsed.data.references.map((reference) => (
        requireKnowledgePageForView(actor, reference.pageId)
      )));
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

async function ownershipAudienceLosingAccess(
  tx: Prisma.TransactionClient,
  before: CaseAccessView,
  after: CaseAccessView
): Promise<string[]> {
  if (before.departmentId === after.departmentId
    && before.assigneeMembershipId === after.assigneeMembershipId) return [];
  const [oldDepartmentAudience, triageGrants, credentialTriageGrants] = await Promise.all([
    tx.departmentMember.findMany({
      where: {
        workspaceId: before.workspaceId,
        active: true,
        OR: [
          ...(before.departmentId ? [{ departmentId: before.departmentId, role: 'MANAGER' as const }] : []),
          ...(before.assigneeMembershipId ? [{ id: before.assigneeMembershipId }] : [])
        ]
      },
      select: { userId: true }
    }),
    before.departmentId === null
      ? tx.supportPermissionGrant.findMany({
        where: { workspaceId: before.workspaceId, role: 'TRIAGER' },
        select: { userId: true }
      })
      : Promise.resolve([]),
    before.departmentId === null
      ? tx.supportCredentialGrant.findMany({
        where: {
          workspaceId: before.workspaceId,
          scope: 'TRIAGE',
          credential: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
          }
        },
        select: { credential: { select: { userId: true } } }
      })
      : Promise.resolve([])
  ]);
  const candidateUserIds = [...new Set([
    ...oldDepartmentAudience.map((membership) => membership.userId),
    ...triageGrants.map((grant) => grant.userId),
    ...credentialTriageGrants.map((grant) => grant.credential.userId)
  ])];
  if (!candidateUserIds.length) return [];
  // measured-people:allow — Authorization audience subtraction for one Case transfer.
  const scopes = await tx.workspaceMember.findMany({
    where: { workspaceId: before.workspaceId, userId: { in: candidateUserIds } },
    select: {
      userId: true,
      role: true,
      user: { select: { kind: true } },
      supportPermissionGrants: { where: { role: 'SUPERVISOR' }, select: { id: true } },
      departmentMemberships: {
        where: {
          active: true,
          OR: [
            ...(after.departmentId ? [{ departmentId: after.departmentId, role: 'MANAGER' as const }] : []),
            ...(after.assigneeMembershipId ? [{ id: after.assigneeMembershipId }] : [])
          ]
        },
        select: { id: true }
      }
    }
  });
  const byUserId = new Map(scopes.map((scope) => [scope.userId, scope]));
  return candidateUserIds.filter((userId) => {
    const scope = byUserId.get(userId);
    if (scope?.user.kind === 'HUMAN') {
      if (scope.role === 'OWNER' || scope.role === 'ADMIN') return false;
      if (scope.supportPermissionGrants.length || scope.departmentMemberships.length) return false;
    }
    return true;
  });
}

async function findCase(workspaceId: string, idOrKey: string): Promise<CaseAccessView | null> {
  return prisma.supportCase.findFirst({
    where: {
      workspaceId,
      ...(isUuid(idOrKey) ? { OR: [{ id: idOrKey }, { key: idOrKey }] } : { key: idOrKey })
    },
    select: caseAccessSelect
  });
}

function serializeSuggestion(suggestion: {
  id: string;
  caseId: string;
  kind: SupportAssistanceKind;
  payload: Prisma.JsonValue;
  provider: string;
  modelOrRule: string;
  version: string;
  confidence: number;
  contextDigest: string;
  decision: string;
  decisionReason: string | null;
  decisionCaseVersion: number | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: suggestion.id,
    caseId: suggestion.caseId,
    kind: suggestion.kind,
    payload: suggestion.payload,
    provenance: {
      provider: suggestion.provider,
      modelOrRule: suggestion.modelOrRule,
      version: suggestion.version,
      confidence: suggestion.confidence,
      contextDigest: suggestion.contextDigest
    },
    decision: suggestion.decision,
    decisionReason: suggestion.decisionReason,
    decisionCaseVersion: suggestion.decisionCaseVersion,
    decidedAt: suggestion.decidedAt,
    expiresAt: suggestion.expiresAt,
    createdAt: suggestion.createdAt
  };
}

function assertHumanReviewer(actor: RequestActor, access: SupportAccess, supportCase: CaseAccessView) {
  if (actor.user.kind !== 'HUMAN' || actor.credential) throw new HttpError(403, 'A human reviewer is required');
  if (access.workspaceWide) return;
  if (supportCase.departmentId && access.managedDepartmentIds.includes(supportCase.departmentId)) return;
  throw new HttpError(403, 'Support quality review access required');
}

function validateAndScoreFindings(
  criteria: z.infer<typeof qualityCriterionSchema>[],
  findings: QualityReviewInput['findings']
) {
  const byKey = new Map(findings.map((finding) => [finding.criterionKey, finding]));
  if (byKey.size !== findings.length || byKey.size !== criteria.length
    || criteria.some((criterion) => !byKey.has(criterion.key))) {
    throw new HttpError(400, 'Findings must include every rubric criterion exactly once');
  }
  let earned = 0;
  let possible = 0;
  const normalized = criteria.map((criterion) => {
    const finding = byKey.get(criterion.key)!;
    if (finding.score > criterion.maxScore) {
      throw new HttpError(400, `Finding score exceeds maxScore for ${criterion.key}`);
    }
    earned += (finding.score / criterion.maxScore) * criterion.weight;
    possible += criterion.weight;
    return finding;
  });
  return { findings: normalized, score: Math.round((earned / possible) * 100) };
}

function hasAnySupportRead(access: SupportAccess) {
  return access.workspaceWide || access.triager || access.managedDepartmentIds.length > 0
    || access.memberMembershipIds.length > 0;
}

function csatTokenHash(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isTerminal(status: string) {
  return status === 'RESOLVED' || status === 'CLOSED';
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function versionConflict(access: SupportAccess, currentVersion: number) {
  return new HttpError(409, 'Support Case was changed by another actor', {
    ...(access.workspaceWide ? { currentVersion } : {}),
    retry: 'refetch'
  });
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
