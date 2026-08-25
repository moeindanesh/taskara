import { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma, prisma, type SyncEvent } from '@taskara/db';
import { z } from 'zod';
import {
  addDepartmentMemberSchema,
  addSupportInteractionSchema,
  closeSupportCaseSchema,
  createDepartmentSchema,
  createSupportCallSchema,
  createSupportCaseSchema,
  reopenSupportCaseSchema,
  resolveSupportCaseSchema,
  routeSupportCaseSchema,
  setSupportCredentialGrantSchema,
  setSupportPermissionGrantSchema,
  supportCaseListQuerySchema,
  updateDepartmentMemberSchema,
  updateDepartmentSchema,
  waitOnSupportCaseSchema
} from '@taskara/shared';
import { getRequestActor, type RequestActor } from '../services/actor';
import { resolveCorsOrigin } from '../services/cors';
import { HttpError } from '../services/http';
import {
  addSupportInteraction,
  closeSupportCase,
  createSupportCall,
  createSupportCase,
  findSupportCaseForAccess,
  listSupportCaseEvents,
  listSupportCaseInteractions,
  reopenSupportCase,
  resolveSupportCase,
  routeSupportCase,
  serializeSupportCase,
  supportAttentionCaseWhere,
  supportAttentionWhere,
  supportAttentionReasonsByCaseIds,
  supportCaseInclude,
  supportQueueCounts,
  supportQueueWhere,
  waitOnSupportCase
} from '../services/support-cases';
import {
  addDepartmentMember,
  createDepartment,
  deactivateDepartmentMember,
  deleteSupportCredentialGrant,
  deleteSupportPermissionGrant,
  listDepartmentMembers,
  listDepartments,
  listSupportCredentialGrants,
  listSupportPermissionGrants,
  serializeDepartment,
  serializeDepartmentMember,
  setSupportCredentialGrant,
  setSupportPermissionGrant,
  updateDepartment,
  updateDepartmentMember
} from '../services/support-departments';
import {
  departmentWhereForAccess,
  resolveSupportAccess,
  supportCaseWhereForAccess,
  type SupportAccess
} from '../services/support-access';
import { supportDataEncryptionAvailable } from '../services/support-crypto';
import { searchSupportContacts } from '../services/support-operations';
import {
  assertSupportAccessEpoch,
  latestSupportCursor,
  openSupportCursor,
  sealSupportCursor,
  startSupportSyncWakeupPoller,
  supportCaseIdForEvent,
  supportScopeChanged,
  supportSyncEventPayload,
  supportSyncHub,
  type SupportSyncWakeup
} from '../services/support-sync';
import {
  ensurePendingClientMutation,
  markClientMutationRejected,
  type SyncMutationMeta
} from '../services/sync';

type SupportCaseListQuery = ReturnType<typeof supportCaseListQuerySchema.parse>;

const supportSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const supportSyncPullQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(1_000),
  accessEpoch: z.string().regex(/^\d+$/),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

const supportSyncStreamQuerySchema = supportSyncPullQuerySchema.pick({
  cursor: true,
  accessEpoch: true
}).extend({
  clientId: z.string().trim().min(1).max(160).optional()
});

const supportSyncPushMutationSchema = z.object({
  mutationId: z.string().trim().min(1).max(160),
  name: z.enum([
    'case.route',
    'case.wait',
    'case.nextAction',
    'case.interaction',
    'case.resolve',
    'case.close',
    'case.reopen'
  ]),
  args: z.unknown()
});

const supportSyncPushSchema = z.object({
  accessEpoch: z.string().regex(/^\d+$/),
  clientId: z.string().trim().min(1).max(160),
  mutations: z.array(supportSyncPushMutationSchema).min(1).max(50)
});

const supportSyncCaseMutationArgsSchema = z.object({
  idOrKey: z.string().trim().min(1).max(240),
  input: z.unknown()
});

export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/departments', async (request) => {
    const actor = await getRequestActor(request);
    return listDepartments(actor);
  });

  app.post('/support/departments', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createDepartmentSchema.parse(request.body);
    const department = await createDepartment(actor, input);
    return reply.code(201).send(serializeDepartment(department, { includeRoutingSettings: true }));
  });

  app.patch('/support/departments/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = updateDepartmentSchema.parse(request.body);
    return serializeDepartment(await updateDepartment(actor, id, input), { includeRoutingSettings: true });
  });

  app.get('/support/departments/:id/members', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return listDepartmentMembers(actor, id);
  });

  app.post('/support/departments/:id/members', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = addDepartmentMemberSchema.parse(request.body);
    const member = await addDepartmentMember(actor, id, input);
    return reply.code(201).send(serializeDepartmentMember(member));
  });

  app.patch('/support/departments/:id/members/:userId', async (request) => {
    const actor = await getRequestActor(request);
    const { id, userId } = request.params as { id: string; userId: string };
    const input = updateDepartmentMemberSchema.parse(request.body);
    return serializeDepartmentMember(await updateDepartmentMember(actor, id, userId, input));
  });

  app.delete('/support/departments/:id/members/:userId', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id, userId } = request.params as { id: string; userId: string };
    await deactivateDepartmentMember(actor, id, userId);
    return reply.code(204).send();
  });

  app.get('/support/permission-grants', async (request) => {
    return listSupportPermissionGrants(await getRequestActor(request));
  });

  app.put('/support/permission-grants', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = setSupportPermissionGrantSchema.parse(request.body);
    const grant = await setSupportPermissionGrant(actor, input);
    return reply.code(201).send({
      ...grant,
      createdAt: grant.createdAt.toISOString()
    });
  });

  app.delete('/support/permission-grants', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = setSupportPermissionGrantSchema.parse(request.query);
    if (!await deleteSupportPermissionGrant(actor, input)) {
      return reply.code(404).send({ message: 'Support permission grant not found' });
    }
    return reply.code(204).send();
  });

  app.get('/support/credential-grants', async (request) => {
    return listSupportCredentialGrants(await getRequestActor(request));
  });

  app.put('/support/credential-grants', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = setSupportCredentialGrantSchema.parse(request.body);
    const grant = await setSupportCredentialGrant(actor, input);
    return reply.code(201).send({ ...grant, createdAt: grant.createdAt.toISOString() });
  });

  app.delete('/support/credential-grants', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = setSupportCredentialGrantSchema.parse(request.query);
    if (!await deleteSupportCredentialGrant(actor, input)) {
      return reply.code(404).send({ message: 'Support credential grant not found' });
    }
    return reply.code(204).send();
  });

  app.get('/support/cases/counts', async (request) => {
    const actor = await getRequestActor(request);
    const access = await resolveSupportAccess(actor);
    return {
      counts: await supportQueueCounts(access),
      accessEpoch: access.epoch.toString()
    };
  });

  app.get('/support/counts', async (request) => {
    const actor = await getRequestActor(request);
    const access = await resolveSupportAccess(actor);
    return {
      counts: await supportQueueCounts(access),
      accessEpoch: access.epoch.toString()
    };
  });

  app.get('/support/search', async (request) => {
    const actor = await getRequestActor(request);
    const access = await resolveSupportAccess(actor);
    const query = supportSearchQuerySchema.parse(request.query);
    const textMatch: Prisma.SupportCaseWhereInput = {
      OR: [
        { key: { contains: query.q, mode: 'insensitive' } },
        { title: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
        { contact: { is: { name: { contains: query.q, mode: 'insensitive' } } } },
        { contact: { is: { email: { contains: query.q, mode: 'insensitive' } } } },
        { contact: { is: { phone: { contains: query.q } } } }
      ]
    };
    const [cases, contacts] = await Promise.all([
      prisma.supportCase.findMany({
        where: { AND: [supportCaseWhereForAccess(access), textMatch] },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        include: supportCaseInclude
      }),
      access.canIntake
        ? searchSupportContacts(actor, query.q, Math.min(query.limit, 20))
        : Promise.resolve([])
    ]);
    const projectedReasons = await supportAttentionReasonsByCaseIds(
      actor.workspace.id,
      cases.map((supportCase) => supportCase.id)
    );
    return {
      cases: cases.map((supportCase) => serializeSupportCase(
        supportCase,
        access,
        new Date(),
        projectedReasons.get(supportCase.id)
      )),
      contacts,
      accessEpoch: access.epoch.toString()
    };
  });

  app.get('/support/cases', async (request) => {
    const actor = await getRequestActor(request);
    const query = supportCaseListQuerySchema.parse(normalizeSupportListQuery(request.query));
    return listSupportCases(actor, query);
  });

  app.post('/support/cases', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createSupportCaseSchema.parse(request.body);
    const result = await createSupportCase(actor, input);
    if (result.access.credentialActor) {
      return reply.code(result.replayed ? 200 : 201).send({
        id: result.supportCase.id,
        key: result.supportCase.key,
        version: result.supportCase.version,
        replayed: result.replayed,
        accessEpoch: result.access.epoch.toString()
      });
    }
    return reply.code(result.replayed ? 200 : 201).send({
      ...serializeSupportCase(result.supportCase, result.access),
      replayed: result.replayed
    });
  });

  app.get('/support/cases/:idOrKey', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const { supportCase, access } = await findSupportCaseForAccess(actor, idOrKey);
    const projected = await supportAttentionReasonsByCaseIds(
      actor.workspace.id,
      [supportCase.id]
    );
    return serializeSupportCase(supportCase, access, new Date(), projected.get(supportCase.id));
  });

  app.post('/support/cases/:idOrKey/route', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = routeSupportCaseSchema.parse(request.body);
    const result = await routeSupportCase(actor, idOrKey, input);
    return serializeSupportCase(result.supportCase, result.access);
  });

  app.post('/support/cases/:idOrKey/wait', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = waitOnSupportCaseSchema.parse(request.body);
    const result = await waitOnSupportCase(actor, idOrKey, input);
    return serializeSupportCase(result.supportCase, result.access);
  });

  app.post('/support/cases/:idOrKey/resolve', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = resolveSupportCaseSchema.parse(request.body);
    const result = await resolveSupportCase(actor, idOrKey, input);
    return serializeSupportCase(result.supportCase, result.access);
  });

  app.post('/support/cases/:idOrKey/close', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = closeSupportCaseSchema.parse(request.body);
    const result = await closeSupportCase(actor, idOrKey, input);
    return serializeSupportCase(result.supportCase, result.access);
  });

  app.post('/support/cases/:idOrKey/reopen', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = reopenSupportCaseSchema.parse(request.body);
    const result = await reopenSupportCase(actor, idOrKey, input);
    return serializeSupportCase(result.supportCase, result.access);
  });

  app.get('/support/cases/:idOrKey/interactions', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    return listSupportCaseInteractions(actor, idOrKey);
  });

  app.post('/support/cases/:idOrKey/interactions', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = addSupportInteractionSchema.parse(request.body);
    const result = await addSupportInteraction(actor, idOrKey, input);
    return reply.code(201).send({
      case: serializeSupportCase(result.supportCase, result.access),
      interaction: {
        ...result.interaction,
        occurredAt: result.interaction.occurredAt.toISOString(),
        receivedAt: result.interaction.receivedAt.toISOString(),
        createdAt: result.interaction.createdAt.toISOString()
      },
      accessEpoch: result.access.epoch.toString()
    });
  });

  app.get('/support/cases/:idOrKey/events', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    return listSupportCaseEvents(actor, idOrKey);
  });

  app.post('/support/calls', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createSupportCallSchema.parse(request.body);
    const result = await createSupportCall(actor, input);
    if (result.access.credentialActor) {
      return reply.code(201).send({
        case: {
          id: result.supportCase.id,
          key: result.supportCase.key,
          version: result.supportCase.version
        },
        interaction: { id: result.interaction.id },
        createdNewCase: result.createdNewCase,
        accessEpoch: result.access.epoch.toString()
      });
    }
    return reply.code(201).send({
      case: serializeSupportCase(result.supportCase, result.access),
      interaction: {
        ...result.interaction,
        occurredAt: result.interaction.occurredAt.toISOString(),
        receivedAt: result.interaction.receivedAt.toISOString(),
        createdAt: result.interaction.createdAt.toISOString(),
        call: result.call
          ? {
              ...result.call,
              startedAt: result.call.startedAt.toISOString(),
              answeredAt: result.call.answeredAt?.toISOString() ?? null,
              endedAt: result.call.endedAt?.toISOString() ?? null,
              callbackDueAt: result.call.callbackDueAt?.toISOString() ?? null,
              createdAt: result.call.createdAt.toISOString(),
              updatedAt: result.call.updatedAt.toISOString()
            }
          : null
      },
      internalNoteId: result.internalNoteId,
      createdNewCase: result.createdNewCase,
      accessEpoch: result.access.epoch.toString()
    });
  });

  app.get('/support/session', async (request) => {
    const actor = await getRequestActor(request);
    const access = await resolveSupportAccess(actor);
    return {
      mode: 'SUPPORT',
      accessEpoch: access.epoch.toString(),
      access: serializeSupportAccess(access),
      support: supportOperationalCapabilities(),
      counts: await supportQueueCounts(access)
    };
  });

  app.get('/support/sync/bootstrap', async (request) => {
    return supportSyncBootstrap(await getRequestActor(request));
  });

  app.get('/support/sync/pull', async (request) => {
    const actor = await getRequestActor(request);
    const query = supportSyncPullQuerySchema.parse(request.query);
    const access = await resolveSupportAccess(actor);
    assertSupportAccessEpoch(query.accessEpoch, access.epoch);
    return pullSupportSync(actor, access, query.cursor, query.limit);
  });

  app.post('/support/sync/push', async (request) => {
    const actor = await getRequestActor(request);
    const input = supportSyncPushSchema.parse(request.body);
    return pushSupportSync(actor, input);
  });

  app.get('/support/sync/stream', async (request, reply) => {
    const actor = await getRequestActor(request);
    // Support SSE is a browser collaboration channel. Long-lived credential connections cannot
    // re-authenticate after token rotation/revocation; automation uses epoch-bound HTTP pull,
    // which revalidates its credential on every request.
    if (actor.credential || actor.user.kind !== 'HUMAN') {
      throw new HttpError(403, 'Support sync stream requires a human session');
    }
    const query = supportSyncStreamQuerySchema.parse(request.query);
    const access = await resolveSupportAccess(actor);
    assertSupportAccessEpoch(query.accessEpoch, access.epoch);
    const cursor = openSupportCursor(query.cursor, {
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      accessEpoch: access.epoch
    });
    openSupportSyncStream(request, reply, actor, access, cursor.workspaceSeq, query.clientId);
  });
}

type SupportSyncPushInput = z.infer<typeof supportSyncPushSchema>;
type SupportSyncPushMutation = z.infer<typeof supportSyncPushMutationSchema>;

async function pullSupportSync(
  actor: RequestActor,
  access: SupportAccess,
  sealedCursor: string,
  limit: number
) {
  const cursor = openSupportCursor(sealedCursor, {
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    accessEpoch: access.epoch
  });
  const [earliestEvent, latestEvent] = await Promise.all([
    prisma.syncEvent.findFirst({
      where: { workspaceId: actor.workspace.id },
      orderBy: { workspaceSeq: 'asc' },
      select: { workspaceSeq: true }
    }),
    prisma.syncEvent.findFirst({
      where: { workspaceId: actor.workspace.id },
      orderBy: { workspaceSeq: 'desc' },
      select: { workspaceSeq: true }
    })
  ]);

  if (
    earliestEvent
    && cursor.workspaceSeq > 0n
    && cursor.workspaceSeq < earliestEvent.workspaceSeq - 1n
  ) {
    throw new HttpError(409, 'Support sync history is no longer available', {
      code: 'SUPPORT_CURSOR_RESET_REQUIRED',
      accessEpoch: access.epoch.toString()
    });
  }

  const now = new Date();
  type MappedSupportSyncEvent = NonNullable<Awaited<ReturnType<typeof mapSupportSyncEventForAccess>>>;
  const mapped = new Map<string, MappedSupportSyncEvent>();
  const highWaterSeq = latestEvent?.workspaceSeq ?? cursor.workspaceSeq;
  let scannedSeq = cursor.workspaceSeq;
  let responseSeq = cursor.workspaceSeq;
  let hasMore = false;

  // Raw workspace events are not an observable pagination unit: counting them would reveal peer
  // activity. Scan a fixed high-water snapshot until this reader has one authorized projection
  // beyond the requested page, or until all hidden events have been privately consumed.
  while (scannedSeq < highWaterSeq && !hasMore) {
    const rawEvents = await prisma.syncEvent.findMany({
      where: {
        workspaceId: actor.workspace.id,
        workspaceSeq: { gt: scannedSeq, lte: highWaterSeq }
      },
      orderBy: { workspaceSeq: 'asc' },
      take: 500
    });
    if (!rawEvents.length) break;

    for (const event of rawEvents) {
      const priorScannedSeq = scannedSeq;
      scannedSeq = event.workspaceSeq;
      const wireEvent = await mapSupportSyncEventForAccess(event, access, now);
      if (!wireEvent) continue;
      const key = `${wireEvent.entityType}:${wireEvent.entityId}`;
      // A page carries the final projection transition for an entity. This both avoids redundant
      // upserts and prevents event-count inference when several internal changes precede a handoff.
      mapped.delete(key);
      mapped.set(key, wireEvent);
      if (mapped.size > limit) {
        // The overflowing event stays behind the sealed cursor for the next page. Hidden events
        // immediately before it may be consumed because they carry no reader-visible transition.
        responseSeq = priorScannedSeq;
        hasMore = true;
        break;
      }
    }
  }
  if (!hasMore) responseSeq = scannedSeq;

  // Authorization may change while a page is being hydrated. Re-resolve after the entity reads
  // and refuse the whole payload if the epoch moved; no partial old-scope page reaches the client.
  const currentAccess = await resolveSupportAccess(actor);
  if (currentAccess.epoch !== access.epoch) throw supportScopeChanged(currentAccess.epoch);
  return {
    accessEpoch: access.epoch.toString(),
    cursor: sealSupportCursor({
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      accessEpoch: access.epoch.toString(),
      workspaceSeq: responseSeq
    }),
    hasMore,
    events: [...mapped.values()].slice(0, limit)
  };
}

/** Maps only an already-authorized projection; internal sequence/event metadata never crosses. */
export async function mapSupportSyncEventForAccess(
  event: SyncEvent,
  access: SupportAccess,
  now = new Date()
) {
  const payload = supportSyncEventPayload(event.payload);
  const caseId = supportCaseIdForEvent(event);
  if (caseId) {
    if (payload.removedUserIds?.includes(access.userId)) {
      return {
        type: 'removeFromScope' as const,
        entityType: 'support_case' as const,
        entityId: caseId
      };
    }

    const supportCase = await prisma.supportCase.findFirst({
      where: {
        AND: [supportCaseWhereForAccess(access), { id: caseId }]
      },
      include: supportCaseInclude
    });
    if (!supportCase) return null;
    if (event.operation === 'remove' || supportCase.status === 'CLOSED') {
      return {
        type: 'removeFromScope' as const,
        entityType: 'support_case' as const,
        entityId: caseId
      };
    }
    const projected = await supportAttentionReasonsByCaseIds(access.workspaceId, [caseId], now);
    return {
      type: 'upsert' as const,
      entityType: 'support_case' as const,
      entityId: caseId,
      entity: serializeSupportCase(supportCase, access, now, projected.get(caseId))
    };
  }

  if (event.entityType === 'support_department') {
    const department = await prisma.department.findFirst({
      where: {
        ...departmentWhereForAccess(access),
        id: event.entityId
      }
    });
    if (department && department.active && event.operation !== 'remove') {
      return {
        type: 'upsert' as const,
        entityType: 'support_department' as const,
        entityId: department.id,
        entity: serializeDepartment(department)
      };
    }
    // A Department id is safe only if it was explicitly audience-routed. Membership/role changes
    // use an epoch reset instead, so an inaccessible peer Department produces no tombstone.
    return null;
  }
  return null;
}

async function pushSupportSync(actor: RequestActor, input: SupportSyncPushInput) {
  let access = await resolveSupportAccess(actor);
  assertSupportAccessEpoch(input.accessEpoch, access.epoch);
  const internalClientId = `${actor.user.id}:${input.clientId}`;
  const results: Array<Record<string, unknown>> = [];

  for (const mutation of input.mutations) {
    access = await resolveSupportAccess(actor);
    assertSupportAccessEpoch(input.accessEpoch, access.epoch);
    const identity = {
      workspaceId_clientId_mutationId: {
        workspaceId: actor.workspace.id,
        clientId: internalClientId,
        mutationId: mutation.mutationId
      }
    } as const;
    let existing = await prisma.clientMutation.findUnique({ where: identity });
    if (existing?.status === 'APPLIED') {
      results.push({ mutationId: mutation.mutationId, status: 'duplicate' });
      continue;
    }
    if (existing?.status === 'REJECTED') {
      results.push({
        mutationId: mutation.mutationId,
        status: existing.errorCode === 'SUPPORT_MUTATION_CONFLICT' ? 'conflict' : 'rejected',
        error: {
          code: existing.errorCode ?? 'SUPPORT_MUTATION_REJECTED',
          message: existing.errorMessage ?? 'Support mutation was rejected',
          retryable: false
        }
      });
      continue;
    }
    if (existing?.status === 'PENDING' && Date.now() - existing.updatedAt.getTime() > 2 * 60_000) {
      await prisma.clientMutation.deleteMany({
        where: { id: existing.id, status: 'PENDING', updatedAt: existing.updatedAt }
      });
      existing = await prisma.clientMutation.findUnique({ where: identity });
    }
    if (existing) {
      results.push({
        mutationId: mutation.mutationId,
        status: 'rejected',
        error: {
          code: 'SUPPORT_MUTATION_PENDING',
          message: 'Support mutation is already pending',
          retryable: true
        }
      });
      continue;
    }

    const meta: SyncMutationMeta = {
      clientId: internalClientId,
      mutationId: mutation.mutationId,
      mutationName: mutation.name,
      userId: actor.user.id
    };
    const pending = await ensurePendingClientMutation({ ...meta, workspaceId: actor.workspace.id });
    if (pending === 'existing') {
      results.push({
        mutationId: mutation.mutationId,
        status: 'rejected',
        error: {
          code: 'SUPPORT_MUTATION_PENDING',
          message: 'Support mutation is already pending',
          retryable: true
        }
      });
      continue;
    }

    try {
      const entity = await applySupportSyncMutation(actor, mutation, meta);
      const after = await resolveSupportAccess(actor);
      if (after.epoch !== access.epoch) throw supportScopeChanged(after.epoch);
      results.push({ mutationId: mutation.mutationId, status: 'applied', entity });
    } catch (error) {
      if (isSupportScopeChanged(error)) throw error;
      const authoritative = await prisma.clientMutation.findUnique({ where: identity });
      // The Case transaction may have committed and atomically marked the mutation APPLIED before
      // a response-only serialization failure. Never overwrite that durable success as rejected.
      if (authoritative?.status === 'APPLIED') {
        results.push({ mutationId: mutation.mutationId, status: 'applied' });
        continue;
      }
      const conflict = error instanceof HttpError && error.statusCode === 409;
      const message = supportMutationErrorMessage(error);
      await markClientMutationRejected(
        actor.workspace.id,
        internalClientId,
        mutation.mutationId,
        conflict ? 'SUPPORT_MUTATION_CONFLICT' : 'SUPPORT_MUTATION_REJECTED',
        message
      );
      results.push({
        mutationId: mutation.mutationId,
        status: conflict ? 'conflict' : 'rejected',
        error: {
          code: conflict ? 'SUPPORT_MUTATION_CONFLICT' : 'SUPPORT_MUTATION_REJECTED',
          message,
          retryable: false
        }
      });
    }
  }

  const currentAccess = await resolveSupportAccess(actor);
  assertSupportAccessEpoch(input.accessEpoch, currentAccess.epoch);
  return {
    accessEpoch: currentAccess.epoch.toString(),
    cursor: await latestSupportCursor({
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      accessEpoch: currentAccess.epoch
    }),
    results
  };
}

/** One registry-shaped dispatcher is the extension seam for a future `case.link.create` handler. */
async function applySupportSyncMutation(
  actor: RequestActor,
  mutation: SupportSyncPushMutation,
  meta: SyncMutationMeta
) {
  const args = supportSyncCaseMutationArgsSchema.parse(mutation.args);
  if (mutation.name === 'case.route') {
    const result = await routeSupportCase(actor, args.idOrKey, routeSupportCaseSchema.parse(args.input), meta);
    return serializeSupportCase(result.supportCase, result.access);
  }
  if (mutation.name === 'case.wait' || mutation.name === 'case.nextAction') {
    const result = await waitOnSupportCase(actor, args.idOrKey, waitOnSupportCaseSchema.parse(args.input), meta);
    return serializeSupportCase(result.supportCase, result.access);
  }
  if (mutation.name === 'case.interaction') {
    const result = await addSupportInteraction(actor, args.idOrKey, addSupportInteractionSchema.parse(args.input), meta);
    return serializeSupportCase(result.supportCase, result.access);
  }
  if (mutation.name === 'case.resolve') {
    const result = await resolveSupportCase(actor, args.idOrKey, resolveSupportCaseSchema.parse(args.input), meta);
    return serializeSupportCase(result.supportCase, result.access);
  }
  if (mutation.name === 'case.close') {
    const result = await closeSupportCase(actor, args.idOrKey, closeSupportCaseSchema.parse(args.input), meta);
    return serializeSupportCase(result.supportCase, result.access);
  }
  const result = await reopenSupportCase(actor, args.idOrKey, reopenSupportCaseSchema.parse(args.input), meta);
  return serializeSupportCase(result.supportCase, result.access);
}

function openSupportSyncStream(
  request: FastifyRequest,
  reply: FastifyReply,
  actor: RequestActor,
  access: SupportAccess,
  workspaceSeq: bigint,
  clientId?: string
): void {
  const corsOrigin = resolveCorsOrigin(request.headers.origin);
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(corsOrigin
      ? {
          'access-control-allow-origin': corsOrigin,
          'access-control-allow-credentials': 'true',
          vary: 'Origin'
        }
      : {})
  });

  const streamId = [actor.workspace.id, actor.user.id, clientId ?? 'anonymous', crypto.randomUUID()].join(':');
  const cleanup = supportSyncHub.add({
    id: streamId,
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    accessEpoch: access.epoch,
    workspaceSeq,
    resolveAccess: () => resolveCurrentSupportStreamAccess(actor, access),
    send: (wakeup) => writeSupportSyncSse(reply, wakeup)
  });
  startSupportSyncWakeupPoller();
  const heartbeat = setInterval(() => { reply.raw.write(': keepalive\n\n'); }, 25_000);
  heartbeat.unref?.();
  const close = () => {
    clearInterval(heartbeat);
    cleanup();
  };
  request.raw.on('close', close);
  writeSupportSyncSse(reply, { type: 'sync', accessEpoch: access.epoch.toString() }, 'ready');
}

async function resolveCurrentSupportStreamAccess(
  actor: RequestActor,
  connectedAccess: SupportAccess
): Promise<SupportAccess> {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: actor.workspace.id,
        userId: actor.user.id
      }
    },
    select: { role: true }
  });
  if (!membership) {
    return {
      ...connectedAccess,
      workspaceWide: false,
      triager: false,
      supervisor: false,
      managedDepartmentIds: [],
      memberMembershipIds: [],
      credentialScopes: [],
      canWriteCases: false,
      canConfigure: false,
      canIntake: false,
      epoch: connectedAccess.epoch + 1n
    };
  }
  return resolveSupportAccess({ ...actor, role: membership.role });
}

function writeSupportSyncSse(
  reply: FastifyReply,
  wakeup: SupportSyncWakeup,
  event: string = wakeup.type
): void {
  // Deliberately no SSE id: a global sequence or entity-derived id leaks peer event volume.
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(wakeup)}\n\n`);
}

function isSupportScopeChanged(error: unknown): boolean {
  return error instanceof HttpError && error.details?.code === 'SUPPORT_SCOPE_CHANGED';
}

function supportMutationErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ').slice(0, 1_000);
  }
  return (error instanceof Error ? error.message : 'Support mutation failed').replace(/[\r\n]+/g, ' ').slice(0, 1_000);
}

async function listSupportCases(actor: RequestActor, query: SupportCaseListQuery) {
  const access = await resolveSupportAccess(actor);
  const now = new Date();
  const filter = await supportCaseQueryWhere(query, access, now);
  const where: Prisma.SupportCaseWhereInput = {
    AND: [supportCaseWhereForAccess(access), filter]
  };
  const cursor = decodeSupportCaseCursor(query.cursor);
  const pageWhere: Prisma.SupportCaseWhereInput = cursor
    ? {
        AND: [
          where,
          {
            OR: [
              { receivedAt: { lt: cursor.receivedAt } },
              { receivedAt: cursor.receivedAt, id: { lt: cursor.id } }
            ]
          }
        ]
      }
    : where;

  const [rows, total, counts] = await Promise.all([
    prisma.supportCase.findMany({
      where: pageWhere,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: supportCaseInclude
    }),
    prisma.supportCase.count({ where }),
    supportQueueCounts(access, now)
  ]);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);
  const projectedReasons = await supportAttentionReasonsByCaseIds(
    actor.workspace.id,
    page.map((supportCase) => supportCase.id),
    now
  );
  return {
    items: page.map((supportCase) => serializeSupportCase(
      supportCase,
      access,
      now,
      projectedReasons.get(supportCase.id)
    )),
    nextCursor: hasMore && last ? encodeSupportCaseCursor(last) : null,
    total,
    counts,
    accessEpoch: access.epoch.toString()
  };
}

async function supportCaseQueryWhere(
  query: SupportCaseListQuery,
  access: SupportAccess,
  now: Date
): Promise<Prisma.SupportCaseWhereInput> {
  const conditions: Prisma.SupportCaseWhereInput[] = [];
  if (query.status) conditions.push({ status: { in: asArray(query.status) } });
  if (query.departmentId) conditions.push({ departmentId: query.departmentId });
  if (query.assigneeMembershipId) conditions.push({ assigneeMembershipId: query.assigneeMembershipId });
  if (query.priority) conditions.push({ priority: { in: asArray(query.priority) } });
  if (query.sourceChannel) conditions.push({ sourceChannel: { in: asArray(query.sourceChannel) } });
  if (query.typeKey) conditions.push({ typeKey: query.typeKey });
  if (query.receivedFrom || query.receivedTo) {
    conditions.push({
      receivedAt: {
        ...(query.receivedFrom ? { gte: new Date(query.receivedFrom) } : {}),
        ...(query.receivedTo ? { lte: new Date(query.receivedTo) } : {})
      }
    });
  }
  if (query.q) {
    conditions.push({
      OR: [
        { key: { contains: query.q, mode: 'insensitive' } },
        { title: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
        { contact: { is: { name: { contains: query.q, mode: 'insensitive' } } } },
        { contact: { is: { email: { contains: query.q, mode: 'insensitive' } } } },
        { contact: { is: { phone: { contains: query.q } } } }
      ]
    });
  }
  if (query.attentionReason) {
    const visibleCaseIds = await prisma.supportCase.findMany({
      where: supportCaseWhereForAccess(access),
      select: { id: true }
    });
    const projected = await supportAttentionReasonsByCaseIds(
      access.workspaceId,
      visibleCaseIds.map((item) => item.id),
      now
    );
    const projectedIds = visibleCaseIds
      .map((item) => item.id)
      .filter((id) => projected.get(id)?.includes(query.attentionReason!));
    conditions.push({
      OR: [
        supportAttentionWhere(query.attentionReason, now),
        { id: { in: projectedIds } }
      ]
    });
  }
  if (query.queue) {
    const projectedAttentionWhere = query.queue === 'NEEDS_ATTENTION'
      ? await supportAttentionCaseWhere(access.workspaceId, now)
      : undefined;
    conditions.push(supportQueueWhere(query.queue, access, now, projectedAttentionWhere));
  }
  return conditions.length ? { AND: conditions } : {};
}

async function supportSyncBootstrap(actor: RequestActor, preResolvedAccess?: SupportAccess) {
  const access = preResolvedAccess ?? await resolveSupportAccess(actor);
  const now = new Date();
  // Capture the cursor first. A concurrent mutation may then be included both in the bootstrap and
  // in the next pull, which is an idempotent upsert; capturing it after the rows could miss it.
  const cursor = await latestSupportCursor({
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    accessEpoch: access.epoch
  });
  const [cases, departments, counts] = await Promise.all([
    prisma.supportCase.findMany({
      where: {
        AND: [
          supportCaseWhereForAccess(access),
          { status: { not: 'CLOSED' } }
        ]
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: supportCaseInclude
    }),
    prisma.department.findMany({
      where: { ...departmentWhereForAccess(access), active: true },
      orderBy: { name: 'asc' }
    }),
    supportQueueCounts(access, now)
  ]);
  const projectedReasons = await supportAttentionReasonsByCaseIds(
    actor.workspace.id,
    cases.map((supportCase) => supportCase.id),
    now
  );
  const currentAccess = await resolveSupportAccess(actor);
  if (currentAccess.epoch !== access.epoch) throw supportScopeChanged(currentAccess.epoch);
  return {
    cases: cases.map((supportCase) => serializeSupportCase(
      supportCase,
      access,
      now,
      projectedReasons.get(supportCase.id)
    )),
    departments: departments.map((department) => serializeDepartment(department)),
    counts,
    access: serializeSupportAccess(access),
    support: supportOperationalCapabilities(),
    accessEpoch: access.epoch.toString(),
    cursor
  };
}

function serializeSupportAccess(access: SupportAccess) {
  return {
    workspaceWide: access.workspaceWide,
    triager: access.triager,
    supervisor: access.supervisor,
    managedDepartmentIds: access.managedDepartmentIds,
    memberMembershipIds: access.memberMembershipIds,
    credentialScopes: access.credentialScopes
  };
}

function supportOperationalCapabilities() {
  const interactionContentAvailable = supportDataEncryptionAvailable();
  return {
    interactionContentAvailable,
    manualCallAvailable: interactionContentAvailable
  };
}

function normalizeSupportListQuery(input: unknown): Record<string, unknown> {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    ...raw,
    status: normalizeArrayQuery(raw.status),
    priority: normalizeArrayQuery(raw.priority),
    sourceChannel: normalizeArrayQuery(raw.sourceChannel)
  };
}

function normalizeArrayQuery(value: unknown): unknown {
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return value;
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function encodeSupportCaseCursor(input: { receivedAt: Date; id: string }): string {
  return encodeOpaque({ receivedAt: input.receivedAt.toISOString(), id: input.id });
}

function decodeSupportCaseCursor(cursor?: string): { receivedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      receivedAt?: unknown;
      id?: unknown;
    };
    const receivedAt = new Date(typeof value.receivedAt === 'string' ? value.receivedAt : '');
    if (Number.isNaN(receivedAt.getTime()) || typeof value.id !== 'string' || !value.id) throw new Error();
    return { receivedAt, id: value.id };
  } catch {
    throw new HttpError(400, 'Invalid Support Case cursor');
  }
}

function encodeOpaque(input: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
}
