import { createHash } from 'node:crypto';
import {
  Prisma,
  prisma,
  type SupportCase,
  type SupportEnablementDefinition,
  type SupportKnowledgeGapStatus
} from '@taskara/db';
import { z } from 'zod';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { HttpError } from './http';
import {
  requireKnowledgePageForView,
  searchKnowledgePages
} from './knowledge';
import {
  assertCanConfigureSupport,
  assertCanWorkCase,
  canReadSupportCase,
  resolveSupportAccess,
  supportCaseWhereForAccess,
  type SupportAccess
} from './support-access';
import {
  appendSupportCaseEvent,
  caseEventSnapshot,
  findSupportCaseForAccess,
  serializeSupportCase,
  supportCaseInclude,
  type SupportCaseView
} from './support-cases';
import { appendSupportCaseSyncEvent } from './support-sync';
import {
  knowledgeSpaceWhereForAccess,
  type WorkspaceAccess
} from './team-access';

const supportPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const supportImpactSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const supportUrgencySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const supportStatusSchema = z.enum([
  'NEW',
  'OPEN',
  'WAITING_ON_CUSTOMER',
  'WAITING_ON_INTERNAL',
  'RESOLVED',
  'CLOSED'
]);
const supportSourceSchema = z.enum(['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING']);
const definitionKeySchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,79}$/);
const typeKeySchema = z.string().trim().toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);

const supportEnablementActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SET_PRIORITY'), value: supportPrioritySchema }).strict(),
  z.object({ type: z.literal('SET_IMPACT'), value: supportImpactSchema.nullable() }).strict(),
  z.object({ type: z.literal('SET_URGENCY'), value: supportUrgencySchema.nullable() }).strict(),
  z.object({ type: z.literal('SET_TYPE_KEY'), value: typeKeySchema }).strict(),
  z.object({ type: z.literal('SET_NEXT_ACTION_AT'), value: z.string().datetime() }).strict(),
  z.object({ type: z.literal('CLEAR_NEXT_ACTION') }).strict()
]);

const supportEnablementActionsSchema = z.array(supportEnablementActionSchema)
  .min(1)
  .max(20)
  .superRefine((actions, context) => {
    const targets = new Set<string>();
    for (const action of actions) {
      const target = action.type === 'CLEAR_NEXT_ACTION' ? 'NEXT_ACTION_AT' : action.type.replace(/^SET_/, '');
      if (targets.has(target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Only one action may target ${target}`
        });
      }
      targets.add(target);
    }
  });

const supportAutomationConditionSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('PRIORITY'), value: supportPrioritySchema }).strict(),
  z.object({ field: z.literal('IMPACT'), value: supportImpactSchema }).strict(),
  z.object({ field: z.literal('URGENCY'), value: supportUrgencySchema }).strict(),
  z.object({ field: z.literal('STATUS'), value: supportStatusSchema }).strict(),
  z.object({ field: z.literal('SOURCE_CHANNEL'), value: supportSourceSchema }).strict(),
  z.object({ field: z.literal('TYPE_KEY'), value: typeKeySchema }).strict(),
  z.object({ field: z.literal('DEPARTMENT_ASSIGNED'), value: z.boolean() }).strict()
]);

const supportAutomationConditionsSchema = z.array(supportAutomationConditionSchema).min(1).max(20);

export const createSupportEnablementDefinitionSchema = z.object({
  kind: z.enum(['MACRO', 'TEMPLATE', 'AUTOMATION']),
  definitionKey: definitionKeySchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(1).max(1000).optional(),
  conditions: supportAutomationConditionsSchema.optional(),
  actions: supportEnablementActionsSchema
}).strict().superRefine((input, context) => {
  if (input.kind === 'AUTOMATION' && !input.conditions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conditions'],
      message: 'Automations require typed conditions'
    });
  }
  if (input.kind !== 'AUTOMATION' && input.conditions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conditions'],
      message: 'Only automations may define conditions'
    });
  }
});

export const listSupportEnablementDefinitionsSchema = z.object({
  kind: z.enum(['MACRO', 'TEMPLATE', 'AUTOMATION']).optional(),
  status: z.enum(['DRAFT', 'APPROVED', 'RETIRED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
}).strict();

export const previewSupportEnablementSchema = z.object({
  baseVersion: z.number().int().positive()
}).strict();

export const applySupportEnablementSchema = z.object({
  baseVersion: z.number().int().positive(),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();

export const undoSupportEnablementSchema = z.object({
  baseVersion: z.number().int().positive()
}).strict();

export const createSupportProblemClusterSchema = z.object({
  title: z.string().trim().min(3).max(160),
  summary: z.string().trim().min(3).max(2000).optional()
}).strict();

export const updateSupportProblemClusterSchema = z.object({
  baseVersion: z.number().int().positive(),
  title: z.string().trim().min(3).max(160).optional(),
  summary: z.string().trim().min(3).max(2000).nullable().optional(),
  status: z.enum(['OPEN', 'RESOLVED', 'ARCHIVED']).optional()
}).strict().refine(
  (input) => input.title !== undefined || input.summary !== undefined || input.status !== undefined,
  { message: 'At least one cluster change is required' }
);

export const listSupportProblemClustersSchema = z.object({
  q: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['OPEN', 'RESOLVED', 'ARCHIVED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
}).strict();

export const changeSupportProblemClusterCaseSchema = z.object({
  clusterBaseVersion: z.number().int().positive(),
  caseBaseVersion: z.number().int().positive()
}).strict();

export const searchSupportKnowledgeSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0)
}).strict();

export const recordSupportKnowledgeUseSchema = z.object({
  pageId: z.string().uuid(),
  caseBaseVersion: z.number().int().positive(),
  usefulness: z.enum(['HELPFUL', 'PARTIAL', 'NOT_HELPFUL']),
  outcome: z.enum(['RESOLVED', 'ADVANCED', 'NO_EFFECT'])
}).strict();

export const createSupportKnowledgeGapSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('MISSING'),
    caseBaseVersion: z.number().int().positive(),
    feedback: z.string().trim().min(3).max(2000)
  }).strict(),
  z.object({
    kind: z.literal('WRONG'),
    pageId: z.string().uuid(),
    caseBaseVersion: z.number().int().positive(),
    feedback: z.string().trim().min(3).max(2000)
  }).strict()
]);

export const listSupportKnowledgeGapsSchema = z.object({
  status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
}).strict();

export const updateSupportKnowledgeGapSchema = z.object({
  baseVersion: z.number().int().positive(),
  status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED']).optional(),
  reviewOwnerId: z.string().uuid().nullable().optional()
}).strict().refine(
  (input) => input.status !== undefined || input.reviewOwnerId !== undefined,
  { message: 'At least one Knowledge gap change is required' }
);

type EnablementAction = z.infer<typeof supportEnablementActionSchema>;
type AutomationCondition = z.infer<typeof supportAutomationConditionSchema>;
type ReversibleValues = {
  priority?: z.infer<typeof supportPrioritySchema>;
  impact?: z.infer<typeof supportImpactSchema> | null;
  urgency?: z.infer<typeof supportUrgencySchema> | null;
  typeKey?: string;
  nextActionAt?: string | null;
};

const reversibleValuesSchema = z.object({
  priority: supportPrioritySchema.optional(),
  impact: supportImpactSchema.nullable().optional(),
  urgency: supportUrgencySchema.nullable().optional(),
  typeKey: typeKeySchema.optional(),
  nextActionAt: z.string().datetime().nullable().optional()
}).strict();

export async function listSupportEnablementDefinitions(
  actor: RequestActor,
  rawQuery: z.input<typeof listSupportEnablementDefinitionsSchema>
) {
  const query = listSupportEnablementDefinitionsSchema.parse(rawQuery);
  const access = await resolveSupportAccess(actor);
  assertHasSupportRead(access);
  const administrator = humanWorkspaceAdministrator(actor, access);
  const where: Prisma.SupportEnablementDefinitionWhereInput = {
    workspaceId: actor.workspace.id,
    kind: query.kind,
    status: administrator ? query.status : 'APPROVED'
  };
  const [items, total] = await Promise.all([
    prisma.supportEnablementDefinition.findMany({
      where,
      orderBy: [{ definitionKey: 'asc' }, { version: 'desc' }],
      take: query.limit,
      skip: query.offset
    }),
    prisma.supportEnablementDefinition.count({ where })
  ]);
  return {
    items: items.map(serializeEnablementDefinition),
    total,
    limit: query.limit,
    offset: query.offset
  };
}

export async function createSupportEnablementDefinitionVersion(
  actor: RequestActor,
  rawInput: z.input<typeof createSupportEnablementDefinitionSchema>
) {
  const input = createSupportEnablementDefinitionSchema.parse(rawInput);
  await requireHumanSupportAdministrator(actor);
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::integer AS "locked"
      FROM pg_advisory_xact_lock(
        hashtext(${actor.workspace.id}),
        hashtext(${`${input.kind}:${input.definitionKey}`})
      )`;
    const latest = await tx.supportEnablementDefinition.findFirst({
      where: {
        workspaceId: actor.workspace.id,
        kind: input.kind,
        definitionKey: input.definitionKey
      },
      orderBy: { version: 'desc' },
      select: { version: true }
    });
    return tx.supportEnablementDefinition.create({
      data: {
        workspaceId: actor.workspace.id,
        kind: input.kind,
        definitionKey: input.definitionKey,
        version: (latest?.version ?? 0) + 1,
        name: input.name,
        description: input.description,
        conditions: input.conditions
          ? input.conditions as Prisma.InputJsonValue
          : Prisma.DbNull,
        actions: input.actions as Prisma.InputJsonValue,
        createdById: actor.user.id
      }
    });
  });
  return serializeEnablementDefinition(created);
}

export async function approveSupportEnablementDefinition(actor: RequestActor, id: string) {
  await requireHumanSupportAdministrator(actor);
  const approved = await prisma.$transaction(async (tx) => {
    await lockDefinition(tx, actor.workspace.id, id);
    const current = await tx.supportEnablementDefinition.findFirst({
      where: { id: uuidOrImpossible(id), workspaceId: actor.workspace.id }
    });
    if (!current) throw new HttpError(404, 'Support enablement definition not found');
    if (current.status !== 'DRAFT') {
      throw new HttpError(409, 'Only a draft Support enablement definition can be approved');
    }
    const latest = await tx.supportEnablementDefinition.findFirst({
      where: {
        workspaceId: current.workspaceId,
        kind: current.kind,
        definitionKey: current.definitionKey
      },
      orderBy: { version: 'desc' },
      select: { id: true, version: true }
    });
    if (latest?.id !== current.id) {
      throw new HttpError(409, 'Only the latest Support enablement version can be approved', {
        code: 'SUPPORT_ENABLEMENT_NOT_LATEST',
        latestVersion: latest?.version
      });
    }
    const now = new Date();
    await tx.supportEnablementDefinition.updateMany({
      where: {
        workspaceId: current.workspaceId,
        kind: current.kind,
        definitionKey: current.definitionKey,
        status: 'APPROVED'
      },
      data: {
        status: 'RETIRED',
        retiredById: actor.user.id,
        retiredAt: now
      }
    });
    return tx.supportEnablementDefinition.update({
      where: { id: current.id },
      data: {
        status: 'APPROVED',
        approvedById: actor.user.id,
        approvedAt: now
      }
    });
  });
  return serializeEnablementDefinition(approved);
}

export async function retireSupportEnablementDefinition(actor: RequestActor, id: string) {
  await requireHumanSupportAdministrator(actor);
  const retired = await prisma.$transaction(async (tx) => {
    await lockDefinition(tx, actor.workspace.id, id);
    const current = await tx.supportEnablementDefinition.findFirst({
      where: { id: uuidOrImpossible(id), workspaceId: actor.workspace.id }
    });
    if (!current) throw new HttpError(404, 'Support enablement definition not found');
    if (current.status !== 'APPROVED') {
      throw new HttpError(409, 'Only an approved Support enablement definition can be retired');
    }
    return tx.supportEnablementDefinition.update({
      where: { id: current.id },
      data: { status: 'RETIRED', retiredById: actor.user.id, retiredAt: new Date() }
    });
  });
  return serializeEnablementDefinition(retired);
}

export async function previewSupportEnablement(
  actor: RequestActor,
  idOrKey: string,
  definitionId: string,
  rawInput: z.input<typeof previewSupportEnablementSchema>
) {
  const input = previewSupportEnablementSchema.parse(rawInput);
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  assertCaseVersion(supportCase, input.baseVersion, access);
  const definition = await requireApprovedDefinition(actor.workspace.id, definitionId);
  return publicEnablementPreview(buildEnablementPreview(definition, supportCase));
}

export async function evaluateSupportAutomations(
  actor: RequestActor,
  idOrKey: string,
  rawInput: z.input<typeof previewSupportEnablementSchema>
) {
  const input = previewSupportEnablementSchema.parse(rawInput);
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  assertCaseVersion(supportCase, input.baseVersion, access);
  const definitions = await prisma.supportEnablementDefinition.findMany({
    where: {
      workspaceId: actor.workspace.id,
      kind: 'AUTOMATION',
      status: 'APPROVED'
    },
    orderBy: [{ definitionKey: 'asc' }, { version: 'desc' }]
  });
  const evaluations = definitions.map((definition) => publicEnablementPreview(
    buildEnablementPreview(definition, supportCase)
  ));
  return {
    items: evaluations,
    matchedCount: evaluations.filter((item) => item.conditionMatched).length,
    requiresHumanApply: true,
    caseVersion: supportCase.version
  };
}

export async function applySupportEnablement(
  actor: RequestActor,
  idOrKey: string,
  definitionId: string,
  rawInput: z.input<typeof applySupportEnablementSchema>
) {
  const input = applySupportEnablementSchema.parse(rawInput);
  assertHumanActor(actor, 'A human Support user must apply enablement actions');
  return prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    const current = await lockCaseForAccess(tx, actor, idOrKey, access);
    assertCaseVersion(current, input.baseVersion, access);
    assertCanWorkCase(access, current);
    if (current.status === 'RESOLVED' || current.status === 'CLOSED') {
      throw new HttpError(409, 'Terminal Support Cases cannot receive enablement actions');
    }
    const definition = await tx.supportEnablementDefinition.findFirst({
      where: {
        id: uuidOrImpossible(definitionId),
        workspaceId: actor.workspace.id,
        status: 'APPROVED'
      }
    });
    if (!definition) throw new HttpError(404, 'Approved Support enablement definition not found');
    const preview = buildEnablementPreview(definition, current);
    if (preview.previewHash !== input.previewHash) {
      throw new HttpError(409, 'Support enablement preview is stale', {
        code: 'SUPPORT_ENABLEMENT_PREVIEW_STALE',
        currentVersion: current.version
      });
    }
    if (!preview.conditionMatched) {
      throw new HttpError(409, 'Automation conditions no longer match this Support Case');
    }
    if (!preview.changes.length) {
      throw new HttpError(409, 'Support enablement has no changes to apply');
    }
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: {
        ...caseUpdateFromValues(preview.after),
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });
    const application = await tx.supportEnablementApplication.create({
      data: {
        workspaceId: actor.workspace.id,
        definitionId: definition.id,
        caseId: current.id,
        caseVersionBefore: current.version,
        caseVersionAfter: updated.version,
        previewHash: preview.previewHash,
        before: preview.before as Prisma.InputJsonObject,
        after: preview.after as Prisma.InputJsonObject,
        appliedById: actor.user.id
      }
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.enablement_applied',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: `${definition.kind} ${definition.definitionKey} v${definition.version}; application ${application.id}`
    });
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
    return {
      application: serializeEnablementApplication(application),
      case: serializeSupportCase(updated, access)
    };
  });
}

export async function undoSupportEnablementApplication(
  actor: RequestActor,
  applicationId: string,
  rawInput: z.input<typeof undoSupportEnablementSchema>
) {
  const input = undoSupportEnablementSchema.parse(rawInput);
  assertHumanActor(actor, 'A human Support user must undo enablement actions');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "SupportEnablementApplication"
      WHERE "workspaceId" = ${actor.workspace.id}::uuid AND "id"::text = ${applicationId}
      FOR UPDATE`;
    const application = await tx.supportEnablementApplication.findFirst({
      where: { id: uuidOrImpossible(applicationId), workspaceId: actor.workspace.id }
    });
    if (!application) throw new HttpError(404, 'Support enablement application not found');
    const access = await resolveSupportAccess(actor, tx);
    const current = await lockCaseForAccess(tx, actor, application.caseId, access);
    assertCaseVersion(current, input.baseVersion, access);
    assertCanWorkCase(access, current);
    if (application.undoneAt) {
      throw new HttpError(409, 'Support enablement application was already undone');
    }
    if (current.status === 'RESOLVED' || current.status === 'CLOSED') {
      throw new HttpError(409, 'Terminal Support Cases cannot undo enablement actions');
    }
    const before = parseReversibleValues(application.before);
    const after = parseReversibleValues(application.after);
    if (!caseMatchesValues(current, after)) {
      throw new HttpError(409, 'Support Case fields changed after this enablement application', {
        code: 'SUPPORT_ENABLEMENT_UNDO_FIELD_CONFLICT',
        currentVersion: current.version
      });
    }
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: { ...caseUpdateFromValues(before), version: { increment: 1 } },
      include: supportCaseInclude
    });
    const undone = await tx.supportEnablementApplication.update({
      where: { id: application.id },
      data: {
        undoneById: actor.user.id,
        undoneAt: new Date(),
        undoCaseVersion: updated.version
      }
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.enablement_undone',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: `Undo enablement application ${application.id}`
    });
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
    return {
      application: serializeEnablementApplication(undone),
      case: serializeSupportCase(updated, access)
    };
  });
}

export async function listSupportProblemClusters(
  actor: RequestActor,
  rawQuery: z.input<typeof listSupportProblemClustersSchema>
) {
  const query = listSupportProblemClustersSchema.parse(rawQuery);
  const access = await resolveSupportAccess(actor);
  assertHasSupportRead(access);
  const visibility = clusterVisibilityWhere(actor, access);
  const where: Prisma.SupportProblemClusterWhereInput = {
    AND: [
      { workspaceId: actor.workspace.id },
      visibility,
      query.status ? { status: query.status } : {},
      query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { summary: { contains: query.q, mode: 'insensitive' } }
            ]
          }
        : {}
    ]
  };
  const [rows, total] = await Promise.all([
    prisma.supportProblemCluster.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      skip: query.offset
    }),
    prisma.supportProblemCluster.count({ where })
  ]);
  const counts = await visibleClusterCounts(rows.map((row) => row.id), access);
  return {
    items: rows.map((row) => serializeProblemCluster(row, counts.get(row.id) ?? 0)),
    total,
    limit: query.limit,
    offset: query.offset
  };
}

export async function getSupportProblemCluster(actor: RequestActor, id: string) {
  const access = await resolveSupportAccess(actor);
  assertHasSupportRead(access);
  const cluster = await prisma.supportProblemCluster.findFirst({
    where: {
      id: uuidOrImpossible(id),
      workspaceId: actor.workspace.id,
      AND: [clusterVisibilityWhere(actor, access)]
    }
  });
  if (!cluster) throw new HttpError(404, 'Support problem cluster not found');
  const links = await prisma.supportProblemClusterCase.findMany({
    where: { clusterId: cluster.id, case: supportCaseWhereForAccess(access) },
    include: {
      case: {
        select: {
          id: true,
          key: true,
          title: true,
          status: true,
          priority: true,
          departmentId: true,
          assigneeMembershipId: true,
          version: true,
          updatedAt: true
        }
      }
    },
    orderBy: { linkedAt: 'asc' }
  });
  return {
    ...serializeProblemCluster(cluster, links.length),
    cases: links.map((link) => ({ ...link.case, linkedAt: link.linkedAt.toISOString() })),
    accessEpoch: access.epoch.toString()
  };
}

export async function createSupportProblemCluster(
  actor: RequestActor,
  rawInput: z.input<typeof createSupportProblemClusterSchema>
) {
  const input = createSupportProblemClusterSchema.parse(rawInput);
  await requireHumanClusterManager(actor);
  const cluster = await prisma.supportProblemCluster.create({
    data: {
      workspaceId: actor.workspace.id,
      title: cleanClusterText(input.title),
      summary: input.summary ? cleanClusterText(input.summary) : undefined,
      createdById: actor.user.id
    }
  });
  return serializeProblemCluster(cluster, 0);
}

export async function updateSupportProblemCluster(
  actor: RequestActor,
  id: string,
  rawInput: z.input<typeof updateSupportProblemClusterSchema>
) {
  const input = updateSupportProblemClusterSchema.parse(rawInput);
  const updated = await prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    await lockCluster(tx, actor.workspace.id, id);
    const current = await tx.supportProblemCluster.findFirst({
      where: { id: uuidOrImpossible(id), workspaceId: actor.workspace.id }
    });
    if (!current || !(await canManageCluster(tx, actor, access, current))) {
      throw new HttpError(404, 'Support problem cluster not found');
    }
    assertAggregateVersion('Support problem cluster', current.version, input.baseVersion);
    return tx.supportProblemCluster.update({
      where: { id: current.id },
      data: {
        title: input.title === undefined ? undefined : cleanClusterText(input.title),
        summary: input.summary === undefined
          ? undefined
          : input.summary === null ? null : cleanClusterText(input.summary),
        status: input.status,
        version: { increment: 1 }
      }
    });
  });
  const access = await resolveSupportAccess(actor);
  const counts = await visibleClusterCounts([updated.id], access);
  return serializeProblemCluster(updated, counts.get(updated.id) ?? 0);
}

export async function linkSupportProblemClusterCase(
  actor: RequestActor,
  clusterId: string,
  idOrKey: string,
  rawInput: z.input<typeof changeSupportProblemClusterCaseSchema>
) {
  const input = changeSupportProblemClusterCaseSchema.parse(rawInput);
  await changeProblemClusterCase(actor, clusterId, idOrKey, input, 'link');
  return getSupportProblemCluster(actor, clusterId);
}

export async function unlinkSupportProblemClusterCase(
  actor: RequestActor,
  clusterId: string,
  idOrKey: string,
  rawInput: z.input<typeof changeSupportProblemClusterCaseSchema>
) {
  const input = changeSupportProblemClusterCaseSchema.parse(rawInput);
  await changeProblemClusterCase(actor, clusterId, idOrKey, input, 'unlink');
}

export async function searchSupportKnowledgeForCase(
  actor: RequestActor,
  idOrKey: string,
  rawQuery: z.input<typeof searchSupportKnowledgeSchema>
) {
  const query = searchSupportKnowledgeSchema.parse(rawQuery);
  assertHumanActor(actor, 'Knowledge access is not granted by a Support agent credential');
  const { supportCase } = await findSupportCaseForAccess(actor, idOrKey);
  const results = await searchKnowledgePages(actor, query);
  return {
    ...results,
    case: { id: supportCase.id, key: supportCase.key, version: supportCase.version },
    accessDoesNotTransfer: true
  };
}

export async function listSupportCaseKnowledgeUses(actor: RequestActor, idOrKey: string) {
  assertHumanActor(actor, 'Knowledge access is not granted by a Support agent credential');
  const { supportCase } = await findSupportCaseForAccess(actor, idOrKey);
  const rows = await prisma.supportCaseKnowledgeUse.findMany({
    where: { workspaceId: actor.workspace.id, caseId: supportCase.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  const visible = [];
  for (const row of rows) {
    try {
      const page = await requireKnowledgePageForView(actor, row.knowledgePageId);
      visible.push({
        ...serializeKnowledgeUse(row),
        page: { id: page.id, title: page.title, version: page.version, status: page.status }
      });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) continue;
      throw error;
    }
  }
  return { items: visible, visibleCount: visible.length };
}

export async function recordSupportCaseKnowledgeUse(
  actor: RequestActor,
  idOrKey: string,
  rawInput: z.input<typeof recordSupportKnowledgeUseSchema>
) {
  const input = recordSupportKnowledgeUseSchema.parse(rawInput);
  assertHumanActor(actor, 'A human Support user must record Knowledge use');
  const page = await requireKnowledgePageForView(actor, input.pageId);
  if (page.workspaceId !== actor.workspace.id) throw new HttpError(404, 'Knowledge page not found');
  return prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    const current = await lockCaseForAccess(tx, actor, idOrKey, access);
    assertCaseVersion(current, input.caseBaseVersion, access);
    assertCanWorkCase(access, current);
    const currentPage = await findReadableKnowledgePageAtCommit(tx, actor, page.id);
    if (!currentPage) throw new HttpError(404, 'Knowledge page not found');
    const use = await tx.supportCaseKnowledgeUse.create({
      data: {
        workspaceId: actor.workspace.id,
        caseId: current.id,
        knowledgePageId: currentPage.id,
        caseVersion: current.version,
        knowledgePageVersion: currentPage.version,
        usefulness: input.usefulness,
        outcome: input.outcome,
        createdById: actor.user.id
      }
    });
    await appendSupportCaseEvent(tx, actor, current, {
      action: 'case.knowledge_used',
      after: caseEventSnapshot(current),
      reason: `Knowledge use ${use.id}; page ${currentPage.id} v${currentPage.version}; ${input.usefulness}/${input.outcome}`
    });
    return {
      ...serializeKnowledgeUse(use),
      page: currentPage
    };
  });
}

export async function createSupportKnowledgeGap(
  actor: RequestActor,
  idOrKey: string,
  rawInput: z.input<typeof createSupportKnowledgeGapSchema>
) {
  const input = createSupportKnowledgeGapSchema.parse(rawInput);
  assertHumanActor(actor, 'A human Support user must create a Knowledge gap');
  const page = input.kind === 'WRONG'
    ? await requireKnowledgePageForView(actor, input.pageId)
    : null;
  if (page && page.workspaceId !== actor.workspace.id) throw new HttpError(404, 'Knowledge page not found');
  return prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    const current = await lockCaseForAccess(tx, actor, idOrKey, access);
    assertCaseVersion(current, input.caseBaseVersion, access);
    assertCanWorkCase(access, current);
    if (page) {
      const currentPage = await findReadableKnowledgePageAtCommit(tx, actor, page.id);
      if (!currentPage) throw new HttpError(404, 'Knowledge page not found');
    }
    const gap = await tx.supportKnowledgeGap.create({
      data: {
        workspaceId: actor.workspace.id,
        caseId: current.id,
        kind: input.kind,
        knowledgePageId: page?.id,
        feedback: cleanClusterText(input.feedback),
        createdById: actor.user.id
      }
    });
    await appendSupportCaseEvent(tx, actor, current, {
      action: 'case.knowledge_gap_created',
      after: caseEventSnapshot(current),
      reason: `Knowledge gap ${gap.id}; ${gap.kind}${gap.knowledgePageId ? `; page ${gap.knowledgePageId}` : ''}`
    });
    return serializeKnowledgeGap(gap);
  });
}

export async function listSupportKnowledgeGaps(
  actor: RequestActor,
  rawQuery: z.input<typeof listSupportKnowledgeGapsSchema>
) {
  const query = listSupportKnowledgeGapsSchema.parse(rawQuery);
  assertHumanActor(actor, 'Knowledge access is not granted by a Support agent credential');
  const access = await resolveSupportAccess(actor);
  assertHasSupportRead(access);
  const candidates = await prisma.supportKnowledgeGap.findMany({
    where: {
      workspaceId: actor.workspace.id,
      status: query.status,
      case: supportCaseWhereForAccess(access)
    },
    include: {
      case: { select: { id: true, key: true, title: true, version: true } }
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    // Fetch extra candidates because independently revoked Knowledge access can remove WRONG rows.
    take: Math.min(query.limit * 3, 300),
    skip: query.offset
  });
  const visible = [];
  for (const gap of candidates) {
    if (gap.knowledgePageId) {
      try {
        const page = await requireKnowledgePageForView(actor, gap.knowledgePageId);
        visible.push({
          ...serializeKnowledgeGap(gap),
          case: gap.case,
          page: { id: page.id, title: page.title, version: page.version, status: page.status }
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 404) continue;
        throw error;
      }
    } else {
      visible.push({ ...serializeKnowledgeGap(gap), case: gap.case, page: null });
    }
    if (visible.length === query.limit) break;
  }
  return {
    items: visible,
    visibleCount: visible.length,
    limit: query.limit,
    offset: query.offset
  };
}

export async function updateSupportKnowledgeGap(
  actor: RequestActor,
  id: string,
  rawInput: z.input<typeof updateSupportKnowledgeGapSchema>
) {
  const input = updateSupportKnowledgeGapSchema.parse(rawInput);
  assertHumanActor(actor, 'A human Support reviewer must update a Knowledge gap');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "SupportKnowledgeGap"
      WHERE "workspaceId" = ${actor.workspace.id}::uuid AND "id"::text = ${id}
      FOR UPDATE`;
    const current = await tx.supportKnowledgeGap.findFirst({
      where: { id: uuidOrImpossible(id), workspaceId: actor.workspace.id }
    });
    if (!current) throw new HttpError(404, 'Support Knowledge gap not found');
    const access = await resolveSupportAccess(actor, tx);
    const supportCase = await lockCaseForAccess(tx, actor, current.caseId, access);
    if (!canReviewGap(access, supportCase)) {
      throw new HttpError(404, 'Support Knowledge gap not found');
    }
    assertAggregateVersion('Support Knowledge gap', current.version, input.baseVersion);
    if (current.knowledgePageId) {
      const currentPage = await findReadableKnowledgePageAtCommit(tx, actor, current.knowledgePageId);
      if (!currentPage) throw new HttpError(404, 'Knowledge page not found');
    }
    if (input.reviewOwnerId) {
      const owner = await tx.workspaceMember.findFirst({
        where: {
          workspaceId: actor.workspace.id,
          userId: input.reviewOwnerId,
          user: { kind: 'HUMAN' }
        },
        select: { userId: true }
      });
      if (!owner) throw new HttpError(400, 'Knowledge gap review owner must be a human workspace member');
    }
    const status = input.status ?? current.status;
    const updated = await tx.supportKnowledgeGap.update({
      where: { id: current.id },
      data: {
        status,
        reviewOwnerId: input.reviewOwnerId,
        resolvedAt: status === 'RESOLVED'
          ? current.resolvedAt ?? new Date()
          : null,
        version: { increment: 1 }
      }
    });
    await appendSupportCaseEvent(tx, actor, supportCase, {
      action: 'case.knowledge_gap_reviewed',
      after: caseEventSnapshot(supportCase),
      reason: `Knowledge gap ${updated.id}; ${current.status} -> ${updated.status}`
    });
    return serializeKnowledgeGap(updated);
  });
}

function serializeEnablementDefinition(definition: SupportEnablementDefinition) {
  return {
    id: definition.id,
    kind: definition.kind,
    definitionKey: definition.definitionKey,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    status: definition.status,
    conditions: definition.conditions === null
      ? null
      : supportAutomationConditionsSchema.parse(definition.conditions),
    actions: supportEnablementActionsSchema.parse(definition.actions),
    createdById: definition.createdById,
    approvedById: definition.approvedById,
    approvedAt: definition.approvedAt?.toISOString() ?? null,
    retiredById: definition.retiredById,
    retiredAt: definition.retiredAt?.toISOString() ?? null,
    createdAt: definition.createdAt.toISOString()
  };
}

function serializeEnablementApplication(application: {
  id: string;
  definitionId: string;
  caseId: string;
  caseVersionBefore: number;
  caseVersionAfter: number;
  previewHash: string;
  appliedAt: Date;
  undoneAt: Date | null;
  undoCaseVersion: number | null;
}) {
  return {
    id: application.id,
    definitionId: application.definitionId,
    caseId: application.caseId,
    caseVersionBefore: application.caseVersionBefore,
    caseVersionAfter: application.caseVersionAfter,
    previewHash: application.previewHash,
    appliedAt: application.appliedAt.toISOString(),
    undoneAt: application.undoneAt?.toISOString() ?? null,
    undoCaseVersion: application.undoCaseVersion
  };
}

function buildEnablementPreview(
  definition: SupportEnablementDefinition,
  supportCase: SupportCaseView
) {
  const actions = supportEnablementActionsSchema.parse(definition.actions);
  const conditions = definition.conditions === null
    ? []
    : supportAutomationConditionsSchema.parse(definition.conditions);
  const conditionResults = conditions.map((condition) => ({
    field: condition.field,
    matched: automationConditionMatches(condition, supportCase)
  }));
  const conditionMatched = conditionResults.every((result) => result.matched);
  const { before, after, changes } = reversibleChangeSet(actions, supportCase);
  const previewHash = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    definition: {
      id: definition.id,
      kind: definition.kind,
      key: definition.definitionKey,
      version: definition.version
    },
    case: { id: supportCase.id, version: supportCase.version },
    conditionMatched,
    changes
  })).digest('hex');
  return {
    definition,
    caseId: supportCase.id,
    caseKey: supportCase.key,
    caseVersion: supportCase.version,
    conditionMatched,
    conditionResults,
    changes,
    before,
    after,
    previewHash
  };
}

function publicEnablementPreview(preview: ReturnType<typeof buildEnablementPreview>) {
  return {
    definition: serializeEnablementDefinition(preview.definition),
    case: { id: preview.caseId, key: preview.caseKey, version: preview.caseVersion },
    conditionMatched: preview.conditionMatched,
    conditionResults: preview.conditionResults,
    changes: preview.changes,
    previewHash: preview.previewHash,
    canApply: preview.conditionMatched && preview.changes.length > 0,
    requiresHumanApply: true
  };
}

function reversibleChangeSet(actions: EnablementAction[], supportCase: SupportCaseView) {
  const before: ReversibleValues = {};
  const after: ReversibleValues = {};
  for (const action of actions) {
    switch (action.type) {
      case 'SET_PRIORITY':
        before.priority = supportCase.priority;
        after.priority = action.value;
        break;
      case 'SET_IMPACT':
        before.impact = supportCase.impact;
        after.impact = action.value;
        break;
      case 'SET_URGENCY':
        before.urgency = supportCase.urgency;
        after.urgency = action.value;
        break;
      case 'SET_TYPE_KEY':
        before.typeKey = supportCase.typeKey;
        after.typeKey = action.value;
        break;
      case 'SET_NEXT_ACTION_AT':
        before.nextActionAt = supportCase.nextActionAt?.toISOString() ?? null;
        after.nextActionAt = new Date(action.value).toISOString();
        break;
      case 'CLEAR_NEXT_ACTION':
        before.nextActionAt = supportCase.nextActionAt?.toISOString() ?? null;
        after.nextActionAt = null;
        break;
    }
  }
  const changes = (Object.keys(after) as Array<keyof ReversibleValues>)
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
  return { before, after, changes };
}

function automationConditionMatches(condition: AutomationCondition, supportCase: SupportCaseView): boolean {
  switch (condition.field) {
    case 'PRIORITY': return supportCase.priority === condition.value;
    case 'IMPACT': return supportCase.impact === condition.value;
    case 'URGENCY': return supportCase.urgency === condition.value;
    case 'STATUS': return supportCase.status === condition.value;
    case 'SOURCE_CHANNEL': return supportCase.sourceChannel === condition.value;
    case 'TYPE_KEY': return supportCase.typeKey === condition.value;
    case 'DEPARTMENT_ASSIGNED': return Boolean(supportCase.departmentId) === condition.value;
  }
}

function caseUpdateFromValues(values: ReversibleValues): Prisma.SupportCaseUpdateInput {
  const data: Prisma.SupportCaseUpdateInput = {};
  if (values.priority !== undefined) data.priority = values.priority;
  if (values.impact !== undefined) data.impact = values.impact;
  if (values.urgency !== undefined) data.urgency = values.urgency;
  if (values.typeKey !== undefined) data.typeKey = values.typeKey;
  if (values.nextActionAt !== undefined) {
    data.nextActionAt = values.nextActionAt === null ? null : new Date(values.nextActionAt);
  }
  return data;
}

function caseMatchesValues(supportCase: SupportCaseView, values: ReversibleValues): boolean {
  if (values.priority !== undefined && supportCase.priority !== values.priority) return false;
  if (values.impact !== undefined && supportCase.impact !== values.impact) return false;
  if (values.urgency !== undefined && supportCase.urgency !== values.urgency) return false;
  if (values.typeKey !== undefined && supportCase.typeKey !== values.typeKey) return false;
  if (
    values.nextActionAt !== undefined
    && (supportCase.nextActionAt?.toISOString() ?? null) !== values.nextActionAt
  ) return false;
  return true;
}

function parseReversibleValues(value: Prisma.JsonValue): ReversibleValues {
  return reversibleValuesSchema.parse(value);
}

async function changeProblemClusterCase(
  actor: RequestActor,
  clusterId: string,
  idOrKey: string,
  input: z.infer<typeof changeSupportProblemClusterCaseSchema>,
  operation: 'link' | 'unlink'
) {
  assertHumanActor(actor, 'A human Support manager must manage problem clusters');
  await prisma.$transaction(async (tx) => {
    const access = await resolveSupportAccess(actor, tx);
    await lockCluster(tx, actor.workspace.id, clusterId);
    const cluster = await tx.supportProblemCluster.findFirst({
      where: { id: uuidOrImpossible(clusterId), workspaceId: actor.workspace.id }
    });
    if (!cluster || !(await canManageCluster(tx, actor, access, cluster))) {
      throw new HttpError(404, 'Support problem cluster not found');
    }
    assertAggregateVersion('Support problem cluster', cluster.version, input.clusterBaseVersion);
    const supportCase = await lockCaseForAccess(tx, actor, idOrKey, access);
    assertCaseVersion(supportCase, input.caseBaseVersion, access);
    assertCanManageClusterCase(access, supportCase);
    const existing = await tx.supportProblemClusterCase.findUnique({
      where: { clusterId_caseId: { clusterId: cluster.id, caseId: supportCase.id } }
    });
    if (operation === 'link' && existing) {
      throw new HttpError(409, 'Support Case is already linked to this problem cluster');
    }
    if (operation === 'unlink' && !existing) {
      throw new HttpError(404, 'Support Case is not linked to this problem cluster');
    }
    if (operation === 'link') {
      await tx.supportProblemClusterCase.create({
        data: {
          workspaceId: actor.workspace.id,
          clusterId: cluster.id,
          caseId: supportCase.id,
          linkedById: actor.user.id
        }
      });
    } else {
      await tx.supportProblemClusterCase.delete({
        where: { clusterId_caseId: { clusterId: cluster.id, caseId: supportCase.id } }
      });
    }
    await tx.supportProblemCluster.update({
      where: { id: cluster.id },
      data: { version: { increment: 1 } }
    });
    const updatedCase = await tx.supportCase.update({
      where: { id: supportCase.id },
      data: { version: { increment: 1 } },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updatedCase, {
      action: operation === 'link'
        ? 'case.problem_cluster_linked'
        : 'case.problem_cluster_unlinked',
      before: caseEventSnapshot(supportCase),
      after: caseEventSnapshot(updatedCase),
      reason: `Problem cluster ${cluster.id}`
    });
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updatedCase.id,
      caseVersion: updatedCase.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
  });
}

function clusterVisibilityWhere(
  actor: RequestActor,
  access: SupportAccess
): Prisma.SupportProblemClusterWhereInput {
  const visibleCase: Prisma.SupportProblemClusterWhereInput = {
    cases: { some: { case: supportCaseWhereForAccess(access) } }
  };
  if (!access.credentialActor && access.workspaceWide) return {};
  if (!access.credentialActor && access.managedDepartmentIds.length) {
    return {
      OR: [
        visibleCase,
        { createdById: actor.user.id, cases: { none: {} } }
      ]
    };
  }
  return visibleCase;
}

async function visibleClusterCounts(clusterIds: string[], access: SupportAccess) {
  const counts = new Map<string, number>();
  await Promise.all(clusterIds.map(async (clusterId) => {
    const count = await prisma.supportProblemClusterCase.count({
      where: { clusterId, case: supportCaseWhereForAccess(access) }
    });
    counts.set(clusterId, count);
  }));
  return counts;
}

async function canManageCluster(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  access: SupportAccess,
  cluster: { id: string; createdById: string | null }
): Promise<boolean> {
  if (access.credentialActor || actor.user.kind !== 'HUMAN') return false;
  if (access.workspaceWide) return true;
  if (!access.managedDepartmentIds.length) return false;
  if (cluster.createdById === actor.user.id) {
    const anyLinkedCase = await tx.supportProblemClusterCase.findFirst({
      where: { clusterId: cluster.id },
      select: { caseId: true }
    });
    if (!anyLinkedCase) return true;
  }
  const visibleManagedCase = await tx.supportProblemClusterCase.findFirst({
    where: {
      clusterId: cluster.id,
      case: {
        workspaceId: actor.workspace.id,
        departmentId: { in: access.managedDepartmentIds }
      }
    },
    select: { caseId: true }
  });
  return Boolean(visibleManagedCase);
}

function assertCanManageClusterCase(access: SupportAccess, supportCase: SupportCaseView) {
  assertCanWorkCase(access, supportCase);
  if (access.workspaceWide) return;
  if (supportCase.departmentId && access.managedDepartmentIds.includes(supportCase.departmentId)) return;
  throw new HttpError(404, 'Support Case not found');
}

async function requireHumanClusterManager(actor: RequestActor): Promise<SupportAccess> {
  assertHumanActor(actor, 'A human Support manager must manage problem clusters');
  const access = await resolveSupportAccess(actor);
  if (access.workspaceWide || access.managedDepartmentIds.length) return access;
  throw new HttpError(403, 'Support problem cluster management access required');
}

function canReviewGap(access: SupportAccess, supportCase: SupportCase): boolean {
  if (access.credentialActor || !canReadSupportCase(access, supportCase)) return false;
  if (access.workspaceWide) return true;
  return Boolean(
    supportCase.departmentId
    && access.managedDepartmentIds.includes(supportCase.departmentId)
  );
}

function serializeProblemCluster(
  cluster: {
    id: string;
    title: string;
    summary: string | null;
    status: string;
    version: number;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  visibleMemberCount: number
) {
  return {
    id: cluster.id,
    title: cluster.title,
    summary: cluster.summary,
    status: cluster.status,
    version: cluster.version,
    createdById: cluster.createdById,
    createdAt: cluster.createdAt.toISOString(),
    updatedAt: cluster.updatedAt.toISOString(),
    visibleMemberCount
  };
}

function serializeKnowledgeUse(use: {
  id: string;
  caseId: string;
  knowledgePageId: string;
  caseVersion: number;
  knowledgePageVersion: number;
  usefulness: string;
  outcome: string;
  createdById: string | null;
  createdAt: Date;
}) {
  return {
    id: use.id,
    caseId: use.caseId,
    knowledgePageId: use.knowledgePageId,
    caseVersion: use.caseVersion,
    knowledgePageVersion: use.knowledgePageVersion,
    usefulness: use.usefulness,
    outcome: use.outcome,
    createdById: use.createdById,
    createdAt: use.createdAt.toISOString()
  };
}

function serializeKnowledgeGap(gap: {
  id: string;
  caseId: string;
  knowledgePageId: string | null;
  kind: string;
  status: string;
  feedback: string;
  reviewOwnerId: string | null;
  createdById: string | null;
  resolvedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: gap.id,
    caseId: gap.caseId,
    knowledgePageId: gap.knowledgePageId,
    kind: gap.kind,
    status: gap.status,
    feedback: gap.feedback,
    reviewOwnerId: gap.reviewOwnerId,
    createdById: gap.createdById,
    resolvedAt: gap.resolvedAt?.toISOString() ?? null,
    version: gap.version,
    createdAt: gap.createdAt.toISOString(),
    updatedAt: gap.updatedAt.toISOString()
  };
}

async function requireHumanSupportAdministrator(actor: RequestActor): Promise<SupportAccess> {
  assertHumanActor(actor, 'A human workspace administrator must manage Support enablement');
  const access = await resolveSupportAccess(actor);
  assertCanConfigureSupport(access);
  if (!isWorkspaceAdminRole(actor.role)) {
    throw new HttpError(403, 'Workspace administrator access required');
  }
  return access;
}

function humanWorkspaceAdministrator(actor: RequestActor, access: SupportAccess): boolean {
  return actor.user.kind === 'HUMAN'
    && !actor.credential
    && isWorkspaceAdminRole(actor.role)
    && access.canConfigure;
}

function assertHumanActor(actor: RequestActor, message: string) {
  if (actor.user.kind === 'HUMAN' && !actor.credential) return;
  throw new HttpError(403, message);
}

function assertHasSupportRead(access: SupportAccess) {
  if (
    access.workspaceWide
    || access.triager
    || access.managedDepartmentIds.length
    || access.memberMembershipIds.length
  ) return;
  throw new HttpError(403, 'Support read access required');
}

async function requireApprovedDefinition(workspaceId: string, id: string) {
  const definition = await prisma.supportEnablementDefinition.findFirst({
    where: { id: uuidOrImpossible(id), workspaceId, status: 'APPROVED' }
  });
  if (!definition) throw new HttpError(404, 'Approved Support enablement definition not found');
  return definition;
}

async function findReadableKnowledgePageAtCommit(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  pageId: string
) {
  const access = await resolveKnowledgeAccessAtCommit(tx, actor);
  return tx.knowledgePage.findFirst({
    where: {
      id: pageId,
      workspaceId: actor.workspace.id,
      space: knowledgeSpaceWhereForAccess(access)
    },
    select: { id: true, workspaceId: true, version: true, title: true, status: true }
  });
}

async function resolveKnowledgeAccessAtCommit(
  tx: Prisma.TransactionClient,
  actor: RequestActor
): Promise<WorkspaceAccess> {
  assertHumanActor(actor, 'Knowledge access is not granted by a Support agent credential');
  if (isWorkspaceAdminRole(actor.role)) {
    return {
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      workspaceWide: true,
      teamIds: [],
      projectIds: []
    };
  }
  const [teamMemberships, projectMemberships, ledProjects] = await Promise.all([
    tx.teamMember.findMany({
      where: { userId: actor.user.id, team: { workspaceId: actor.workspace.id } },
      select: { teamId: true }
    }),
    tx.projectMember.findMany({
      where: { userId: actor.user.id, project: { workspaceId: actor.workspace.id } },
      select: { projectId: true }
    }),
    tx.project.findMany({
      where: { workspaceId: actor.workspace.id, leadId: actor.user.id },
      select: { id: true }
    })
  ]);
  return {
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    workspaceWide: false,
    teamIds: [...new Set(teamMemberships.map((membership) => membership.teamId))],
    projectIds: [...new Set([
      ...projectMemberships.map((membership) => membership.projectId),
      ...ledProjects.map((project) => project.id)
    ])]
  };
}

async function lockDefinition(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "SupportEnablementDefinition"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "id"::text = ${id}
    FOR UPDATE`;
}

async function lockCluster(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "SupportProblemCluster"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "id"::text = ${id}
    FOR UPDATE`;
}

async function lockCaseForAccess(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  idOrKey: string,
  access: SupportAccess
): Promise<SupportCaseView> {
  await tx.$queryRaw`SELECT "id" FROM "SupportCase"
    WHERE "workspaceId" = ${actor.workspace.id}::uuid
      AND ("id"::text = ${idOrKey} OR "key" = ${idOrKey})
    FOR UPDATE`;
  const current = await tx.supportCase.findFirst({
    where: {
      AND: [
        supportCaseWhereForAccess(access),
        { OR: [{ key: idOrKey }, { id: uuidOrImpossible(idOrKey) }] }
      ]
    },
    include: supportCaseInclude
  });
  if (!current) throw new HttpError(404, 'Support Case not found');
  return current;
}

function assertCaseVersion(
  supportCase: Pick<SupportCase, 'version'>,
  baseVersion: number,
  access: SupportAccess
) {
  if (supportCase.version === baseVersion) return;
  throw new HttpError(409, 'Support Case version conflict', {
    code: 'SUPPORT_CASE_VERSION_CONFLICT',
    currentVersion: supportCase.version,
    accessEpoch: access.epoch.toString()
  });
}

function assertAggregateVersion(name: string, currentVersion: number, baseVersion: number) {
  if (currentVersion === baseVersion) return;
  throw new HttpError(409, `${name} version conflict`, {
    code: 'SUPPORT_AGGREGATE_VERSION_CONFLICT',
    currentVersion
  });
}

function cleanClusterText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function uuidOrImpossible(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : '00000000-0000-0000-0000-000000000000';
}
