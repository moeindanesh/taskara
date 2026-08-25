import {
  Prisma,
  prisma,
  type ActorType,
  type AgentRuntime,
  type SupportCaseStatus,
  type SupportCaseEventSource
} from '@taskara/db';
import {
  type SupportAttentionReasonValue,
  type SupportQueueKindValue,
  type createSupportCaseSchema,
  type routeSupportCaseSchema,
  type waitOnSupportCaseSchema,
  type resolveSupportCaseSchema,
  type closeSupportCaseSchema,
  type reopenSupportCaseSchema,
  type addSupportInteractionSchema,
  type createSupportCallSchema
} from '@taskara/shared';
import type { z } from 'zod';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import {
  assertCanCreateSupportCase,
  assertCanDispatch,
  assertCanWorkCase,
  bumpSupportAccessEpochs,
  canReadSupportCase,
  resolveSupportAccess,
  supportCaseWhereForAccess,
  type SupportAccess
} from './support-access';
import { assertSupportWorkspace } from './workspace-mode';
import {
  constantTimeTextEqual,
  decryptSupportBytes,
  encryptSupportBytes,
  hashSupportPayload
} from './support-crypto';
import { appendSupportCaseSyncEvent } from './support-sync';
import type { SyncMutationMeta } from './sync';
import {
  supportAttentionCaseWhere,
  supportAttentionReasonsByCaseIds
} from './support-recovery-evaluator';
import {
  applySupportSlaCaseEvent,
  type SupportClockEvent,
  type SupportInteractionQualification
} from './support-sla';
import { applySupportCaseSignalToTaskLinks } from './support-task-link-signals';

export type CreateSupportCaseInput = z.infer<typeof createSupportCaseSchema>;
export type RouteSupportCaseInput = z.infer<typeof routeSupportCaseSchema>;
export type WaitOnSupportCaseInput = z.infer<typeof waitOnSupportCaseSchema>;
export type ResolveSupportCaseInput = z.infer<typeof resolveSupportCaseSchema>;
export type CloseSupportCaseInput = z.infer<typeof closeSupportCaseSchema>;
export type ReopenSupportCaseInput = z.infer<typeof reopenSupportCaseSchema>;
export type AddSupportInteractionInput = z.infer<typeof addSupportInteractionSchema>;
export type CreateSupportCallInput = z.infer<typeof createSupportCallSchema>;

const supportUserSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

export const supportCaseInclude = {
  department: {
    select: { id: true, name: true, slug: true, active: true }
  },
  assigneeMembership: {
    select: {
      id: true,
      userId: true,
      role: true,
      active: true,
      workspaceMember: {
        select: { user: { select: supportUserSelect } }
      }
    }
  },
  contact: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      redactedAt: true
    }
  },
  duplicateOf: {
    select: {
      id: true,
      workspaceId: true,
      key: true,
      title: true,
      status: true,
      departmentId: true,
      assigneeMembershipId: true
    }
  }
} satisfies Prisma.SupportCaseInclude;

export type SupportCaseView = Prisma.SupportCaseGetPayload<{ include: typeof supportCaseInclude }>;

const NON_TERMINAL_STATUSES: SupportCaseStatus[] = [
  'NEW',
  'OPEN',
  'WAITING_ON_CUSTOMER',
  'WAITING_ON_INTERNAL'
];
const BASIC_ATTENTION_REASONS: SupportAttentionReasonValue[] = [
  'NO_NEXT_ACTION',
  'NEXT_ACTION_DUE',
  'STALE_OWNERSHIP',
  'DEPARTMENT_UNASSIGNED_TOO_LONG',
  'WAITING_ON_CUSTOMER_TOO_LONG',
  'WAITING_ON_INTERNAL_TOO_LONG',
  'CALLBACK_DUE',
  'REOPENED',
  'RESOLUTION_UNCONFIRMED',
  'NON_FIXED_RESOLUTION'
];

export function serializeSupportCase(
  supportCase: SupportCaseView,
  accessOrEpoch: SupportAccess | bigint,
  now = new Date(),
  projectedAttentionReasons: readonly SupportAttentionReasonValue[] = []
) {
  const accessEpoch = typeof accessOrEpoch === 'bigint' ? accessOrEpoch : accessOrEpoch.epoch;
  const readableDuplicate = supportCase.duplicateOf
    && typeof accessOrEpoch !== 'bigint'
    && canReadSupportCase(accessOrEpoch, supportCase.duplicateOf)
      ? supportCase.duplicateOf
      : null;
  const attentionReasons = supportCase.snoozedUntil && supportCase.snoozedUntil > now
    ? []
    : [...new Set([
        ...projectedAttentionReasons,
        ...supportAttentionReasonsForCase(supportCase, now)
      ])];
  return {
    id: supportCase.id,
    workspaceId: supportCase.workspaceId,
    key: supportCase.key,
    sequence: supportCase.sequence,
    title: supportCase.title,
    description: supportCase.description,
    sourceChannel: supportCase.sourceChannel,
    typeKey: supportCase.typeKey,
    priority: supportCase.priority,
    impact: supportCase.impact,
    urgency: supportCase.urgency,
    status: supportCase.status,
    waitingReason: supportCase.waitingReason,
    departmentId: supportCase.departmentId,
    assigneeMembershipId: supportCase.assigneeMembershipId,
    contactId: supportCase.contactId,
    // A duplicate relation is never a capability. Its canonical id/key/title stay hidden unless
    // the reader independently passes the same assignment-scoped Case predicate right now.
    duplicateOfCaseId: readableDuplicate?.id ?? null,
    duplicateOfRedacted: Boolean(supportCase.duplicateOfCaseId && !readableDuplicate),
    receivedAt: supportCase.receivedAt.toISOString(),
    firstResponseAt: supportCase.firstResponseAt?.toISOString() ?? null,
    lastCustomerActivityAt: supportCase.lastCustomerActivityAt?.toISOString() ?? null,
    lastHumanResponseAt: supportCase.lastHumanResponseAt?.toISOString() ?? null,
    lastMeaningfulActivityAt: supportCase.lastMeaningfulActivityAt.toISOString(),
    nextActionAt: supportCase.nextActionAt?.toISOString() ?? null,
    snoozedUntil: supportCase.snoozedUntil?.toISOString() ?? null,
    resolutionCode: supportCase.resolutionCode,
    resolutionSummary: supportCase.resolutionSummary,
    resolvedAt: supportCase.resolvedAt?.toISOString() ?? null,
    closedAt: supportCase.closedAt?.toISOString() ?? null,
    reopenedAt: supportCase.reopenedAt?.toISOString() ?? null,
    reopenCount: supportCase.reopenCount,
    nextSlaDueAt: supportCase.nextSlaDueAt?.toISOString() ?? null,
    version: supportCase.version,
    createdAt: supportCase.createdAt.toISOString(),
    updatedAt: supportCase.updatedAt.toISOString(),
    department: supportCase.department,
    assignee: supportCase.assigneeMembership
      ? {
          id: supportCase.assigneeMembership.id,
          userId: supportCase.assigneeMembership.userId,
          role: supportCase.assigneeMembership.role,
          active: supportCase.assigneeMembership.active,
          user: supportCase.assigneeMembership.workspaceMember.user
        }
      : null,
    contact: supportCase.contact
      ? {
          ...supportCase.contact,
          redactedAt: supportCase.contact.redactedAt?.toISOString() ?? null
        }
      : null,
    duplicateOf: readableDuplicate
      ? {
          id: readableDuplicate.id,
          key: readableDuplicate.key,
          title: readableDuplicate.title,
          status: readableDuplicate.status
        }
      : null,
    attentionReasons,
    accessEpoch: accessEpoch.toString()
  };
}

export function supportAttentionReasonsForCase(
  supportCase: Pick<
    SupportCaseView,
    | 'status'
    | 'nextActionAt'
    | 'snoozedUntil'
    | 'lastMeaningfulActivityAt'
    | 'receivedAt'
    | 'departmentId'
    | 'assigneeMembershipId'
    | 'reopenedAt'
    | 'resolutionCode'
  >,
  now = new Date()
): SupportAttentionReasonValue[] {
  if (supportCase.snoozedUntil && supportCase.snoozedUntil > now) return [];
  const reasons: SupportAttentionReasonValue[] = [];
  const nonTerminal = NON_TERMINAL_STATUSES.includes(supportCase.status);
  const ageMs = now.getTime() - supportCase.lastMeaningfulActivityAt.getTime();
  if (nonTerminal && !supportCase.nextActionAt) reasons.push('NO_NEXT_ACTION');
  if (nonTerminal && supportCase.nextActionAt && supportCase.nextActionAt <= now) reasons.push('NEXT_ACTION_DUE');
  if (nonTerminal && supportCase.assigneeMembershipId && ageMs >= hours(72)) reasons.push('STALE_OWNERSHIP');
  if (
    nonTerminal
    && supportCase.departmentId
    && !supportCase.assigneeMembershipId
    && now.getTime() - supportCase.receivedAt.getTime() >= hours(24)
  ) reasons.push('DEPARTMENT_UNASSIGNED_TOO_LONG');
  if (supportCase.status === 'WAITING_ON_CUSTOMER' && ageMs >= hours(72)) {
    reasons.push('WAITING_ON_CUSTOMER_TOO_LONG');
  }
  if (supportCase.status === 'WAITING_ON_INTERNAL' && ageMs >= hours(24)) {
    reasons.push('WAITING_ON_INTERNAL_TOO_LONG');
  }
  if (nonTerminal && supportCase.reopenedAt) reasons.push('REOPENED');
  if (supportCase.status === 'RESOLVED') reasons.push('RESOLUTION_UNCONFIRMED');
  if (
    (supportCase.status === 'RESOLVED' || supportCase.status === 'CLOSED')
    && supportCase.resolutionCode
    && supportCase.resolutionCode !== 'FIXED'
  ) reasons.push('NON_FIXED_RESOLUTION');
  return reasons;
}

export function supportAttentionWhere(
  reason: SupportAttentionReasonValue,
  now = new Date()
): Prisma.SupportCaseWhereInput {
  const nonTerminal = { in: NON_TERMINAL_STATUSES };
  switch (reason) {
    case 'NO_NEXT_ACTION':
      return { status: nonTerminal, nextActionAt: null };
    case 'NEXT_ACTION_DUE':
      return { status: nonTerminal, nextActionAt: { lte: now } };
    case 'STALE_OWNERSHIP':
      return {
        status: nonTerminal,
        assigneeMembershipId: { not: null },
        lastMeaningfulActivityAt: { lte: new Date(now.getTime() - hours(72)) }
      };
    case 'DEPARTMENT_UNASSIGNED_TOO_LONG':
      return {
        status: nonTerminal,
        departmentId: { not: null },
        assigneeMembershipId: null,
        receivedAt: { lte: new Date(now.getTime() - hours(24)) }
      };
    case 'WAITING_ON_CUSTOMER_TOO_LONG':
      return {
        status: 'WAITING_ON_CUSTOMER',
        lastMeaningfulActivityAt: { lte: new Date(now.getTime() - hours(72)) }
      };
    case 'WAITING_ON_INTERNAL_TOO_LONG':
      return {
        status: 'WAITING_ON_INTERNAL',
        lastMeaningfulActivityAt: { lte: new Date(now.getTime() - hours(24)) }
      };
    case 'CALLBACK_DUE':
      return {
        interactions: {
          some: { call: { is: { callbackDueAt: { lte: now } } } }
        }
      };
    case 'REOPENED':
      return { status: nonTerminal, reopenedAt: { not: null } };
    case 'RESOLUTION_UNCONFIRMED':
      return { status: 'RESOLVED' };
    case 'NON_FIXED_RESOLUTION':
      return {
        status: { in: ['RESOLVED', 'CLOSED'] },
        resolutionCode: { not: null, notIn: ['FIXED'] }
      };
    case 'SLA_AT_RISK':
      return {
        status: nonTerminal,
        nextSlaDueAt: { gt: now, lte: new Date(now.getTime() + hours(2)) }
      };
    case 'SLA_BREACHED':
      return { status: nonTerminal, nextSlaDueAt: { lte: now } };
    default:
      // Reasons backed by routing/link projections land in later phases. Empty `in` is an explicit
      // false predicate and, unlike a fake UUID sentinel, is safe for Postgres uuid columns.
      return { id: { in: [] } };
  }
}

export function supportNeedsAttentionWhere(now = new Date()): Prisma.SupportCaseWhereInput {
  return {
    AND: [
      supportCaseAttentionSnoozeWhere(now),
      { OR: BASIC_ATTENTION_REASONS.map((reason) => supportAttentionWhere(reason, now)) }
    ]
  };
}

function supportCaseAttentionSnoozeWhere(now: Date): Prisma.SupportCaseWhereInput {
  return {
    OR: [
      { snoozedUntil: null },
      { snoozedUntil: { lte: now } }
    ]
  };
}

export function supportQueueWhere(
  queue: SupportQueueKindValue,
  access: SupportAccess,
  now = new Date(),
  projectedAttentionWhere?: Prisma.SupportCaseWhereInput
): Prisma.SupportCaseWhereInput {
  switch (queue) {
    case 'TRIAGE':
      return { departmentId: null, status: { notIn: ['RESOLVED', 'CLOSED'] } };
    case 'DEPARTMENT_INBOX':
      return {
        departmentId: { not: null },
        assigneeMembershipId: null,
        status: { notIn: ['RESOLVED', 'CLOSED'] }
      };
    case 'MY_CASES':
      return {
        assigneeMembershipId: { in: access.memberMembershipIds },
        status: { not: 'CLOSED' }
      };
    case 'NEEDS_ATTENTION':
      return projectedAttentionWhere
        ? {
            AND: [
              supportCaseAttentionSnoozeWhere(now),
              { OR: [supportNeedsAttentionWhere(now), projectedAttentionWhere] }
            ]
          }
        : supportNeedsAttentionWhere(now);
  }
}

/** Queue counts expose only queues the actor is entitled to navigate. */
export async function supportQueueCounts(access: SupportAccess, now = new Date()) {
  const base = supportCaseWhereForAccess(access);
  const projectedAttentionWhere = await supportAttentionCaseWhere(access.workspaceId, now);
  const count = (queue: SupportQueueKindValue) => prisma.supportCase.count({
    where: { AND: [base, supportQueueWhere(queue, access, now, projectedAttentionWhere)] }
  });
  const entries = await Promise.all([
    access.triager || access.workspaceWide
      ? count('TRIAGE').then((value) => ['TRIAGE', value] as const)
      : null,
    access.workspaceWide || access.managedDepartmentIds.length
      ? count('DEPARTMENT_INBOX').then((value) => ['DEPARTMENT_INBOX', value] as const)
      : null,
    access.memberMembershipIds.length
      ? count('MY_CASES').then((value) => ['MY_CASES', value] as const)
      : null,
    access.workspaceWide
      || access.triager
      || access.managedDepartmentIds.length
      || access.memberMembershipIds.length
      ? count('NEEDS_ATTENTION').then((value) => ['NEEDS_ATTENTION', value] as const)
      : null
  ]);
  const result: Partial<Record<SupportQueueKindValue, number>> = {};
  for (const entry of entries) {
    if (entry) result[entry[0]] = entry[1];
  }
  return result;
}

export { supportAttentionCaseWhere, supportAttentionReasonsByCaseIds };

export async function createSupportCase(actor: RequestActor, input: CreateSupportCaseInput) {
  assertSupportWorkspace(actor.workspace);
  const now = new Date();
  const requestHash = supportCaseCreateRequestHash(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const access = await resolveSupportAccess(actor, tx);
      assertCanCreateSupportCase(access, input.departmentId);

    if (input.idempotencyKey) {
      await lockSupportCaseCreationIdempotency(
        tx,
        actor.workspace.id,
        input.idempotencyKey
      );
      const replay = await tx.supportCaseEvent.findFirst({
        where: {
          workspaceId: actor.workspace.id,
          idempotencyKey: input.idempotencyKey,
          action: 'case.created'
        },
        select: { caseId: true, correlationId: true }
      });
      if (replay) {
        assertMatchingIdempotencyHash(replay.correlationId, requestHash);
        const existing = await tx.supportCase.findUnique({
          where: { id: replay.caseId },
          include: supportCaseInclude
        });
        if (existing && canReadSupportCase(access, existing)) {
          return { supportCase: existing, access, replayed: true };
        }
        throw new HttpError(409, 'Idempotency key was already used');
      }
    }

    if (input.departmentId) {
      const department = await tx.department.findFirst({
        where: { id: input.departmentId, workspaceId: actor.workspace.id, active: true },
        select: { id: true }
      });
      if (!department) throw new HttpError(400, 'Destination Department is not active in this workspace');
    }

    const contactId = await resolveSupportContactId(tx, actor.workspace.id, input);
    const { key, sequence } = await reserveSupportCaseKey(tx, actor.workspace);
    const created = await tx.supportCase.create({
      data: {
        workspaceId: actor.workspace.id,
        key,
        sequence,
        title: input.title,
        description: input.description,
        sourceChannel: input.sourceChannel,
        typeKey: input.typeKey,
        priority: input.priority,
        impact: input.impact,
        urgency: input.urgency,
        status: input.departmentId ? 'OPEN' : 'NEW',
        departmentId: input.departmentId,
        contactId,
        receivedAt: now,
        lastMeaningfulActivityAt: now
      },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, created, {
      action: 'case.created',
      after: caseEventSnapshot(created),
      idempotencyKey: input.idempotencyKey,
      correlationId: requestHash,
      source: input.sourceChannel === 'CALL' ? 'CALL_CENTER' : undefined
    });
    await applySupportCaseSlaEvent(tx, created, {
      event: 'CASE_CREATED',
      at: now
    });
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: created.id,
      caseVersion: created.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
      return { supportCase: created, access, replayed: false };
    });
  } catch (error) {
    await auditManualIntakeIdempotencyMismatch(actor, 'CREATE_CASE', input.idempotencyKey, error);
    throw error;
  }
}

export async function findSupportCaseForAccess(actor: RequestActor, idOrKey: string) {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor);
  const supportCase = await prisma.supportCase.findFirst({
    where: {
      AND: [
        supportCaseWhereForAccess(access),
        caseIdentifierWhere(idOrKey)
      ]
    },
    include: supportCaseInclude
  });
  if (!supportCase) throw new HttpError(404, 'Support Case not found');
  return { supportCase, access };
}

export async function routeSupportCase(
  actor: RequestActor,
  idOrKey: string,
  input: RouteSupportCaseInput,
  mutation?: SyncMutationMeta
) {
  return prisma.$transaction(async (tx) => {
    await lockSupportOwnershipGraph(tx, actor.workspace.id);
    const { supportCase: current, access } = await lockSupportCaseForAccess(tx, actor, idOrKey);
    assertCurrentVersion(current, input.baseVersion, access);
    if (current.status === 'RESOLVED' || current.status === 'CLOSED') {
      throw new HttpError(409, 'Terminal Support Cases must be reopened before reassignment');
    }

    const targetAssigneeMembershipId = input.targetAssigneeMembershipId ?? null;
    assertCanDispatch(access, current, {
      departmentId: input.targetDepartmentId,
      assigneeMembershipId: targetAssigneeMembershipId
    });
    const crossDepartment = current.departmentId !== null && current.departmentId !== input.targetDepartmentId;
    if (crossDepartment && !input.reason) {
      throw new HttpError(400, 'Cross-Department transfer requires a reason');
    }

    const destination = await tx.department.findFirst({
      where: { id: input.targetDepartmentId, workspaceId: actor.workspace.id, active: true },
      select: { id: true }
    });
    if (!destination) throw new HttpError(400, 'Destination Department is not active in this workspace');

    if (targetAssigneeMembershipId) {
      const membership = await tx.departmentMember.findFirst({
        where: {
          id: targetAssigneeMembershipId,
          workspaceId: actor.workspace.id,
          departmentId: destination.id,
          active: true
        },
        select: { id: true }
      });
      if (!membership) {
        throw new HttpError(400, 'Assignee must be an active member of the destination Department');
      }
    }

    const before = caseEventSnapshot(current);
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: {
        departmentId: destination.id,
        assigneeMembershipId: targetAssigneeMembershipId,
        status: current.status === 'NEW' ? 'OPEN' : current.status,
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });

    const action = ownershipAction(current, updated);
    await appendSupportCaseEvent(tx, actor, updated, {
      action,
      before,
      after: caseEventSnapshot(updated),
      reason: input.reason
    });
    const losingUserIds = await ownershipAudienceLosingAccess(tx, current, updated);
    await bumpSupportAccessEpochs(tx, actor.workspace.id, losingUserIds);
    const slaEvent = supportSlaOwnershipEvent(current, updated);
    if (slaEvent) {
      await applySupportCaseSlaEvent(tx, updated, { event: slaEvent, at: new Date() });
    }
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'route',
      actorId: actor.user.id,
      removedUserIds: losingUserIds,
      mutation
    });
    return { supportCase: updated, access };
  });
}

export async function waitOnSupportCase(
  actor: RequestActor,
  idOrKey: string,
  input: WaitOnSupportCaseInput,
  mutation?: SyncMutationMeta
) {
  return mutateSupportCase(actor, idOrKey, input.baseVersion, async (tx, current, access) => {
    assertCanWorkCase(access, current);
    assertNonTerminal(current);
    const now = new Date();
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: {
        status: input.status,
        waitingReason: input.status === 'WAITING_ON_INTERNAL' ? input.waitingReason : null,
        nextActionAt: new Date(input.nextActionAt),
        lastMeaningfulActivityAt: now,
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: input.status === 'WAITING_ON_CUSTOMER'
        ? 'case.waiting_on_customer'
        : 'case.waiting_on_internal',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: input.status === 'WAITING_ON_INTERNAL' ? input.waitingReason : undefined
    });
    await applySupportCaseSlaEvent(tx, updated, { event: input.status, at: now });
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id,
      mutation
    });
    return updated;
  });
}

export async function resolveSupportCase(
  actor: RequestActor,
  idOrKey: string,
  input: ResolveSupportCaseInput,
  mutation?: SyncMutationMeta
) {
  return mutateSupportCase(actor, idOrKey, input.baseVersion, async (tx, current, access) => {
    assertCanWorkCase(access, current);
    assertNonTerminal(current);
    if (
      !access.workspaceWide
      && access.triager
      && current.departmentId === null
      && !['REJECTED', 'SPAM', 'DUPLICATE'].includes(input.resolutionCode)
    ) {
      throw new HttpError(403, 'Triagers may only reject, mark spam, or merge an unrouted Case');
    }

    if (input.duplicateOfCaseId === current.id) {
      throw new HttpError(400, 'A Support Case cannot be its own canonical duplicate');
    }
    if (input.duplicateOfCaseId) {
      const canonical = await tx.supportCase.findFirst({
        where: {
          ...supportCaseWhereForAccess(access),
          id: input.duplicateOfCaseId
        },
        select: { id: true }
      });
      if (!canonical) throw new HttpError(404, 'Canonical Support Case not found');
    }

    const now = new Date();
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: {
        status: 'RESOLVED',
        resolutionCode: input.resolutionCode,
        resolutionSummary: input.resolutionSummary,
        duplicateOfCaseId: input.duplicateOfCaseId ?? null,
        resolvedAt: now,
        closedAt: null,
        waitingReason: null,
        nextActionAt: null,
        lastMeaningfulActivityAt: now,
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.resolved',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: input.resolutionSummary
    });
    await applySupportCaseSlaEvent(tx, updated, { event: 'RESOLVED', at: now });
    await applySupportCaseSignalToTaskLinks(tx, actor, current, updated);
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id,
      mutation
    });
    return updated;
  });
}

export async function closeSupportCase(
  actor: RequestActor,
  idOrKey: string,
  input: CloseSupportCaseInput,
  mutation?: SyncMutationMeta
) {
  return mutateSupportCase(actor, idOrKey, input.baseVersion, async (tx, current, access) => {
    if (!canReadSupportCase(access, current)) throw new HttpError(404, 'Support Case not found');
    const canClose = access.workspaceWide
      || (!access.credentialActor
        && Boolean(current.departmentId && access.managedDepartmentIds.includes(current.departmentId)));
    if (!canClose || !access.canWriteCases) throw new HttpError(403, 'Support Case close access denied');
    if (current.status !== 'RESOLVED') throw new HttpError(409, 'Only a resolved Support Case can be closed');
    if (input.confirmation === 'ADMIN_OVERRIDE' && !access.workspaceWide) {
      throw new HttpError(403, 'Administrative close override requires supervisor access');
    }
    if (input.confirmation === 'ADMIN_OVERRIDE' && !input.reason) {
      throw new HttpError(400, 'Administrative close override requires a reason');
    }

    const now = new Date();
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: { status: 'CLOSED', closedAt: now, version: { increment: 1 } },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.closed',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: input.reason ?? input.confirmation
    });
    await applySupportCaseSlaEvent(tx, updated, { event: 'CLOSED', at: now });
    await applySupportCaseSignalToTaskLinks(tx, actor, current, updated);
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'remove',
      actorId: actor.user.id,
      mutation
    });
    return updated;
  });
}

export async function reopenSupportCase(
  actor: RequestActor,
  idOrKey: string,
  input: ReopenSupportCaseInput,
  mutation?: SyncMutationMeta
) {
  return mutateSupportCase(actor, idOrKey, input.baseVersion, async (tx, current, access) => {
    if (!canReadSupportCase(access, current)) throw new HttpError(404, 'Support Case not found');
    const canReopen = access.workspaceWide
      || (!access.credentialActor
        && Boolean(current.departmentId && access.managedDepartmentIds.includes(current.departmentId)));
    if (!canReopen || !access.canWriteCases) throw new HttpError(403, 'Support Case reopen access denied');
    if (current.status !== 'RESOLVED' && current.status !== 'CLOSED') {
      throw new HttpError(409, 'Only a resolved or closed Support Case can be reopened');
    }

    const now = new Date();
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: {
        status: current.departmentId ? 'OPEN' : 'NEW',
        resolutionCode: null,
        resolutionSummary: null,
        duplicateOfCaseId: null,
        resolvedAt: null,
        closedAt: null,
        reopenedAt: now,
        reopenCount: { increment: 1 },
        nextActionAt: null,
        waitingReason: null,
        lastMeaningfulActivityAt: now,
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.reopened',
      before: caseEventSnapshot(current),
      after: caseEventSnapshot(updated),
      reason: input.reason
    });
    await applySupportCaseSlaEvent(tx, updated, { event: 'REOPENED', at: now });
    await applySupportCaseSignalToTaskLinks(tx, actor, current, updated);
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id,
      mutation
    });
    return updated;
  });
}

export async function addSupportInteraction(
  actor: RequestActor,
  idOrKey: string,
  input: AddSupportInteractionInput,
  mutation?: SyncMutationMeta
) {
  // Encryption happens before opening a transaction, so a missing key fails without taking a Case
  // lock. The body itself never appears in an event or an interaction envelope.
  const encryptedContent = input.content ? encryptInteractionContent(input.content) : null;
  return prisma.$transaction(async (tx) => {
    const { supportCase: current, access } = await lockSupportCaseForAccess(tx, actor, idOrKey);
    assertCurrentVersion(current, input.baseVersion, access);
    assertCanWorkCase(access, current);
    const isCustomerActivity = input.direction === 'INBOUND' && input.visibility === 'PUBLIC';
    if (current.status === 'CLOSED' || (current.status === 'RESOLVED' && !isCustomerActivity)) {
      throw new HttpError(409, 'Terminal Support Cases must be reopened before this operation');
    }

    if (input.contactId) {
      await assertSupportContactAvailableToCase(
        tx,
        access,
        current.id,
        input.contactId
      );
    }

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const interaction = await tx.supportInteraction.create({
      data: {
        workspaceId: actor.workspace.id,
        caseId: current.id,
        kind: input.kind,
        visibility: input.visibility,
        channel: input.channel,
        direction: input.direction,
        authorId: isCustomerActivity ? null : actor.user.id,
        contactId: input.contactId ?? (isCustomerActivity ? current.contactId : undefined),
        externalId: input.externalId,
        occurredAt,
        contentHash: encryptedContent?.bodyHash,
        content: encryptedContent
          ? {
              create: {
                bodyCiphertext: encryptedContent.bodyCiphertext,
                bodyHash: encryptedContent.bodyHash,
                format: encryptedContent.format,
                encryptionKeyId: encryptedContent.encryptionKeyId
              }
            }
          : undefined
      }
    });

    const isHumanPublicResponse = input.direction === 'OUTBOUND'
      && input.visibility === 'PUBLIC'
      && actor.user.kind === 'HUMAN'
      && !access.credentialActor;
    // `occurredAt` is caller-reported timeline data. Operational clocks use the server-trusted
    // receipt instant so a backdated or future payload cannot poison SLA and stale-case math.
    const activityAt = interaction.receivedAt;
    const reopensResolved = isCustomerActivity && current.status === 'RESOLVED';
    const resumesCustomerWait = isCustomerActivity && current.status === 'WAITING_ON_CUSTOMER';
    const nextStatus = reopensResolved || resumesCustomerWait
      ? current.departmentId ? 'OPEN' : 'NEW'
      : current.status;
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: {
        status: nextStatus,
        ...(reopensResolved
          ? {
              resolutionCode: null,
              resolutionSummary: null,
              duplicateOfCaseId: null,
              resolvedAt: null,
              closedAt: null,
              reopenedAt: activityAt,
              reopenCount: { increment: 1 }
            }
          : {}),
        ...(reopensResolved || resumesCustomerWait
          ? { waitingReason: null, nextActionAt: null }
          : {}),
        ...(isCustomerActivity
          ? { lastCustomerActivityAt: latestDate(current.lastCustomerActivityAt, activityAt) }
          : {}),
        ...(isHumanPublicResponse
          ? {
              firstResponseAt: current.firstResponseAt
                ? earliestDate(current.firstResponseAt, activityAt)
                : activityAt,
              lastHumanResponseAt: latestDate(current.lastHumanResponseAt, activityAt)
            }
          : {}),
        lastMeaningfulActivityAt: latestDate(current.lastMeaningfulActivityAt, activityAt),
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: reopensResolved
        ? 'case.reopened_by_customer'
        : resumesCustomerWait
          ? 'case.customer_replied'
          : 'case.interaction_recorded',
      before: caseEventSnapshot(current),
      after: {
        ...caseEventSnapshot(updated),
        interactionId: interaction.id,
        kind: interaction.kind,
        visibility: interaction.visibility,
        direction: interaction.direction,
        channel: interaction.channel
      }
    });
    const slaEvent = supportInteractionSlaEvent(input, reopensResolved, isHumanPublicResponse);
    await applySupportCaseSlaEvent(tx, updated, {
      event: slaEvent,
      at: interaction.receivedAt,
      interaction: slaEvent === 'HUMAN_PUBLIC_RESPONSE' || slaEvent === 'AUTOMATED_PUBLIC_RESPONSE'
        ? {
            visibility: input.visibility,
            direction: input.direction,
            humanAuthored: isHumanPublicResponse,
            automated: !isHumanPublicResponse
          }
        : undefined
    });
    await applySupportCaseSignalToTaskLinks(tx, actor, current, updated);
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id,
      mutation
    });
    return { interaction, supportCase: updated, access };
  });
}

export async function listSupportCaseInteractions(actor: RequestActor, idOrKey: string) {
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  const interactions = await prisma.supportInteraction.findMany({
    where: { workspaceId: actor.workspace.id, caseId: supportCase.id },
    orderBy: [{ occurredAt: 'asc' }, { kind: 'asc' }, { id: 'asc' }],
    include: {
      author: { select: supportUserSelect },
      contact: { select: { id: true, name: true, email: true, phone: true, redactedAt: true } },
      content: {
        select: {
          format: true,
          bodyHash: true,
          bodyCiphertext: true,
          redactedAt: true,
          retentionUntil: true,
          encryptionKeyId: true
        }
      },
      call: true
    }
  });
  return {
    items: interactions.map((interaction) => ({
      ...interaction,
      occurredAt: interaction.occurredAt.toISOString(),
      receivedAt: interaction.receivedAt.toISOString(),
      createdAt: interaction.createdAt.toISOString(),
      contact: interaction.contact
        ? { ...interaction.contact, redactedAt: interaction.contact.redactedAt?.toISOString() ?? null }
        : null,
      content: interaction.content
        ? {
            format: interaction.content.format,
            bodyHash: interaction.content.bodyHash,
            body: interaction.content.bodyCiphertext && !interaction.content.redactedAt
              ? decryptSupportBytes(interaction.content.bodyCiphertext).toString('utf8')
              : null,
            redactedAt: interaction.content.redactedAt?.toISOString() ?? null,
            retentionUntil: interaction.content.retentionUntil?.toISOString() ?? null,
            encrypted: Boolean(interaction.content.encryptionKeyId)
          }
        : null,
      call: interaction.call
        ? {
            ...interaction.call,
            startedAt: interaction.call.startedAt.toISOString(),
            answeredAt: interaction.call.answeredAt?.toISOString() ?? null,
            endedAt: interaction.call.endedAt?.toISOString() ?? null,
            callbackDueAt: interaction.call.callbackDueAt?.toISOString() ?? null,
            createdAt: interaction.call.createdAt.toISOString(),
            updatedAt: interaction.call.updatedAt.toISOString()
          }
        : null
    })),
    total: interactions.length,
    caseId: supportCase.id,
    caseKey: supportCase.key,
    accessEpoch: access.epoch.toString()
  };
}

export async function createSupportCall(actor: RequestActor, input: CreateSupportCallInput) {
  assertSupportWorkspace(actor.workspace);
  const requestHash = supportCallRequestHash(input);
  const summary = encryptInteractionContent({ body: input.summary, format: 'text/plain' });
  const internalNotes = input.internalNotes
    ? encryptInteractionContent({ body: input.internalNotes, format: 'text/plain' })
    : null;
  assertValidCallTimes(input.call);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockSupportOwnershipGraph(tx, actor.workspace.id);

    // The provider's call id is the replay identity for both existing- and new-Case intake. This
    // must run before a Case version check: retrying a committed request is a read of that result,
    // not a second mutation against the Case's now-incremented version.
    if (input.call.externalCallId) {
      const replay = await findSupportCallReplayByExternalId(
        tx,
        actor,
        input.call.externalCallId,
        requestHash
      );
      if (replay) return replay;
    }

    let access: SupportAccess;
    let current: SupportCaseView;
    let createdNewCase = false;

    if (input.caseId) {
      ({ supportCase: current, access } = await lockSupportCaseForAccess(tx, actor, input.caseId));
      if (input.baseVersion === undefined) {
        throw new HttpError(400, 'Existing Case calls require the current Case version');
      }
      assertCurrentVersion(current, input.baseVersion, access);
      assertCanWorkCase(access, current);
      if (
        current.status === 'CLOSED'
        || (current.status === 'RESOLVED' && input.call.direction === 'OUTBOUND')
      ) {
        throw new HttpError(409, 'Terminal Support Cases must be reopened before this operation');
      }
    } else {
      const newCase = input.newCase;
      if (!newCase) throw new HttpError(400, 'A new Support Case is required');
      if (!newCase.idempotencyKey) {
        throw new HttpError(400, 'New Case calls require an idempotency key');
      }
      if (newCase.sourceChannel !== 'CALL') {
        throw new HttpError(400, 'A Case created from manual call intake must use the CALL source channel');
      }
      if ((input.contactId || input.contact) && (newCase.contactId || newCase.contact)) {
        throw new HttpError(400, 'Provide the call contact once, not on both call and new Case');
      }

      // Share the exact namespace used by createSupportCase(). A key can create one Case by one
      // command only; the advisory lock also ensures a replay is observed before another public
      // Case number or interaction can be reserved.
      await lockSupportCaseCreationIdempotency(
        tx,
        actor.workspace.id,
        newCase.idempotencyKey
      );
      const idempotentReplay = await findNewCaseCallReplay(
        tx,
        actor,
        newCase.idempotencyKey,
        requestHash
      );
      if (idempotentReplay) return idempotentReplay;

      access = await resolveSupportAccess(actor, tx);
      assertCanCreateSupportCase(access, newCase.departmentId);
      if (newCase.departmentId) {
        const department = await tx.department.findFirst({
          where: { id: newCase.departmentId, workspaceId: actor.workspace.id, active: true },
          select: { id: true }
        });
        if (!department) throw new HttpError(400, 'Destination Department is not active in this workspace');
      }
      const contactId = await resolveSupportContactId(tx, actor.workspace.id, {
        contactId: input.contactId ?? newCase.contactId,
        contact: input.contact ?? newCase.contact
      });
      const { key, sequence } = await reserveSupportCaseKey(tx, actor.workspace);
      const receivedAt = new Date();
      current = await tx.supportCase.create({
        data: {
          workspaceId: actor.workspace.id,
          key,
          sequence,
          title: newCase.title,
          description: newCase.description,
          sourceChannel: 'CALL',
          typeKey: newCase.typeKey,
          priority: newCase.priority,
          impact: newCase.impact,
          urgency: newCase.urgency,
          status: newCase.departmentId ? 'OPEN' : 'NEW',
          departmentId: newCase.departmentId,
          contactId,
          receivedAt,
          lastMeaningfulActivityAt: receivedAt
        },
        include: supportCaseInclude
      });
      await appendSupportCaseEvent(tx, actor, current, {
        action: 'case.created',
        after: caseEventSnapshot(current),
        idempotencyKey: newCase.idempotencyKey,
        correlationId: requestHash,
        source: 'CALL_CENTER'
      });
      await applySupportCaseSlaEvent(tx, current, { event: 'CASE_CREATED', at: receivedAt });
      createdNewCase = true;
    }

    const contactId = await resolveCallContactId(tx, actor.workspace.id, current, access, input);
    if (input.call.callbackOwnerId) {
      const callbackOwner = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: actor.workspace.id,
            userId: input.call.callbackOwnerId
          }
        },
        include: { user: true }
      });
      if (!callbackOwner) throw new HttpError(400, 'Callback owner must belong to this workspace');
      const callbackAccess = await resolveSupportAccess({
        workspace: actor.workspace,
        user: callbackOwner.user,
        role: callbackOwner.role,
        actorType: 'USER',
        actorRuntime: null,
        source: 'SYSTEM'
      }, tx);
      if (!canReadSupportCase(callbackAccess, current)) {
        throw new HttpError(400, 'Callback owner must currently have access to this Support Case');
      }
    }

    const occurredAt = new Date(input.call.startedAt);
    const interaction = await tx.supportInteraction.create({
      data: {
        workspaceId: actor.workspace.id,
        caseId: current.id,
        kind: 'CALL',
        visibility: 'INTERNAL',
        channel: 'CALL',
        direction: input.call.direction,
        authorId: actor.user.id,
        contactId,
        occurredAt,
        contentHash: summary.bodyHash,
        content: {
          create: {
            bodyCiphertext: summary.bodyCiphertext,
            bodyHash: summary.bodyHash,
            format: summary.format,
            encryptionKeyId: summary.encryptionKeyId
          }
        },
        call: {
          create: {
            direction: input.call.direction,
            disposition: input.call.disposition,
            startedAt: occurredAt,
            answeredAt: input.call.answeredAt ? new Date(input.call.answeredAt) : null,
            endedAt: input.call.endedAt ? new Date(input.call.endedAt) : null,
            durationSeconds: input.call.durationSeconds,
            recordingConsent: input.call.recordingConsent,
            recordingExists: input.call.recordingExists,
            callbackOwnerId: input.call.callbackOwnerId,
            callbackDueAt: input.call.callbackDueAt ? new Date(input.call.callbackDueAt) : null,
            externalCallId: input.call.externalCallId
          }
        }
      },
      include: { call: true }
    });

    let internalNoteId: string | null = null;
    if (internalNotes) {
      const note = await tx.supportInteraction.create({
        data: {
          workspaceId: actor.workspace.id,
          caseId: current.id,
          kind: 'NOTE',
          visibility: 'INTERNAL',
          channel: 'CALL',
          direction: 'INTERNAL',
          authorId: actor.user.id,
          contactId,
          occurredAt,
          contentHash: internalNotes.bodyHash,
          content: {
            create: {
              bodyCiphertext: internalNotes.bodyCiphertext,
              bodyHash: internalNotes.bodyHash,
              format: internalNotes.format,
              encryptionKeyId: internalNotes.encryptionKeyId
            }
          }
        },
        select: { id: true }
      });
      internalNoteId = note.id;
    }

    const activityAt = interaction.receivedAt;
    const isCustomerActivity = input.call.direction === 'INBOUND';
    const isHumanResponse = input.call.direction === 'OUTBOUND'
      && actor.user.kind === 'HUMAN'
      && !access.credentialActor;
    const reopensResolved = isCustomerActivity && current.status === 'RESOLVED';
    const resumesCustomerWait = isCustomerActivity && current.status === 'WAITING_ON_CUSTOMER';
    const updated = await tx.supportCase.update({
      where: { id: current.id },
      data: {
        status: reopensResolved || resumesCustomerWait
          ? current.departmentId ? 'OPEN' : 'NEW'
          : current.status,
        ...(reopensResolved
          ? {
              resolutionCode: null,
              resolutionSummary: null,
              duplicateOfCaseId: null,
              resolvedAt: null,
              closedAt: null,
              reopenedAt: activityAt,
              reopenCount: { increment: 1 }
            }
          : {}),
        ...(reopensResolved || resumesCustomerWait ? { waitingReason: null } : {}),
        ...(isCustomerActivity
          ? { lastCustomerActivityAt: latestDate(current.lastCustomerActivityAt, activityAt) }
          : {}),
        ...(isHumanResponse
          ? {
              firstResponseAt: current.firstResponseAt
                ? earliestDate(current.firstResponseAt, activityAt)
                : activityAt,
              lastHumanResponseAt: latestDate(current.lastHumanResponseAt, activityAt)
            }
          : {}),
        lastMeaningfulActivityAt: latestDate(current.lastMeaningfulActivityAt, activityAt),
        nextActionAt: input.call.callbackDueAt
          ? new Date(input.call.callbackDueAt)
          : reopensResolved || resumesCustomerWait
            ? null
            : current.nextActionAt,
        version: { increment: 1 }
      },
      include: supportCaseInclude
    });
    await appendSupportCaseEvent(tx, actor, updated, {
      action: 'case.call_recorded',
      before: caseEventSnapshot(current),
      after: {
        ...caseEventSnapshot(updated),
        interactionId: interaction.id,
        internalNoteId,
        direction: input.call.direction,
        disposition: input.call.disposition,
        callbackDueAt: input.call.callbackDueAt ?? null,
        recordingExists: input.call.recordingExists
      },
      idempotencyKey: createdNewCase ? input.newCase?.idempotencyKey : undefined,
      correlationId: requestHash,
      source: 'CALL_CENTER'
    });
    const slaEvent = reopensResolved
      ? 'REOPENED'
      : isCustomerActivity
        ? 'CUSTOMER_ACTIVITY'
        : isHumanResponse
          ? 'HUMAN_PUBLIC_RESPONSE'
          : 'AUTOMATED_PUBLIC_RESPONSE';
    await applySupportCaseSlaEvent(tx, updated, {
      event: slaEvent,
      at: interaction.receivedAt,
      interaction: slaEvent === 'HUMAN_PUBLIC_RESPONSE' || slaEvent === 'AUTOMATED_PUBLIC_RESPONSE'
        ? {
            visibility: 'PUBLIC',
            direction: input.call.direction,
            humanAuthored: isHumanResponse,
            automated: !isHumanResponse
          }
        : undefined
    });
    await applySupportCaseSignalToTaskLinks(tx, actor, current, updated);
    await appendSupportCaseSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      caseId: updated.id,
      caseVersion: updated.version,
      operation: 'upsert',
      actorId: actor.user.id
    });
      return {
        supportCase: updated,
        interaction,
        call: interaction.call,
        internalNoteId,
        access,
        createdNewCase,
        replayed: false
      };
    });
  } catch (error) {
    await auditManualIntakeIdempotencyMismatch(
      actor,
      'RECORD_CALL',
      input.call.externalCallId ?? input.newCase?.idempotencyKey,
      error
    );
    throw error;
  }
}

async function findSupportCallReplayByExternalId(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  externalCallId: string,
  requestHash: string
) {
  const detail = await tx.supportCallDetail.findUnique({
    where: {
      workspaceId_externalCallId: {
        workspaceId: actor.workspace.id,
        externalCallId
      }
    },
    select: { interactionId: true }
  });
  return detail ? replaySupportCall(tx, actor, detail.interactionId, requestHash) : null;
}

async function findNewCaseCallReplay(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  idempotencyKey: string,
  requestHash: string
) {
  const caseCreation = await tx.supportCaseEvent.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      idempotencyKey,
      action: 'case.created'
    },
    select: { caseId: true, correlationId: true }
  });
  if (!caseCreation) return null;
  assertMatchingIdempotencyHash(caseCreation.correlationId, requestHash);

  const callEvent = await tx.supportCaseEvent.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      caseId: caseCreation.caseId,
      idempotencyKey,
      action: 'case.call_recorded'
    },
    orderBy: { sequence: 'asc' },
    select: { after: true, correlationId: true }
  });
  const interactionId = jsonEventString(callEvent?.after, 'interactionId');
  if (!interactionId) {
    // The namespace is shared with ordinary Case creation. Reusing one of those keys for call
    // intake must conflict rather than adding a surprise interaction to the existing Case.
    throw new HttpError(409, 'Idempotency key was already used');
  }
  assertMatchingIdempotencyHash(callEvent?.correlationId ?? null, requestHash);
  return replaySupportCall(tx, actor, interactionId, requestHash);
}

async function replaySupportCall(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  interactionId: string,
  requestHash: string
) {
  const envelope = await tx.supportInteraction.findUnique({
    where: { id: interactionId },
    select: { workspaceId: true, caseId: true, kind: true }
  });
  if (
    !envelope
    || envelope.workspaceId !== actor.workspace.id
    || envelope.kind !== 'CALL'
  ) {
    throw new HttpError(409, 'Recorded call replay is unavailable');
  }

  // Re-evaluate assignment-scoped access against the Case's current ownership. A replay is never
  // a capability to read a Case that has since moved away from the caller.
  const { supportCase, access } = await lockSupportCaseForAccess(
    tx,
    actor,
    envelope.caseId
  );
  const interaction = await tx.supportInteraction.findUnique({
    where: { id: interactionId },
    include: { call: true }
  });
  if (!interaction?.call) throw new HttpError(409, 'Recorded call replay is unavailable');

  const events = await tx.supportCaseEvent.findMany({
    where: {
      workspaceId: actor.workspace.id,
      caseId: supportCase.id,
      action: 'case.call_recorded'
    },
    orderBy: { sequence: 'desc' },
    select: { after: true, idempotencyKey: true, correlationId: true }
  });
  const event = events.find((candidate) => (
    jsonEventString(candidate.after, 'interactionId') === interaction.id
  ));
  if (!event) throw new HttpError(409, 'Recorded call replay is unavailable');
  assertMatchingIdempotencyHash(event.correlationId, requestHash);
  return {
    supportCase,
    interaction,
    call: interaction.call,
    internalNoteId: jsonEventString(event?.after, 'internalNoteId'),
    access,
    createdNewCase: Boolean(event?.idempotencyKey),
    replayed: true
  };
}

function jsonEventString(value: Prisma.JsonValue | null | undefined, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Prisma.JsonObject)[key];
  return typeof candidate === 'string' ? candidate : null;
}

function supportCaseCreateRequestHash(input: CreateSupportCaseInput): string {
  return hashSupportPayload(Buffer.from(JSON.stringify(supportCaseCreateRequestFacts(input)), 'utf8'));
}

function supportCaseCreateRequestFacts(input: CreateSupportCaseInput) {
  return {
    title: input.title,
    description: input.description ?? null,
    sourceChannel: input.sourceChannel,
    typeKey: input.typeKey,
    priority: input.priority,
    impact: input.impact ?? null,
    urgency: input.urgency ?? null,
    departmentId: input.departmentId ?? null,
    contactId: input.contactId ?? null,
    contact: supportContactRequestFacts(input.contact)
  };
}

function supportCallRequestHash(input: CreateSupportCallInput): string {
  const facts = {
    operation: 'RECORD_CALL',
    caseId: input.caseId ?? null,
    newCase: input.newCase ? supportCaseCreateRequestFacts(input.newCase) : null,
    baseVersion: input.baseVersion ?? null,
    contactId: input.contactId ?? null,
    contact: supportContactRequestFacts(input.contact),
    summary: input.summary,
    internalNotes: input.internalNotes ?? null,
    call: {
      direction: input.call.direction,
      disposition: input.call.disposition,
      startedAt: input.call.startedAt,
      answeredAt: input.call.answeredAt ?? null,
      endedAt: input.call.endedAt ?? null,
      durationSeconds: input.call.durationSeconds ?? null,
      recordingConsent: input.call.recordingConsent,
      recordingExists: input.call.recordingExists,
      callbackOwnerId: input.call.callbackOwnerId ?? null,
      callbackDueAt: input.call.callbackDueAt ?? null,
      externalCallId: input.call.externalCallId ?? null
    }
  };
  return hashSupportPayload(Buffer.from(JSON.stringify(facts), 'utf8'));
}

function supportContactRequestFacts(
  contact: CreateSupportCaseInput['contact'] | CreateSupportCallInput['contact']
) {
  if (!contact) return null;
  return {
    name: contact.name ?? null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
    externalCustomerId: contact.externalCustomerId ?? null
  };
}

function assertMatchingIdempotencyHash(storedHash: string | null, requestHash: string): void {
  if (storedHash && constantTimeTextEqual(storedHash, requestHash)) return;
  throw new HttpError(409, 'Idempotency key was already used with a different payload', {
    code: 'SUPPORT_IDEMPOTENCY_PAYLOAD_MISMATCH'
  });
}

async function auditManualIntakeIdempotencyMismatch(
  actor: RequestActor,
  operation: 'CREATE_CASE' | 'RECORD_CALL',
  replayKey: string | undefined,
  error: unknown
): Promise<void> {
  if (
    !(error instanceof HttpError)
    || error.details?.code !== 'SUPPORT_IDEMPOTENCY_PAYLOAD_MISMATCH'
  ) return;
  const replayKeyHash = replayKey
    ? hashSupportPayload(Buffer.from(replayKey, 'utf8'))
    : null;
  // This audit is intentionally outside the failed Case transaction, otherwise the mismatch row
  // would roll back with the rejected write. Never persist the raw provider/idempotency key.
  try {
    await prisma.activityLog.create({
      data: {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        actorType: actor.actorType,
        actorRuntime: actor.actorRuntime,
        entityType: 'support_intake_security',
        entityId: actor.user.id,
        action: 'support_idempotency_payload_mismatch',
        after: { operation, replayKeyHash },
        source: actor.source
      }
    });
  } catch {
    // Preserve the original 409 if the secondary audit sink is unavailable.
  }
}

export async function listSupportCaseEvents(actor: RequestActor, idOrKey: string) {
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  const events = await prisma.supportCaseEvent.findMany({
    where: { workspaceId: actor.workspace.id, caseId: supportCase.id },
    orderBy: { sequence: 'asc' },
    select: {
      id: true,
      sequence: true,
      actorId: true,
      actorType: true,
      actorRuntime: true,
      source: true,
      action: true,
      before: true,
      after: true,
      reason: true,
      occurredAt: true,
      createdAt: true,
      actor: { select: supportUserSelect }
    }
  });
  return {
    items: events.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      createdAt: event.createdAt.toISOString()
    })),
    total: events.length,
    caseId: supportCase.id,
    caseKey: supportCase.key,
    accessEpoch: access.epoch.toString()
  };
}

type LockedCaseResult = { supportCase: SupportCaseView; access: SupportAccess };

async function lockSupportCaseForAccess(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  idOrKey: string
): Promise<LockedCaseResult> {
  assertSupportWorkspace(actor.workspace);
  const access = await resolveSupportAccess(actor, tx);
  const normalized = idOrKey.trim();
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "SupportCase"
    WHERE "workspaceId" = ${actor.workspace.id}::uuid
      AND ("id"::text = ${normalized} OR "key" = ${normalized.toUpperCase()})
    FOR UPDATE
  `);
  const id = rows[0]?.id;
  if (!id) throw new HttpError(404, 'Support Case not found');
  const supportCase = await tx.supportCase.findUnique({ where: { id }, include: supportCaseInclude });
  if (!supportCase || !canReadSupportCase(access, supportCase)) {
    throw new HttpError(404, 'Support Case not found');
  }
  return { supportCase, access };
}

async function mutateSupportCase(
  actor: RequestActor,
  idOrKey: string,
  baseVersion: number,
  mutation: (
    tx: Prisma.TransactionClient,
    current: SupportCaseView,
    access: SupportAccess
  ) => Promise<SupportCaseView>
) {
  return prisma.$transaction(async (tx) => {
    const { supportCase: current, access } = await lockSupportCaseForAccess(tx, actor, idOrKey);
    assertCurrentVersion(current, baseVersion, access);
    const supportCase = await mutation(tx, current, access);
    return { supportCase, access };
  });
}

function assertCurrentVersion(
  current: SupportCaseView,
  baseVersion: number,
  access: SupportAccess
): void {
  if (current.version === baseVersion) return;
  throw new HttpError(
    409,
    'Support Case changed on another client',
    { code: 'SUPPORT_VERSION_CONFLICT', current: serializeSupportCase(current, access) }
  );
}

function assertNonTerminal(supportCase: Pick<SupportCaseView, 'status'>): void {
  if (supportCase.status !== 'RESOLVED' && supportCase.status !== 'CLOSED') return;
  throw new HttpError(409, 'Terminal Support Cases must be reopened before this operation');
}

async function lockSupportCaseCreationIdempotency(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  idempotencyKey: string
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`support-case-create:${workspaceId}:${idempotencyKey}`})
    )
  `);
}

export async function reserveSupportCaseKey(
  tx: Prisma.TransactionClient,
  workspace: { id: string; slug: string }
): Promise<{ key: string; sequence: number }> {
  await tx.supportWorkspaceState.upsert({
    where: { workspaceId: workspace.id },
    update: {},
    create: {
      workspaceId: workspace.id,
      keyPrefix: deriveCasePrefix(workspace.slug)
    }
  });
  const rows = await tx.$queryRaw<Array<{ keyPrefix: string; nextCaseNumber: number }>>(Prisma.sql`
    SELECT "keyPrefix", "nextCaseNumber"
    FROM "SupportWorkspaceState"
    WHERE "workspaceId" = ${workspace.id}::uuid
    FOR UPDATE
  `);
  const state = rows[0];
  if (!state) throw new HttpError(500, 'Support Case key state is unavailable');
  await tx.supportWorkspaceState.update({
    where: { workspaceId: workspace.id },
    data: { nextCaseNumber: { increment: 1 } }
  });
  return {
    sequence: state.nextCaseNumber,
    key: `${state.keyPrefix}-${state.nextCaseNumber}`
  };
}

function deriveCasePrefix(slug: string): string {
  const normalized = slug.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const startsWithLetter = /^[A-Z]/.test(normalized) ? normalized : `S${normalized}`;
  return (startsWithLetter || 'SUPPORT').padEnd(2, 'X').slice(0, 8);
}

export async function resolveSupportContactId(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  input: Pick<CreateSupportCaseInput, 'contactId' | 'contact'>
): Promise<string | null> {
  if (input.contactId) {
    const contact = await tx.supportContact.findFirst({
      where: { id: input.contactId, workspaceId, redactedAt: null },
      select: { id: true }
    });
    if (!contact) throw new HttpError(400, 'Contact is not active in this workspace');
    return contact.id;
  }
  if (!input.contact) return null;

  const normalizedEmail = input.contact.email?.trim().toLowerCase();
  const normalizedPhone = input.contact.phone?.replace(/[^+\d]/g, '');
  // Inline intake facts never identify an existing contact by themselves. Silent email/phone
  // merging turns Case creation into an unmetered identity lookup and can enrich the response with
  // somebody else's data. Reuse requires the caller to select an explicit, access-controlled
  // contactId from the audited lookup flow; duplicate candidates may be resolved separately.
  return (await tx.supportContact.create({
    data: {
      workspaceId,
      name: input.contact.name,
      email: input.contact.email,
      normalizedEmail,
      phone: input.contact.phone,
      normalizedPhone,
      metadata: input.contact.externalCustomerId
        ? { externalCustomerId: input.contact.externalCustomerId }
        : undefined
    },
    select: { id: true }
  })).id;
}

function encryptInteractionContent(input: { body: string; format: 'text/plain' | 'text/markdown' }) {
  const bytes = Buffer.from(input.body, 'utf8');
  const encrypted = encryptSupportBytes(bytes);
  return {
    // Prisma's generated Bytes input is `Uint8Array<ArrayBuffer>`; `Buffer` may also be backed by
    // SharedArrayBuffer in the Node typings even though this concrete value is not.
    bodyCiphertext: Uint8Array.from(encrypted.ciphertext),
    encryptionKeyId: encrypted.keyId,
    bodyHash: hashSupportPayload(bytes),
    format: input.format
  };
}

async function resolveCallContactId(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  supportCase: Pick<SupportCaseView, 'id' | 'contactId'>,
  access: SupportAccess,
  input: Pick<CreateSupportCallInput, 'newCase' | 'contactId' | 'contact'>
): Promise<string | null> {
  if (input.contactId && input.contact) {
    throw new HttpError(400, 'Provide contactId or contact, not both');
  }
  // New-Case intake already resolved the outer/newCase contact once before creating the Case.
  if (input.newCase) return supportCase.contactId;
  if (input.contactId) {
    await assertSupportContactAvailableToCase(tx, access, supportCase.id, input.contactId);
    return input.contactId;
  }
  if (input.contact) {
    return resolveSupportContactId(tx, workspaceId, { contact: input.contact });
  }
  return supportCase.contactId;
}

/**
 * Contact ids are not capabilities. A Case reader may reuse its primary contact or a contact
 * already present on that Case, while intake-authorized actors may select from the audited minimal
 * directory. This prevents a known/guessed same-tenant UUID from becoming a contact-data lookup.
 */
async function assertSupportContactAvailableToCase(
  tx: Prisma.TransactionClient,
  access: SupportAccess,
  caseId: string,
  contactId: string
): Promise<void> {
  const contact = await tx.supportContact.findFirst({
    where: {
      id: contactId,
      workspaceId: access.workspaceId,
      redactedAt: null,
      ...(access.canIntake
        ? {}
        : {
            OR: [
              { cases: { some: { id: caseId } } },
              { interactions: { some: { caseId } } }
            ]
          })
    },
    select: { id: true }
  });
  if (!contact) throw new HttpError(400, 'Contact is not available for this Support Case');
}

function assertValidCallTimes(input: CreateSupportCallInput['call']): void {
  const startedAt = new Date(input.startedAt);
  const answeredAt = input.answeredAt ? new Date(input.answeredAt) : null;
  const endedAt = input.endedAt ? new Date(input.endedAt) : null;
  if (answeredAt && answeredAt < startedAt) {
    throw new HttpError(400, 'Call answer time cannot precede its start time');
  }
  if (endedAt && endedAt < startedAt) {
    throw new HttpError(400, 'Call end time cannot precede its start time');
  }
}

function latestDate(...values: Array<Date | null | undefined>): Date {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (!dates.length) return new Date();
  return dates.reduce((latest, value) => value > latest ? value : latest);
}

function earliestDate(...values: Date[]): Date {
  return values.reduce((earliest, value) => value < earliest ? value : earliest);
}

export async function appendSupportCaseEvent(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  supportCase: Pick<SupportCaseView, 'id' | 'workspaceId'>,
  input: {
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    reason?: string;
    idempotencyKey?: string;
    correlationId?: string;
    source?: SupportCaseEventSource;
  }
): Promise<void> {
  await appendSupportCaseEventRecord(tx, supportCase, {
    ...input,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    source: input.source ?? supportEventSource(actor)
  });
}

/** Transaction-aware provenance seam for connector/system intake, which has no RequestActor. */
export async function appendSupportCaseSystemEvent(
  tx: Prisma.TransactionClient,
  supportCase: { id: string; workspaceId: string },
  input: {
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    reason?: string;
    idempotencyKey?: string;
    correlationId?: string;
    occurredAt?: Date;
    source: SupportCaseEventSource;
  }
): Promise<void> {
  await appendSupportCaseEventRecord(tx, supportCase, {
    ...input,
    actorId: null,
    actorType: 'SYSTEM',
    actorRuntime: null
  });
}

async function appendSupportCaseEventRecord(
  tx: Prisma.TransactionClient,
  supportCase: { id: string; workspaceId: string },
  input: {
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    reason?: string;
    idempotencyKey?: string;
    correlationId?: string;
    occurredAt?: Date;
    actorId: string | null;
    actorType: ActorType;
    actorRuntime: AgentRuntime | null;
    source: SupportCaseEventSource;
  }
): Promise<void> {
  const latest = await tx.supportCaseEvent.findFirst({
    where: { caseId: supportCase.id },
    orderBy: { sequence: 'desc' },
    select: { sequence: true }
  });
  await tx.supportCaseEvent.create({
    data: {
      workspaceId: supportCase.workspaceId,
      caseId: supportCase.id,
      sequence: (latest?.sequence ?? 0) + 1,
      actorId: input.actorId,
      actorType: input.actorType,
      actorRuntime: input.actorRuntime,
      source: input.source,
      correlationId: input.correlationId,
      action: input.action,
      before: input.before,
      after: input.after,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt
    }
  });
}

function supportEventSource(actor: RequestActor): SupportCaseEventSource {
  if (actor.source === 'WEB') return 'WEB';
  if (actor.source === 'SYSTEM') return 'SYSTEM';
  return 'API';
}

export function caseEventSnapshot(
  supportCase: Pick<
    SupportCaseView,
    | 'id'
    | 'key'
    | 'status'
    | 'departmentId'
    | 'assigneeMembershipId'
    | 'priority'
    | 'nextActionAt'
    | 'resolutionCode'
    | 'resolvedAt'
    | 'closedAt'
    | 'version'
  >
): Prisma.InputJsonObject {
  return {
    id: supportCase.id,
    key: supportCase.key,
    status: supportCase.status,
    departmentId: supportCase.departmentId,
    assigneeMembershipId: supportCase.assigneeMembershipId,
    priority: supportCase.priority,
    nextActionAt: supportCase.nextActionAt?.toISOString() ?? null,
    resolutionCode: supportCase.resolutionCode,
    resolvedAt: supportCase.resolvedAt?.toISOString() ?? null,
    closedAt: supportCase.closedAt?.toISOString() ?? null,
    version: supportCase.version
  };
}

function ownershipAction(before: SupportCaseView, after: SupportCaseView): string {
  if (before.departmentId !== after.departmentId) {
    return before.departmentId ? 'case.transferred' : 'case.routed';
  }
  if (before.assigneeMembershipId && !after.assigneeMembershipId) return 'case.unassigned';
  if (before.assigneeMembershipId !== after.assigneeMembershipId) return 'case.assigned';
  return 'case.routing_confirmed';
}

function supportSlaOwnershipEvent(
  before: SupportCaseView,
  after: SupportCaseView
): SupportClockEvent | null {
  if (before.departmentId !== after.departmentId) {
    return before.departmentId ? 'TRANSFERRED' : 'ROUTED';
  }
  if (before.assigneeMembershipId && !after.assigneeMembershipId) return 'UNASSIGNED';
  if (before.assigneeMembershipId !== after.assigneeMembershipId && after.assigneeMembershipId) {
    return 'ASSIGNED';
  }
  return null;
}

function supportInteractionSlaEvent(
  input: Pick<AddSupportInteractionInput, 'direction' | 'visibility'>,
  reopensResolved: boolean,
  isHumanPublicResponse: boolean
): SupportClockEvent {
  if (reopensResolved) return 'REOPENED';
  if (input.direction === 'INBOUND' && input.visibility === 'PUBLIC') return 'CUSTOMER_ACTIVITY';
  if (input.direction === 'OUTBOUND' && input.visibility === 'PUBLIC') {
    return isHumanPublicResponse ? 'HUMAN_PUBLIC_RESPONSE' : 'AUTOMATED_PUBLIC_RESPONSE';
  }
  return 'INTERNAL_NOTE';
}

async function applySupportCaseSlaEvent(
  tx: Prisma.TransactionClient,
  supportCase: SupportCaseView,
  input: {
    event: SupportClockEvent;
    at: Date;
    interaction?: SupportInteractionQualification;
  }
): Promise<void> {
  const result = await applySupportSlaCaseEvent(tx, {
    workspaceId: supportCase.workspaceId,
    caseId: supportCase.id,
    ...input
  });
  // The SLA helper updates this projection in the database. Keep the already-loaded aggregate in
  // sync so the command response never exposes the previous deadline until its next read.
  supportCase.nextSlaDueAt = result.nextSlaDueAt;
}

async function ownershipAudienceLosingAccess(
  tx: Prisma.TransactionClient,
  before: SupportCaseView,
  after: SupportCaseView
): Promise<string[]> {
  if (
    before.departmentId === after.departmentId
    && before.assigneeMembershipId === after.assigneeMembershipId
  ) return [];

  const [oldDepartmentAudience, triageGrants, credentialTriageGrants] = await Promise.all([
    tx.departmentMember.findMany({
      where: {
        workspaceId: before.workspaceId,
        active: true,
        OR: [
          ...(before.departmentId
            ? [{ departmentId: before.departmentId, role: 'MANAGER' as const }]
            : []),
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

  // measured-people:allow — Authorization audience subtraction for one Case transfer, not a people metric.
  const currentHumanScopes = await tx.workspaceMember.findMany({
    where: { workspaceId: before.workspaceId, userId: { in: candidateUserIds } },
    select: {
      userId: true,
      role: true,
      user: { select: { kind: true } },
      supportPermissionGrants: {
        where: { role: 'SUPERVISOR' },
        select: { id: true }
      },
      departmentMemberships: {
        where: {
          active: true,
          OR: [
            ...(after.departmentId
              ? [{ departmentId: after.departmentId, role: 'MANAGER' as const }]
              : []),
            ...(after.assigneeMembershipId ? [{ id: after.assigneeMembershipId }] : [])
          ]
        },
        select: { id: true }
      }
    }
  });
  const currentHumanScopeByUserId = new Map(currentHumanScopes.map((scope) => [scope.userId, scope]));
  return candidateUserIds.filter((userId) => {
    const scope = currentHumanScopeByUserId.get(userId);
    // Human admins, supervisors, destination managers and the destination assignee still read the
    // Case. Credential actors use a separate permission branch, so their triage scope is reset
    // conservatively; a credential with CASE_READ simply rehydrates after the reset.
    if (scope?.user.kind === 'HUMAN') {
      if (scope.role === 'OWNER' || scope.role === 'ADMIN') return false;
      if (scope.supportPermissionGrants.length || scope.departmentMemberships.length) return false;
    }
    return true;
  });
}

export function caseIdentifierWhere(idOrKey: string): Prisma.SupportCaseWhereInput {
  const normalized = idOrKey.trim();
  return {
    OR: [
      ...(isUuid(normalized) ? [{ id: normalized }] : []),
      { key: normalized.toUpperCase() }
    ]
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hours(value: number): number {
  return value * 60 * 60 * 1000;
}

/** Serializes Department membership changes with Case ownership validation. */
export async function lockSupportOwnershipGraph(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  workspaceId: string
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(187641, hashtext(${workspaceId}))
  `);
}
