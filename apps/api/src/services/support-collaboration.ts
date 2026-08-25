import { Prisma, prisma, type SupportSavedViewVisibility, type WorkspaceRole } from '@taskara/db';
import { z } from 'zod';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import {
  canReadSupportCase,
  departmentWhereForAccess,
  resolveSupportAccess,
  supportCaseWhereForAccess,
  type SupportAccess
} from './support-access';
import {
  findSupportCaseForAccess,
  serializeSupportCase,
  supportAttentionCaseWhere,
  supportAttentionReasonsByCaseIds,
  supportAttentionWhere,
  supportCaseInclude,
  supportQueueWhere,
  type SupportCaseView
} from './support-cases';

const supportStatuses = [
  'NEW',
  'OPEN',
  'WAITING_ON_CUSTOMER',
  'WAITING_ON_INTERNAL',
  'RESOLVED',
  'CLOSED'
] as const;
const supportPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const supportSources = ['API', 'CALL', 'MANUAL', 'EMAIL', 'MESSAGING'] as const;
const supportQueues = ['TRIAGE', 'DEPARTMENT_INBOX', 'MY_CASES', 'NEEDS_ATTENTION'] as const;
const supportAttentionReasons = [
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
  'LINKED_TASK_BLOCKED_OR_OVERDUE'
] as const;
const savedViewVisibilities = ['PRIVATE', 'DEPARTMENT', 'WORKSPACE'] as const;
const DEFAULT_PRESENCE_TTL_MS = 45_000;

function uniqueArray<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.array(item).max(max).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Values must be unique' });
    }
  });
}

export const supportSavedViewFiltersSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  queue: z.enum(supportQueues).optional(),
  statuses: uniqueArray(z.enum(supportStatuses), supportStatuses.length).default([]),
  departmentId: z.string().uuid().optional(),
  assigneeMembershipId: z.string().uuid().optional(),
  priorities: uniqueArray(z.enum(supportPriorities), supportPriorities.length).default([]),
  sourceChannels: uniqueArray(z.enum(supportSources), supportSources.length).default([]),
  typeKey: z.string().trim().toLowerCase().min(1).max(64)
    .regex(/^[a-z][a-z0-9_-]*$/).optional(),
  attentionReason: z.enum(supportAttentionReasons).optional(),
  receivedWithinHours: z.number().int().min(1).max(24 * 366).optional()
}).strict();

export const createSupportSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(160),
  visibility: z.enum(savedViewVisibilities).default('PRIVATE'),
  departmentId: z.string().uuid().optional(),
  filters: supportSavedViewFiltersSchema.default({})
}).strict().superRefine(validateVisibilityShape);

export const updateSupportSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  visibility: z.enum(savedViewVisibilities).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  filters: supportSavedViewFiltersSchema.optional(),
  baseVersion: z.number().int().positive()
}).strict().refine((input) =>
  input.name !== undefined
  || input.visibility !== undefined
  || input.departmentId !== undefined
  || input.filters !== undefined,
{ message: 'At least one saved view field is required' });

export const deleteSupportSavedViewSchema = z.object({
  baseVersion: z.coerce.number().int().positive()
}).strict();

export const useSupportSavedViewSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().max(500).optional()
}).strict();

export const supportSavedViewIdSchema = z.string().uuid();

const presenceClientIdSchema = z.string().trim().min(8).max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const touchSupportCasePresenceSchema = z.object({
  clientId: presenceClientIdSchema,
  intent: z.enum(['VIEWING', 'EDITING']),
  baseVersion: z.number().int().positive()
}).strict();

export const readSupportCasePresenceSchema = z.object({
  baseVersion: z.coerce.number().int().positive(),
  clientId: presenceClientIdSchema.optional()
}).strict();

export const releaseSupportCasePresenceSchema = z.object({
  baseVersion: z.coerce.number().int().positive(),
  clientId: presenceClientIdSchema
}).strict();

export type SupportSavedViewFilters = z.infer<typeof supportSavedViewFiltersSchema>;
export type CreateSupportSavedViewInput = z.infer<typeof createSupportSavedViewSchema>;
export type UpdateSupportSavedViewInput = z.infer<typeof updateSupportSavedViewSchema>;
export type TouchSupportCasePresenceInput = z.infer<typeof touchSupportCasePresenceSchema>;

interface PresenceRecord {
  workspaceId: string;
  caseId: string;
  userId: string;
  clientId: string;
  intent: 'VIEWING' | 'EDITING';
  caseVersion: number;
  touchedAt: Date;
  expiresAt: Date;
}

/** Process-local by design: restarts clear presence and no durable behavior history is produced. */
export class SupportCasePresenceRegistry {
  private readonly records = new Map<string, PresenceRecord>();

  constructor(
    private readonly ttlMilliseconds = DEFAULT_PRESENCE_TTL_MS,
    private readonly maximumEntries = 10_000
  ) {
    if (!Number.isInteger(ttlMilliseconds) || ttlMilliseconds < 1_000 || ttlMilliseconds > 120_000) {
      throw new Error('Support presence TTL must be between 1 and 120 seconds');
    }
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error('Support presence maximum entries must be positive');
    }
  }

  touch(
    input: Omit<PresenceRecord, 'touchedAt' | 'expiresAt'>,
    now = new Date()
  ): PresenceRecord {
    this.prune(now);
    if (this.records.size >= this.maximumEntries && !this.records.has(presenceKey(input))) {
      const oldest = [...this.records.entries()]
        .sort((left, right) => left[1].expiresAt.getTime() - right[1].expiresAt.getTime())[0];
      if (oldest) this.records.delete(oldest[0]);
    }
    const record: PresenceRecord = {
      ...input,
      touchedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMilliseconds)
    };
    this.records.set(presenceKey(record), record);
    return record;
  }

  activeForCase(workspaceId: string, caseId: string, now = new Date()): PresenceRecord[] {
    this.prune(now);
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId && record.caseId === caseId)
      .sort((left, right) =>
        left.userId.localeCompare(right.userId) || left.clientId.localeCompare(right.clientId)
      );
  }

  release(workspaceId: string, caseId: string, userId: string, clientId: string): boolean {
    return this.records.delete(presenceKey({ workspaceId, caseId, userId, clientId }));
  }

  clear(): void {
    this.records.clear();
  }

  private prune(now: Date) {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }
}

export const supportCasePresenceRegistry = new SupportCasePresenceRegistry();

export async function listSupportSavedViews(actor: RequestActor) {
  const access = await supportHumanAccess(actor);
  const views = await prisma.supportSavedView.findMany({
    where: savedViewVisibilityWhere(actor.user.id, access),
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
  });
  const visible = [];
  for (const view of views) {
    const parsed = supportSavedViewFiltersSchema.safeParse(view.filters);
    if (!parsed.success) continue;
    if (!await filtersAllowedForAccess(parsed.data, view.visibility, view.departmentId, access)) continue;
    visible.push(serializeSavedView(view, parsed.data));
  }
  return { items: visible, accessEpoch: access.epoch.toString() };
}

export async function getSupportSavedView(actor: RequestActor, id: string) {
  const { view, filters, access } = await loadUsableSavedView(actor, id);
  return { ...serializeSavedView(view, filters), accessEpoch: access.epoch.toString() };
}

export async function createSupportSavedView(
  actor: RequestActor,
  rawInput: CreateSupportSavedViewInput
) {
  const input = createSupportSavedViewSchema.parse(rawInput);
  const access = await supportHumanAccess(actor);
  await assertCanOwnVisibility(input.visibility, input.departmentId ?? null, access);
  await assertFiltersAllowed(input.filters, input.visibility, input.departmentId ?? null, access);
  const view = await prisma.supportSavedView.create({
    data: {
      workspaceId: actor.workspace.id,
      ownerId: actor.user.id,
      name: input.name,
      visibility: input.visibility,
      departmentId: input.departmentId,
      filters: input.filters
    }
  });
  return serializeSavedView(view, input.filters);
}

export async function updateSupportSavedView(
  actor: RequestActor,
  id: string,
  rawInput: UpdateSupportSavedViewInput
) {
  const input = updateSupportSavedViewSchema.parse(rawInput);
  const access = await supportHumanAccess(actor);
  return prisma.$transaction(async (tx) => {
    await lockSavedView(tx, actor.workspace.id, id);
    const current = await tx.supportSavedView.findFirst({
      where: { id, workspaceId: actor.workspace.id, ownerId: actor.user.id }
    });
    if (!current) throw new HttpError(404, 'Support saved view not found');
    assertSavedViewVersion(current.version, input.baseVersion);
    const currentFilters = parseStoredFilters(current.filters);
    const visibility = input.visibility ?? current.visibility;
    const departmentId = input.departmentId === undefined
      ? current.departmentId
      : input.departmentId;
    assertVisibilityShape({ visibility, departmentId });
    const filters = input.filters ?? currentFilters;
    await assertCanOwnVisibility(visibility, departmentId, access, tx);
    await assertFiltersAllowed(filters, visibility, departmentId, access, tx);
    const updated = await tx.supportSavedView.update({
      where: { id: current.id },
      data: {
        name: input.name,
        visibility,
        departmentId,
        filters,
        version: { increment: 1 }
      }
    });
    return serializeSavedView(updated, filters);
  });
}

export async function deleteSupportSavedView(
  actor: RequestActor,
  id: string,
  baseVersion: number
) {
  await supportHumanAccess(actor);
  return prisma.$transaction(async (tx) => {
    await lockSavedView(tx, actor.workspace.id, id);
    const current = await tx.supportSavedView.findFirst({
      where: { id, workspaceId: actor.workspace.id, ownerId: actor.user.id },
      select: { id: true, version: true }
    });
    if (!current) throw new HttpError(404, 'Support saved view not found');
    assertSavedViewVersion(current.version, baseVersion);
    await tx.supportSavedView.delete({ where: { id: current.id } });
  });
}

export async function listCasesForSupportSavedView(
  actor: RequestActor,
  id: string,
  input: z.infer<typeof useSupportSavedViewSchema>
) {
  const { view, filters, access } = await loadUsableSavedView(actor, id);
  const now = new Date();
  const filterWhere = await savedViewCaseWhere(
    filters,
    access,
    view.visibility === 'DEPARTMENT' ? view.departmentId : null,
    now
  );
  const baseWhere: Prisma.SupportCaseWhereInput = {
    AND: [supportCaseWhereForAccess(access), filterWhere]
  };
  const cursor = decodeCaseCursor(input.cursor);
  const where: Prisma.SupportCaseWhereInput = cursor
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { receivedAt: { lt: cursor.receivedAt } },
              { receivedAt: cursor.receivedAt, id: { lt: cursor.id } }
            ]
          }
        ]
      }
    : baseWhere;
  const [rows, total] = await Promise.all([
    prisma.supportCase.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      include: supportCaseInclude
    }),
    prisma.supportCase.count({ where: baseWhere })
  ]);
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const reasons = await supportAttentionReasonsByCaseIds(
    actor.workspace.id,
    page.map((supportCase) => supportCase.id),
    now
  );
  return {
    savedView: serializeSavedView(view, filters),
    items: page.map((supportCase) => serializeSupportCase(
      supportCase,
      access,
      now,
      reasons.get(supportCase.id)
    )),
    total,
    nextCursor: hasMore && page.at(-1) ? encodeCaseCursor(page.at(-1)!) : null,
    accessEpoch: access.epoch.toString()
  };
}

export async function touchSupportCasePresence(
  actor: RequestActor,
  idOrKey: string,
  rawInput: TouchSupportCasePresenceInput,
  registry = supportCasePresenceRegistry
) {
  const input = touchSupportCasePresenceSchema.parse(rawInput);
  assertHumanPresenceActor(actor);
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  assertCaseVersion(supportCase, input.baseVersion, access);
  const own = registry.touch({
    workspaceId: actor.workspace.id,
    caseId: supportCase.id,
    userId: actor.user.id,
    clientId: input.clientId,
    intent: input.intent,
    caseVersion: supportCase.version
  });
  const collision = await presenceCollision(actor, supportCase, registry, input.clientId);
  return {
    caseId: supportCase.id,
    caseVersion: supportCase.version,
    expiresAt: own.expiresAt.toISOString(),
    collision
  };
}

export async function readSupportCasePresence(
  actor: RequestActor,
  idOrKey: string,
  input: z.infer<typeof readSupportCasePresenceSchema>,
  registry = supportCasePresenceRegistry
) {
  assertHumanPresenceActor(actor);
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  assertCaseVersion(supportCase, input.baseVersion, access);
  return {
    caseId: supportCase.id,
    caseVersion: supportCase.version,
    collision: await presenceCollision(actor, supportCase, registry, input.clientId)
  };
}

export async function releaseSupportCasePresence(
  actor: RequestActor,
  idOrKey: string,
  input: z.infer<typeof releaseSupportCasePresenceSchema>,
  registry = supportCasePresenceRegistry
) {
  assertHumanPresenceActor(actor);
  const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
  assertCaseVersion(supportCase, input.baseVersion, access);
  registry.release(actor.workspace.id, supportCase.id, actor.user.id, input.clientId);
}

async function loadUsableSavedView(actor: RequestActor, id: string) {
  const access = await supportHumanAccess(actor);
  const view = await prisma.supportSavedView.findFirst({
    where: { id, ...savedViewVisibilityWhere(actor.user.id, access) }
  });
  if (!view) throw new HttpError(404, 'Support saved view not found');
  const parsed = supportSavedViewFiltersSchema.safeParse(view.filters);
  if (!parsed.success) throw new HttpError(404, 'Support saved view not found');
  if (!await filtersAllowedForAccess(parsed.data, view.visibility, view.departmentId, access)) {
    throw new HttpError(404, 'Support saved view not found');
  }
  return { view, filters: parsed.data, access };
}

async function supportHumanAccess(actor: RequestActor) {
  if (actor.credential || actor.user.kind !== 'HUMAN') {
    throw new HttpError(403, 'Support saved views require a human user');
  }
  const access = await resolveSupportAccess(actor);
  if (
    !access.workspaceWide
    && !access.triager
    && !access.managedDepartmentIds.length
    && !access.memberMembershipIds.length
  ) {
    throw new HttpError(403, 'Support Case read access required');
  }
  return access;
}

function savedViewVisibilityWhere(userId: string, access: SupportAccess): Prisma.SupportSavedViewWhereInput {
  return {
    workspaceId: access.workspaceId,
    OR: [
      { ownerId: userId },
      ...(access.workspaceWide
        ? [{ visibility: { in: ['DEPARTMENT', 'WORKSPACE'] as SupportSavedViewVisibility[] } }]
        : access.managedDepartmentIds.length
          ? [{ visibility: 'DEPARTMENT' as const, departmentId: { in: access.managedDepartmentIds } }]
          : [])
    ]
  };
}

async function assertCanOwnVisibility(
  visibility: SupportSavedViewVisibility,
  departmentId: string | null,
  access: SupportAccess,
  client: Pick<Prisma.TransactionClient, 'department'> = prisma
) {
  if (visibility === 'PRIVATE') return;
  if (visibility === 'WORKSPACE') {
    if (access.workspaceWide) return;
    throw new HttpError(403, 'Support-wide access is required to share a workspace saved view');
  }
  if (!departmentId) throw new HttpError(400, 'Department saved views require a Department');
  const department = await client.department.findFirst({
    where: { id: departmentId, workspaceId: access.workspaceId, active: true },
    select: { id: true }
  });
  if (!department) throw new HttpError(404, 'Department not found');
  if (access.workspaceWide || access.managedDepartmentIds.includes(departmentId)) return;
  throw new HttpError(403, 'Department manager access is required to share this saved view');
}

async function assertFiltersAllowed(
  filters: SupportSavedViewFilters,
  visibility: SupportSavedViewVisibility,
  departmentId: string | null,
  access: SupportAccess,
  client: Pick<Prisma.TransactionClient, 'department' | 'departmentMember'> = prisma
) {
  if (!await filtersAllowedForAccess(filters, visibility, departmentId, access, client)) {
    throw new HttpError(403, 'Saved view filters exceed the current Support access scope');
  }
}

async function filtersAllowedForAccess(
  filters: SupportSavedViewFilters,
  visibility: SupportSavedViewVisibility,
  departmentId: string | null,
  access: SupportAccess,
  client: Pick<Prisma.TransactionClient, 'department' | 'departmentMember'> = prisma
) {
  if (visibility === 'DEPARTMENT') {
    if (!departmentId) return false;
    if (!access.workspaceWide && !access.managedDepartmentIds.includes(departmentId)) return false;
    if (filters.departmentId && filters.departmentId !== departmentId) return false;
  }
  if (visibility === 'WORKSPACE' && !access.workspaceWide) return false;
  if (filters.queue === 'TRIAGE' && !access.triager && !access.workspaceWide) return false;
  if (
    filters.queue === 'DEPARTMENT_INBOX'
    && !access.workspaceWide
    && !access.managedDepartmentIds.length
  ) return false;
  if (filters.queue === 'MY_CASES' && !access.memberMembershipIds.length) return false;

  if (filters.departmentId) {
    const visibleDepartment = await client.department.findFirst({
      where: { id: filters.departmentId, ...departmentWhereForAccess(access) },
      select: { id: true }
    });
    if (!visibleDepartment) return false;
  }
  if (filters.assigneeMembershipId) {
    const membership = await client.departmentMember.findFirst({
      where: {
        id: filters.assigneeMembershipId,
        workspaceId: access.workspaceId,
        active: true
      },
      select: { id: true, departmentId: true }
    });
    if (!membership) return false;
    if (departmentId && membership.departmentId !== departmentId) return false;
    if (filters.departmentId && membership.departmentId !== filters.departmentId) return false;
    if (
      !access.workspaceWide
      && !access.managedDepartmentIds.includes(membership.departmentId)
      && !access.memberMembershipIds.includes(membership.id)
    ) return false;
  }
  return true;
}

async function savedViewCaseWhere(
  filters: SupportSavedViewFilters,
  access: SupportAccess,
  scopeDepartmentId: string | null,
  now: Date
): Promise<Prisma.SupportCaseWhereInput> {
  const conditions: Prisma.SupportCaseWhereInput[] = [];
  if (scopeDepartmentId) conditions.push({ departmentId: scopeDepartmentId });
  if (filters.statuses.length) conditions.push({ status: { in: filters.statuses } });
  if (filters.departmentId) conditions.push({ departmentId: filters.departmentId });
  if (filters.assigneeMembershipId) {
    conditions.push({ assigneeMembershipId: filters.assigneeMembershipId });
  }
  if (filters.priorities.length) conditions.push({ priority: { in: filters.priorities } });
  if (filters.sourceChannels.length) {
    conditions.push({ sourceChannel: { in: filters.sourceChannels } });
  }
  if (filters.typeKey) conditions.push({ typeKey: filters.typeKey });
  if (filters.receivedWithinHours) {
    conditions.push({
      receivedAt: { gte: new Date(now.getTime() - filters.receivedWithinHours * 60 * 60 * 1000) }
    });
  }
  if (filters.attentionReason) {
    const visibleIds = await prisma.supportCase.findMany({
      where: {
        AND: [
          supportCaseWhereForAccess(access),
          ...(scopeDepartmentId ? [{ departmentId: scopeDepartmentId }] : [])
        ]
      },
      select: { id: true }
    });
    const projected = await supportAttentionReasonsByCaseIds(
      access.workspaceId,
      visibleIds.map((item) => item.id),
      now
    );
    const projectedIds = visibleIds
      .map((item) => item.id)
      .filter((id) => projected.get(id)?.includes(filters.attentionReason!));
    conditions.push({
      OR: [supportAttentionWhere(filters.attentionReason, now), { id: { in: projectedIds } }]
    });
  }
  if (filters.queue) {
    const projectedWhere = filters.queue === 'NEEDS_ATTENTION'
      ? await supportAttentionCaseWhere(access.workspaceId, now)
      : undefined;
    conditions.push(supportQueueWhere(filters.queue, access, now, projectedWhere));
  }
  return conditions.length ? { AND: conditions } : {};
}

async function presenceCollision(
  actor: RequestActor,
  supportCase: SupportCaseView,
  registry: SupportCasePresenceRegistry,
  excludedClientId?: string
) {
  const active = registry.activeForCase(actor.workspace.id, supportCase.id)
    .filter((record) => !(record.userId === actor.user.id && record.clientId === excludedClientId));
  const userIds = [...new Set(active.map((record) => record.userId))];
  // measured-people:allow — Revalidates short-lived viewers of one exact Case, not a people metric.
  const memberships = await prisma.workspaceMember.findMany({
    where: {
      workspaceId: actor.workspace.id,
      userId: { in: userIds },
      user: { kind: 'HUMAN' }
    },
    include: { user: true }
  });
  const readableUsers = new Map<string, typeof memberships[number]['user']>();
  for (const membership of memberships) {
    const presenceActor: RequestActor = {
      workspace: actor.workspace,
      user: membership.user,
      role: membership.role as WorkspaceRole,
      actorType: 'USER',
      actorRuntime: null,
      source: 'SYSTEM'
    };
    const access = await resolveSupportAccess(presenceActor);
    if (canReadSupportCase(access, supportCase)) {
      readableUsers.set(membership.userId, membership.user);
    }
  }
  const readers = active.flatMap((record) => {
    const user = readableUsers.get(record.userId);
    if (!user) return [];
    return [{
      user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
      clientId: record.clientId,
      intent: record.intent,
      caseVersion: record.caseVersion,
      staleVersion: record.caseVersion !== supportCase.version,
      expiresAt: record.expiresAt.toISOString()
    }];
  });
  return {
    hasConcurrentEditor: readers.some((reader) => reader.intent === 'EDITING'),
    hasVersionSkew: readers.some((reader) => reader.staleVersion),
    readers
  };
}

function assertHumanPresenceActor(actor: RequestActor) {
  if (actor.credential || actor.user.kind !== 'HUMAN') {
    throw new HttpError(403, 'Support Case presence requires a human user');
  }
}

function assertCaseVersion(current: SupportCaseView, baseVersion: number, access: SupportAccess) {
  if (current.version === baseVersion) return;
  throw new HttpError(409, 'Support Case changed on another client', {
    code: 'SUPPORT_VERSION_CONFLICT',
    current: serializeSupportCase(current, access)
  });
}

function validateVisibilityShape(
  input: { visibility: SupportSavedViewVisibility; departmentId?: string },
  context: z.RefinementCtx
) {
  const valid = input.visibility === 'DEPARTMENT'
    ? Boolean(input.departmentId)
    : input.departmentId === undefined;
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['departmentId'],
      message: input.visibility === 'DEPARTMENT'
        ? 'Department saved views require departmentId'
        : 'Only Department saved views accept departmentId'
    });
  }
}

function assertVisibilityShape(input: {
  visibility: SupportSavedViewVisibility;
  departmentId: string | null;
}) {
  if (input.visibility === 'DEPARTMENT' ? Boolean(input.departmentId) : input.departmentId === null) return;
  throw new HttpError(400, input.visibility === 'DEPARTMENT'
    ? 'Department saved views require a Department'
    : 'Only Department saved views accept a Department');
}

function parseStoredFilters(value: Prisma.JsonValue): SupportSavedViewFilters {
  const result = supportSavedViewFiltersSchema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(409, 'Stored Support saved view filters are no longer valid');
}

function serializeSavedView<T extends {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  visibility: SupportSavedViewVisibility;
  departmentId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>(view: T, filters: SupportSavedViewFilters) {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    ownerId: view.ownerId,
    name: view.name,
    visibility: view.visibility,
    departmentId: view.departmentId,
    filters,
    version: view.version,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString()
  };
}

async function lockSavedView(tx: Prisma.TransactionClient, workspaceId: string, id: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "SupportSavedView"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "id" = ${id}::uuid
    FOR UPDATE
  `);
}

function assertSavedViewVersion(current: number, baseVersion: number) {
  if (current === baseVersion) return;
  throw new HttpError(409, 'Support saved view changed on another client', {
    code: 'SUPPORT_SAVED_VIEW_VERSION_CONFLICT',
    currentVersion: current
  });
}

function encodeCaseCursor(input: { receivedAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({
    receivedAt: input.receivedAt.toISOString(),
    id: input.id
  }), 'utf8').toString('base64url');
}

function decodeCaseCursor(cursor?: string): { receivedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const receivedAt = new Date(typeof decoded.receivedAt === 'string' ? decoded.receivedAt : '');
    if (
      Number.isNaN(receivedAt.getTime())
      || typeof decoded.id !== 'string'
      || !z.string().uuid().safeParse(decoded.id).success
    ) throw new Error('invalid cursor');
    return { receivedAt, id: decoded.id };
  } catch {
    throw new HttpError(400, 'Invalid Support saved view cursor');
  }
}

function presenceKey(input: {
  workspaceId: string;
  caseId: string;
  userId: string;
  clientId: string;
}) {
  return `${input.workspaceId}:${input.caseId}:${input.userId}:${input.clientId}`;
}
