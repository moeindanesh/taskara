import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config';
import { mintAgentCredentialToken } from '../services/agent-credential';
import { errorMessage, HttpError, statusCodeFromError } from '../services/http';
import type { SupportAccess } from '../services/support-access';
import {
  appendSupportCaseSyncEvent,
  pollSupportSyncWakeups,
  SupportSyncHub
} from '../services/support-sync';
import { registerNotificationRoutes } from './notifications';
import { registerSupportRoutes } from './support';
import { registerSystemRoutes } from './system';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];
const EMAIL_DOMAIN = 'support-routes.test';
const originalSupportDataSecret = config.TASKARA_SUPPORT_DATA_SECRET;

describe('Support privacy perimeter', () => {
  beforeAll(async () => {
    if (!config.TASKARA_SUPPORT_DATA_SECRET) {
      config.TASKARA_SUPPORT_DATA_SECRET = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    }
    app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.code(400).send({ message: 'Validation failed', issues: error.issues });
      }
      const message = errorMessage(error);
      return reply.code(statusCodeFromError(error, message)).send({
        message,
        ...(error instanceof HttpError ? error.details : undefined)
      });
    });
    await app.register(registerSupportRoutes);
    await app.register(registerNotificationRoutes);
    await app.register(registerSystemRoutes);
    await app.ready();
  });

  afterEach(async () => {
    const strandedMemberships = await prisma.workspaceMember.findMany({
      where: { user: { email: { endsWith: `@${EMAIL_DOMAIN}` } } },
      select: { workspaceId: true }
    });
    const workspaceIds = [...new Set([
      ...cleanupWorkspaceIds.splice(0),
      ...strandedMemberships.map((membership) => membership.workspaceId)
    ])];
    if (workspaceIds.length) {
      // Remove notification projections, then delete the Case aggregate so append-only timeline
      // rows leave only through their allowed aggregate cascade; direct ledger deletes stay forbidden.
      await prisma.notification.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.supportCase.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
    config.TASKARA_SUPPORT_DATA_SECRET = originalSupportDataSecret;
  });

  test('an ordinary Department member cannot infer a peer Case through list, detail, search, counts, or bootstrap', async () => {
    const fixture = await createPrivacyFixture();
    const ownHeaders = headers(fixture.workspace.slug, fixture.memberA.email);

    const [list, peerDetail, search, counts, bootstrap] = await Promise.all([
      app.inject({ method: 'GET', url: '/support/cases', headers: ownHeaders }),
      app.inject({ method: 'GET', url: `/support/cases/${fixture.peerCase.key}`, headers: ownHeaders }),
      app.inject({ method: 'GET', url: `/support/search?q=${encodeURIComponent(fixture.peerCase.title)}`, headers: ownHeaders }),
      app.inject({ method: 'GET', url: '/support/counts', headers: ownHeaders }),
      app.inject({ method: 'GET', url: '/support/sync/bootstrap', headers: ownHeaders })
    ]);

    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([fixture.ownCase.id]);
    expect(peerDetail.statusCode).toBe(404);
    expect(search.statusCode).toBe(200);
    expect(search.json().cases).toEqual([]);
    expect(counts.statusCode).toBe(200);
    expect(counts.json().counts).toEqual({ MY_CASES: 1, NEEDS_ATTENTION: 1 });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().cases.map((item: { id: string }) => item.id)).toEqual([fixture.ownCase.id]);
    expect(bootstrap.json().departments).toHaveLength(1);
    expect(JSON.stringify([list.json(), search.json(), counts.json(), bootstrap.json()])).not.toContain(
      fixture.peerCase.title
    );
  });

  test('opaque pull cursors advance past a peer event without leaking it or leaving a gap', async () => {
    const fixture = await createPrivacyFixture();
    const bootstrap = await bootstrapFor(fixture, fixture.memberA.email);
    expect(bootstrap.cursor).toMatch(/^ssc1\./);
    expect(bootstrap.cursor).not.toMatch(/^\d+$/);

    await prisma.$transaction((tx) => appendSupportCaseSyncEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.peerCase.id,
      caseVersion: fixture.peerCase.version,
      operation: 'upsert',
      actorId: fixture.memberB.id
    }));
    const peerOnly = await inject(fixture, fixture.memberA.email, {
      method: 'GET',
      url: `/support/sync/pull?accessEpoch=${bootstrap.accessEpoch}&cursor=${encodeURIComponent(bootstrap.cursor)}`
    });
    expect(peerOnly.statusCode).toBe(200);
    expect(peerOnly.json().events).toEqual([]);
    expect(peerOnly.json().cursor).toMatch(/^ssc1\./);
    expect(JSON.stringify(peerOnly.json())).not.toContain(fixture.peerCase.title);

    await prisma.$transaction((tx) => appendSupportCaseSyncEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.ownCase.id,
      caseVersion: fixture.ownCase.version,
      operation: 'upsert',
      actorId: fixture.memberA.id
    }));
    const own = await inject(fixture, fixture.memberA.email, {
      method: 'GET',
      url: `/support/sync/pull?accessEpoch=${bootstrap.accessEpoch}&cursor=${encodeURIComponent(peerOnly.json().cursor)}`
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().events).toHaveLength(1);
    expect(own.json().events[0]).toMatchObject({
      type: 'upsert',
      entityType: 'support_case',
      entityId: fixture.ownCase.id,
      entity: { id: fixture.ownCase.id, title: fixture.ownCase.title }
    });

    const wrongAudience = await inject(fixture, fixture.memberB.email, {
      method: 'GET',
      url: `/support/sync/pull?accessEpoch=1&cursor=${encodeURIComponent(own.json().cursor)}`
    });
    expect(wrongAudience.statusCode).toBe(409);
    expect(wrongAudience.json()).toMatchObject({ code: 'SUPPORT_CURSOR_RESET_REQUIRED', accessEpoch: '1' });
    expect(JSON.stringify(wrongAudience.json())).not.toContain(fixture.ownCase.title);
  });

  test('ownership sync gives the former reader only a removal and the new reader a full upsert', async () => {
    const fixture = await createPrivacyFixture();
    const [formerBootstrap, newBootstrap] = await Promise.all([
      bootstrapFor(fixture, fixture.memberA.email),
      bootstrapFor(fixture, fixture.memberB.email)
    ]);
    await prisma.$transaction(async (tx) => {
      const updated = await tx.supportCase.update({
        where: { id: fixture.ownCase.id },
        data: {
          assigneeMembershipId: fixture.memberBMembership.id,
          version: { increment: 1 }
        }
      });
      await appendSupportCaseSyncEvent(tx, {
        workspaceId: fixture.workspace.id,
        caseId: updated.id,
        caseVersion: updated.version,
        operation: 'route',
        actorId: fixture.manager.id,
        removedUserIds: [fixture.memberA.id]
      });
    });

    const [former, next] = await Promise.all([
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: `/support/sync/pull?accessEpoch=1&cursor=${encodeURIComponent(formerBootstrap.cursor)}`
      }),
      inject(fixture, fixture.memberB.email, {
        method: 'GET',
        url: `/support/sync/pull?accessEpoch=1&cursor=${encodeURIComponent(newBootstrap.cursor)}`
      })
    ]);
    expect(former.statusCode).toBe(200);
    expect(former.json().events).toEqual([{
      type: 'removeFromScope',
      entityType: 'support_case',
      entityId: fixture.ownCase.id
    }]);
    expect(JSON.stringify(former.json())).not.toContain(fixture.ownCase.title);
    expect(next.statusCode).toBe(200);
    expect(next.json().events).toHaveLength(1);
    expect(next.json().events[0]).toMatchObject({
      type: 'upsert',
      entityType: 'support_case',
      entityId: fixture.ownCase.id,
      entity: { title: fixture.ownCase.title, assigneeMembershipId: fixture.memberBMembership.id }
    });
  });

  test('routing out of Triage resets the former triager scope before cached Case data can render', async () => {
    const fixture = await createPrivacyFixture();
    const bootstrap = await bootstrapFor(fixture, fixture.triager.email);
    expect(bootstrap.cases.map((item: { id: string }) => item.id)).toContain(fixture.triageCase.id);

    const routed = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/route`,
      payload: { targetDepartmentId: fixture.department.id, baseVersion: fixture.triageCase.version }
    });
    expect(routed.statusCode).toBe(200);

    const stalePull = await inject(fixture, fixture.triager.email, {
      method: 'GET',
      url: `/support/sync/pull?accessEpoch=${bootstrap.accessEpoch}&cursor=${encodeURIComponent(bootstrap.cursor)}`
    });
    expect(stalePull.statusCode).toBe(409);
    expect(stalePull.json()).toMatchObject({ code: 'SUPPORT_SCOPE_CHANGED', accessEpoch: '2' });
    expect(JSON.stringify(stalePull.json())).not.toContain(fixture.triageCase.title);

    const fresh = await bootstrapFor(fixture, fixture.triager.email);
    expect(fresh.accessEpoch).toBe('2');
    expect(fresh.cases.map((item: { id: string }) => item.id)).not.toContain(fixture.triageCase.id);
    const event = await prisma.syncEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        entityType: 'support_case',
        entityId: fixture.triageCase.id,
        operation: 'route'
      },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect(event.payload).toMatchObject({ removedUserIds: [fixture.triager.id] });
  });

  test('Support stream polling wakes only a visible audience and emits one scope reset on epoch change', async () => {
    const fixture = await createPrivacyFixture();
    const hub = new SupportSyncHub();
    const memberAWakeups: Array<{ type: string; accessEpoch: string }> = [];
    const memberBWakeups: Array<{ type: string; accessEpoch: string }> = [];
    let memberAEpoch = 1n;
    const memberAAccess = () => supportMemberAccess(fixture, 'A', memberAEpoch);
    const memberBAccess = () => supportMemberAccess(fixture, 'B', 1n);
    hub.add({
      id: 'stream-member-a',
      workspaceId: fixture.workspace.id,
      userId: fixture.memberA.id,
      accessEpoch: 1n,
      workspaceSeq: 0n,
      resolveAccess: async () => memberAAccess(),
      send: (wakeup) => memberAWakeups.push(wakeup)
    });
    hub.add({
      id: 'stream-member-b',
      workspaceId: fixture.workspace.id,
      userId: fixture.memberB.id,
      accessEpoch: 1n,
      workspaceSeq: 0n,
      resolveAccess: async () => memberBAccess(),
      send: (wakeup) => memberBWakeups.push(wakeup)
    });

    await prisma.$transaction((tx) => appendSupportCaseSyncEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.peerCase.id,
      caseVersion: fixture.peerCase.version,
      operation: 'upsert'
    }));
    await pollSupportSyncWakeups(hub);
    expect(memberAWakeups).toEqual([]);
    expect(memberBWakeups).toEqual([{ type: 'sync', accessEpoch: '1' }]);

    await prisma.$transaction((tx) => appendSupportCaseSyncEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: fixture.ownCase.id,
      caseVersion: fixture.ownCase.version,
      operation: 'upsert'
    }));
    await pollSupportSyncWakeups(hub);
    expect(memberAWakeups).toEqual([{ type: 'sync', accessEpoch: '1' }]);
    expect(memberBWakeups).toHaveLength(1);

    const closedOwnCase = await prisma.supportCase.update({
      where: { id: fixture.ownCase.id },
      data: {
        status: 'CLOSED',
        resolutionCode: 'FIXED',
        resolutionSummary: 'Verified for close-wakeup coverage.',
        resolvedAt: new Date(),
        closedAt: new Date(),
        version: { increment: 1 }
      }
    });
    await prisma.$transaction((tx) => appendSupportCaseSyncEvent(tx, {
      workspaceId: fixture.workspace.id,
      caseId: closedOwnCase.id,
      caseVersion: closedOwnCase.version,
      operation: 'remove'
    }));
    await pollSupportSyncWakeups(hub);
    expect(memberAWakeups).toEqual([
      { type: 'sync', accessEpoch: '1' },
      { type: 'sync', accessEpoch: '1' }
    ]);
    expect(memberBWakeups).toHaveLength(1);

    memberAEpoch = 2n;
    await pollSupportSyncWakeups(hub);
    await pollSupportSyncWakeups(hub);
    expect(memberAWakeups).toEqual([
      { type: 'sync', accessEpoch: '1' },
      { type: 'sync', accessEpoch: '1' },
      { type: 'scopeReset', accessEpoch: '2' }
    ]);
  });

  test('epoch-bound Support push is crash-atomic, idempotent, and rejects stale replay without payload', async () => {
    const fixture = await createPrivacyFixture();
    const bootstrap = await bootstrapFor(fixture, fixture.manager.email);
    const nextActionAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const body = {
      accessEpoch: bootstrap.accessEpoch,
      clientId: 'support-push-idempotency',
      mutations: [{
        mutationId: 'wait-once',
        name: 'case.wait',
        args: {
          idOrKey: fixture.departmentInboxCase.key,
          input: {
            status: 'WAITING_ON_INTERNAL',
            waitingReason: 'Awaiting an internal dependency',
            nextActionAt,
            baseVersion: 1
          }
        }
      }]
    };
    const first = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: '/support/sync/push',
      payload: body
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().results).toHaveLength(1);
    expect(first.json().results[0]).toMatchObject({
      mutationId: 'wait-once',
      status: 'applied',
      entity: { id: fixture.departmentInboxCase.id, version: 2, status: 'WAITING_ON_INTERNAL' }
    });
    expect(first.json().cursor).toMatch(/^ssc1\./);

    const replay = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: '/support/sync/push',
      payload: body
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().results).toEqual([{ mutationId: 'wait-once', status: 'duplicate' }]);
    expect((await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.departmentInboxCase.id } })).version)
      .toBe(2);
    expect(await prisma.supportCaseEvent.count({
      where: { caseId: fixture.departmentInboxCase.id, action: 'case.waiting_on_internal' }
    })).toBe(1);
    expect(await prisma.clientMutation.findUniqueOrThrow({
      where: {
        workspaceId_clientId_mutationId: {
          workspaceId: fixture.workspace.id,
          clientId: `${fixture.manager.id}:support-push-idempotency`,
          mutationId: 'wait-once'
        }
      }
    })).toMatchObject({ status: 'APPLIED', name: 'case.wait' });

    await prisma.supportAccessEpoch.create({
      data: { workspaceId: fixture.workspace.id, userId: fixture.manager.id, epoch: 2n }
    });
    const staleReplay = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: '/support/sync/push',
      payload: body
    });
    expect(staleReplay.statusCode).toBe(409);
    const staleBody = staleReplay.json() as { message: string; code: string; accessEpoch: string };
    expect(staleBody).toEqual({
      message: 'Support access scope changed',
      code: 'SUPPORT_SCOPE_CHANGED',
      accessEpoch: '2'
    });
    expect(JSON.stringify(staleReplay.json())).not.toContain(fixture.departmentInboxCase.title);
    expect((await prisma.supportCase.findUniqueOrThrow({ where: { id: fixture.departmentInboxCase.id } })).version)
      .toBe(2);
  });

  test('Case visibility follows the supervisor, triager, manager, assignee, guest, and no-access matrix', async () => {
    const fixture = await createPrivacyFixture();
    const visibleKeys = async (email: string) => {
      const response = await inject(fixture, email, { method: 'GET', url: '/support/cases?limit=100' });
      expect(response.statusCode).toBe(200);
      return response.json().items.map((item: { key: string }) => item.key).sort();
    };

    expect(await visibleKeys(fixture.owner.email)).toEqual([
      fixture.departmentInboxCase.key,
      fixture.guestCase.key,
      fixture.otherDepartmentCase.key,
      fixture.ownCase.key,
      fixture.peerCase.key,
      fixture.triageCase.key
    ].sort());
    expect(await visibleKeys(fixture.manager.email)).toEqual([
      fixture.departmentInboxCase.key,
      fixture.guestCase.key,
      fixture.ownCase.key,
      fixture.peerCase.key
    ].sort());
    expect(await visibleKeys(fixture.triager.email)).toEqual([fixture.triageCase.key]);
    expect(await visibleKeys(fixture.memberA.email)).toEqual([fixture.ownCase.key]);
    expect(await visibleKeys(fixture.guest.email)).toEqual([]);
    expect(await visibleKeys(fixture.noAccess.email)).toEqual([]);
  });

  test('future Case snoozes suppress attention only until they expire', async () => {
    const fixture = await createPrivacyFixture();
    await prisma.supportCase.update({
      where: { id: fixture.ownCase.id },
      data: { snoozedUntil: new Date(Date.now() + 60 * 60 * 1_000) }
    });

    const [attentionWhileSnoozed, myCases, detailWhileSnoozed] = await Promise.all([
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: '/support/cases?queue=NEEDS_ATTENTION'
      }),
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: '/support/cases?queue=MY_CASES'
      }),
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: `/support/cases/${fixture.ownCase.key}`
      })
    ]);
    expect(attentionWhileSnoozed.statusCode).toBe(200);
    expect(attentionWhileSnoozed.json().items).toEqual([]);
    expect(myCases.statusCode).toBe(200);
    expect(myCases.json().items.map((item: { id: string }) => item.id)).toEqual([fixture.ownCase.id]);
    expect(detailWhileSnoozed.statusCode).toBe(200);
    expect(detailWhileSnoozed.json().attentionReasons).toEqual([]);

    await prisma.supportCase.update({
      where: { id: fixture.ownCase.id },
      data: { snoozedUntil: new Date(Date.now() - 60 * 60 * 1_000) }
    });
    const [attentionAfterExpiry, detailAfterExpiry] = await Promise.all([
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: '/support/cases?queue=NEEDS_ATTENTION'
      }),
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: `/support/cases/${fixture.ownCase.key}`
      })
    ]);
    expect(attentionAfterExpiry.statusCode).toBe(200);
    expect(attentionAfterExpiry.json().items.map((item: { id: string }) => item.id))
      .toEqual([fixture.ownCase.id]);
    expect(detailAfterExpiry.statusCode).toBe(200);
    expect(detailAfterExpiry.json().attentionReasons).toContain('NO_NEXT_ACTION');
  });

  test('the database keeps call direction mandatory and external', async () => {
    const [column] = await prisma.$queryRaw<Array<{ isNullable: string }>>`
      SELECT column_name AS "columnName", is_nullable AS "isNullable"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'SupportCallDetail'
        AND column_name = 'direction'
    `;
    const [constraint] = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"SupportCallDetail"'::regclass
        AND conname = 'SupportCallDetail_external_direction'
    `;

    expect(column?.isNullable).toBe('NO');
    expect(constraint?.definition).toContain("'INBOUND'");
    expect(constraint?.definition).toContain("'OUTBOUND'");
  });

  test('manual Case idempotency replays an identical request and rejects a changed payload', async () => {
    const fixture = await createPrivacyFixture();
    const idempotencyKey = `manual-case-${crypto.randomUUID()}`;
    const payload = {
      title: 'One request, one Case',
      description: 'The original intake facts.',
      sourceChannel: 'MANUAL',
      typeKey: 'request',
      priority: 'NORMAL',
      idempotencyKey
    };

    const first = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/cases',
      payload
    });
    const replay = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/cases',
      payload
    });
    const mismatch = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/cases',
      payload: { ...payload, description: 'A changed intake payload.' }
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.json().id, key: first.json().key, replayed: true });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: 'SUPPORT_IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(await prisma.supportCase.count({
      where: { workspaceId: fixture.workspace.id, key: first.json().key }
    })).toBe(1);
    expect(await prisma.activityLog.count({
      where: {
        workspaceId: fixture.workspace.id,
        action: 'support_idempotency_payload_mismatch'
      }
    })).toBe(1);
  });

  test('manual call intake atomically creates a Case, encrypted timeline, call facts, callback, and audit events', async () => {
    const fixture = await createPrivacyFixture();
    const startedAt = new Date();
    const endedAt = new Date(startedAt.getTime() + 90_000);
    const callbackDueAt = new Date(startedAt.getTime() + 3_600_000);
    const summary = `Customer call summary ${crypto.randomUUID()}`;
    const internalNotes = `Private call note ${crypto.randomUUID()}`;

    const response = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload: {
        newCase: {
          title: 'Caller cannot sign in',
          sourceChannel: 'CALL',
          typeKey: 'incident',
          priority: 'HIGH',
          idempotencyKey: `call-${crypto.randomUUID()}`
        },
        contact: { name: 'Caller', phone: '+41791234567' },
        summary,
        internalNotes,
        call: {
          direction: 'INBOUND',
          disposition: 'ANSWERED',
          startedAt: startedAt.toISOString(),
          answeredAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationSeconds: 90,
          recordingConsent: 'GIVEN',
          recordingExists: false,
          callbackOwnerId: fixture.triager.id,
          callbackDueAt: callbackDueAt.toISOString(),
          externalCallId: `external-call-${crypto.randomUUID()}`
        }
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.case.key).toBe('SPRIV-7');
    expect(body.case.status).toBe('NEW');
    expect(body.case.nextActionAt).toBe(callbackDueAt.toISOString());
    expect(body.interaction.direction).toBe('INBOUND');
    expect(body.interaction.call.direction).toBe('INBOUND');
    expect(body.interaction.call.disposition).toBe('ANSWERED');
    expect(body.createdNewCase).toBe(true);

    const storedContent = await prisma.supportInteractionContent.findMany({
      where: { interaction: { caseId: body.case.id } },
      orderBy: { createdAt: 'asc' }
    });
    expect(storedContent).toHaveLength(2);
    expect(storedContent.every((item) => item.bodyCiphertext && item.encryptionKeyId)).toBe(true);
    expect(Buffer.concat(storedContent.map((item) => Buffer.from(item.bodyCiphertext || []))).toString('utf8'))
      .not.toContain(summary);
    expect(Buffer.concat(storedContent.map((item) => Buffer.from(item.bodyCiphertext || []))).toString('utf8'))
      .not.toContain(internalNotes);

    const timeline = await inject(fixture, fixture.triager.email, {
      method: 'GET',
      url: `/support/cases/${body.case.key}/interactions`
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().items.map((item: { content: { body: string } }) => item.content.body)).toEqual([
      summary,
      internalNotes
    ]);
    const events = await inject(fixture, fixture.triager.email, {
      method: 'GET',
      url: `/support/cases/${body.case.key}/events`
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().items.map((event: { action: string }) => event.action)).toEqual([
      'case.created',
      'case.call_recorded'
    ]);
  });

  test('new-Case call retries reuse the idempotency result without consuming another key or interaction', async () => {
    const fixture = await createPrivacyFixture();
    const idempotencyKey = `manual-call-${crypto.randomUUID()}`;
    const payload = {
      newCase: {
        title: 'One call, one Case',
        sourceChannel: 'CALL',
        typeKey: 'incident',
        idempotencyKey
      },
      summary: 'Customer reports one incident.',
      call: {
        direction: 'INBOUND',
        disposition: 'ANSWERED',
        startedAt: new Date().toISOString(),
        recordingConsent: 'UNKNOWN',
        recordingExists: false
      }
    };

    const first = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload
    });
    const replay = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload
    });
    const mismatch = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload: { ...payload, summary: 'A different call under the same idempotency key.' }
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().case.id).toBe(first.json().case.id);
    expect(replay.json().interaction.id).toBe(first.json().interaction.id);
    expect(replay.json().createdNewCase).toBe(true);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: 'SUPPORT_IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(await prisma.supportCase.count({
      where: { workspaceId: fixture.workspace.id, key: first.json().case.key }
    })).toBe(1);
    expect(await prisma.supportInteraction.count({
      where: { workspaceId: fixture.workspace.id, caseId: first.json().case.id }
    })).toBe(1);
    expect(await prisma.supportCaseEvent.count({
      where: { workspaceId: fixture.workspace.id, idempotencyKey }
    })).toBe(2);
    expect((await prisma.supportWorkspaceState.findUniqueOrThrow({
      where: { workspaceId: fixture.workspace.id }
    })).nextCaseNumber).toBe(8);
  });

  test('existing-Case calls require a version, replay before stale rejection, and re-check current access', async () => {
    const fixture = await createPrivacyFixture();
    const externalCallId = `existing-call-${crypto.randomUUID()}`;
    const payload = {
      caseId: fixture.triageCase.id,
      baseVersion: 1,
      summary: 'We called the customer with an update.',
      call: {
        direction: 'OUTBOUND',
        disposition: 'ANSWERED',
        startedAt: new Date().toISOString(),
        recordingConsent: 'NOT_REQUIRED',
        recordingExists: false,
        externalCallId
      }
    };

    const missingVersion = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload: { ...payload, baseVersion: undefined }
    });
    expect(missingVersion.statusCode).toBe(400);

    const first = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().case).toMatchObject({ version: 2 });
    expect(first.json().case.firstResponseAt).not.toBeNull();
    expect(first.json().interaction).toMatchObject({ direction: 'OUTBOUND' });
    expect(first.json().interaction.call).toMatchObject({ direction: 'OUTBOUND', externalCallId });

    // The committed call moved the Case to version 2, but replaying its external identity is a
    // successful read of that result rather than a stale write at baseVersion 1.
    const replay = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().case.version).toBe(2);
    expect(replay.json().interaction.id).toBe(first.json().interaction.id);

    const changedReplay = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload: { ...payload, summary: 'A different call under the same external id.' }
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json()).toMatchObject({ code: 'SUPPORT_IDEMPOTENCY_PAYLOAD_MISMATCH' });

    const staleNewCall = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload: {
        ...payload,
        call: { ...payload.call, externalCallId: `${externalCallId}-different` }
      }
    });
    expect(staleNewCall.statusCode).toBe(409);
    expect(staleNewCall.json().code).toBe('SUPPORT_VERSION_CONFLICT');

    const route = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/route`,
      payload: { targetDepartmentId: fixture.department.id, baseVersion: 2 }
    });
    expect(route.statusCode).toBe(200);

    const replayAfterTransfer = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/calls',
      payload
    });
    expect(replayAfterTransfer.statusCode).toBe(404);
    expect(JSON.stringify(replayAfterTransfer.json())).not.toContain(fixture.triageCase.title);
  });

  test('a Case travels from Triage through Department ownership, private work, waiting, resolution, close, and reopen', async () => {
    const fixture = await createPrivacyFixture();
    const route = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/route`,
      payload: { targetDepartmentId: fixture.department.id, baseVersion: 1 }
    });
    expect(route.statusCode).toBe(200);
    expect(route.json()).toMatchObject({ status: 'OPEN', departmentId: fixture.department.id, version: 2 });

    const assign = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/route`,
      payload: {
        targetDepartmentId: fixture.department.id,
        targetAssigneeMembershipId: fixture.memberAMembership.id,
        baseVersion: 2
      }
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json()).toMatchObject({ assigneeMembershipId: fixture.memberAMembership.id, version: 3 });

    const peerRead = await inject(fixture, fixture.memberB.email, {
      method: 'GET',
      url: `/support/cases/${fixture.triageCase.key}`
    });
    expect(peerRead.statusCode).toBe(404);

    const outbound = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/interactions`,
      payload: {
        kind: 'MESSAGE',
        visibility: 'PUBLIC',
        channel: 'CALL',
        direction: 'OUTBOUND',
        content: { body: 'We are investigating.', format: 'text/plain' },
        baseVersion: 3
      }
    });
    expect(outbound.statusCode).toBe(201);
    expect(outbound.json().case.firstResponseAt).not.toBeNull();
    expect(outbound.json().case.version).toBe(4);

    const wait = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/wait`,
      payload: {
        status: 'WAITING_ON_CUSTOMER',
        nextActionAt: new Date(Date.now() + 3_600_000).toISOString(),
        baseVersion: 4
      }
    });
    expect(wait.statusCode).toBe(200);
    expect(wait.json()).toMatchObject({ status: 'WAITING_ON_CUSTOMER', version: 5 });

    const inbound = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/interactions`,
      payload: {
        kind: 'MESSAGE',
        visibility: 'PUBLIC',
        channel: 'CALL',
        direction: 'INBOUND',
        content: { body: 'Here is the requested information.', format: 'text/plain' },
        baseVersion: 5
      }
    });
    expect(inbound.statusCode).toBe(201);
    expect(inbound.json().case).toMatchObject({ status: 'OPEN', nextActionAt: null, version: 6 });

    const resolve = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/resolve`,
      payload: {
        resolutionCode: 'FIXED',
        resolutionSummary: 'Access was restored and verified.',
        baseVersion: 6
      }
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json()).toMatchObject({ status: 'RESOLVED', resolutionCode: 'FIXED', version: 7 });

    const forbiddenClose = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/close`,
      payload: { confirmation: 'CUSTOMER_CONFIRMED', baseVersion: 7 }
    });
    expect(forbiddenClose.statusCode).toBe(403);

    const close = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/close`,
      payload: { confirmation: 'CUSTOMER_CONFIRMED', baseVersion: 7 }
    });
    expect(close.statusCode).toBe(200);
    expect(close.json()).toMatchObject({ status: 'CLOSED', version: 8 });

    const reopen = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.triageCase.key}/reopen`,
      payload: { reason: 'Customer reports the failure returned.', baseVersion: 8 }
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json()).toMatchObject({
      status: 'OPEN',
      resolutionCode: null,
      resolutionSummary: null,
      version: 9
    });

    const events = await inject(fixture, fixture.manager.email, {
      method: 'GET',
      url: `/support/cases/${fixture.triageCase.key}/events`
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().items.map((event: { action: string }) => event.action)).toEqual([
      'case.routed',
      'case.assigned',
      'case.interaction_recorded',
      'case.waiting_on_customer',
      'case.customer_replied',
      'case.resolved',
      'case.closed',
      'case.reopened'
    ]);
  });

  test('Case commands advance frozen SLA cycles using trusted receipt time', async () => {
    const fixture = await createPrivacyFixture();
    await installSupportSlaPolicy(fixture.workspace.id);

    const created = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/cases',
      payload: {
        title: 'SLA-wired Case',
        sourceChannel: 'API',
        typeKey: 'incident',
        priority: 'NORMAL'
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().nextSlaDueAt).not.toBeNull();
    expect((await prisma.supportCaseSlaClock.findMany({
      where: { caseId: created.json().id },
      orderBy: { metric: 'asc' },
      select: { metric: true }
    })).map((clock) => clock.metric)).toEqual(['TRIAGE', 'FIRST_RESPONSE', 'RESOLUTION']);

    const routed = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: `/support/cases/${created.json().key}/route`,
      payload: { targetDepartmentId: fixture.department.id, baseVersion: 1 }
    });
    expect(routed.statusCode).toBe(200);
    const assigned = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${created.json().key}/route`,
      payload: {
        targetDepartmentId: fixture.department.id,
        targetAssigneeMembershipId: fixture.memberAMembership.id,
        baseVersion: 2
      }
    });
    expect(assigned.statusCode).toBe(200);
    expect(await prisma.supportCaseSlaClock.findFirstOrThrow({
      where: { caseId: created.json().id, metric: 'TRIAGE', cycle: 1 }
    })).toMatchObject({ state: 'MET' });
    expect(await prisma.supportCaseSlaClock.findFirstOrThrow({
      where: { caseId: created.json().id, metric: 'MEMBER_ASSIGNMENT', cycle: 1 }
    })).toMatchObject({ state: 'MET' });

    const beforeInbound = Date.now();
    const inbound = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${created.json().key}/interactions`,
      payload: {
        kind: 'MESSAGE',
        visibility: 'PUBLIC',
        channel: 'API',
        direction: 'INBOUND',
        occurredAt: '2099-01-01T00:00:00.000Z',
        content: { body: 'Future source timestamp must not move operational clocks.', format: 'text/plain' },
        baseVersion: 3
      }
    });
    expect(inbound.statusCode).toBe(201);
    const customerActivityAt = new Date(inbound.json().case.lastCustomerActivityAt).getTime();
    expect(customerActivityAt).toBeGreaterThanOrEqual(beforeInbound - 1_000);
    expect(customerActivityAt).toBeLessThan(Date.now() + 5_000);

    const outbound = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${created.json().key}/interactions`,
      payload: {
        kind: 'MESSAGE',
        visibility: 'PUBLIC',
        channel: 'API',
        direction: 'OUTBOUND',
        occurredAt: '2000-01-01T00:00:00.000Z',
        content: { body: 'Human response.', format: 'text/plain' },
        baseVersion: 4
      }
    });
    expect(outbound.statusCode).toBe(201);
    const firstResponseAt = new Date(outbound.json().case.firstResponseAt).getTime();
    expect(firstResponseAt).toBeGreaterThanOrEqual(beforeInbound - 1_000);
    expect(firstResponseAt).toBeLessThan(Date.now() + 5_000);
    expect((await prisma.supportCaseSlaClock.findMany({
      where: { caseId: created.json().id, metric: { in: ['FIRST_RESPONSE', 'NEXT_RESPONSE'] } },
      select: { state: true }
    })).every((clock) => clock.state === 'MET')).toBe(true);

    const resolved = await inject(fixture, fixture.memberA.email, {
      method: 'POST',
      url: `/support/cases/${created.json().key}/resolve`,
      payload: {
        resolutionCode: 'FIXED',
        resolutionSummary: 'Fixed and verified.',
        baseVersion: 5
      }
    });
    expect(resolved.statusCode).toBe(200);
    const reopened = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${created.json().key}/reopen`,
      payload: { reason: 'Customer says the problem returned.', baseVersion: 6 }
    });
    expect(reopened.statusCode).toBe(200);
    expect(await prisma.supportCaseSlaClock.findFirstOrThrow({
      where: { caseId: created.json().id, metric: 'FOLLOW_UP', cycle: 1 }
    })).toMatchObject({ state: 'CANCELED' });
    expect(await prisma.supportCaseSlaClock.findFirstOrThrow({
      where: { caseId: created.json().id, metric: 'RESOLUTION', cycle: 2 }
    })).toMatchObject({ state: 'RUNNING' });

    const directlyAssigned = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/cases',
      payload: {
        title: 'Direct Triage assignment',
        sourceChannel: 'API',
        typeKey: 'incident',
        priority: 'NORMAL'
      }
    });
    expect(directlyAssigned.statusCode).toBe(201);
    const directRoute = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: `/support/cases/${directlyAssigned.json().key}/route`,
      payload: {
        targetDepartmentId: fixture.department.id,
        targetAssigneeMembershipId: fixture.memberAMembership.id,
        baseVersion: 1
      }
    });
    expect(directRoute.statusCode).toBe(200);
    expect(await prisma.supportCaseSlaClock.findFirstOrThrow({
      where: { caseId: directlyAssigned.json().id, metric: 'MEMBER_ASSIGNMENT', cycle: 1 }
    })).toMatchObject({ state: 'MET' });
  });

  test('two concurrent dispatchers cannot both win the same optimistic Case version', async () => {
    const fixture = await createPrivacyFixture();
    const dispatch = (targetAssigneeMembershipId: string) => inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.departmentInboxCase.key}/route`,
      payload: {
        targetDepartmentId: fixture.department.id,
        targetAssigneeMembershipId,
        baseVersion: 1
      }
    });

    const responses = await Promise.all([
      dispatch(fixture.memberAMembership.id),
      dispatch(fixture.memberBMembership.id)
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.statusCode === 200)?.json();
    const loser = responses.find((response) => response.statusCode === 409)?.json();
    expect(winner.version).toBe(2);
    expect([
      fixture.memberAMembership.id,
      fixture.memberBMembership.id
    ]).toContain(winner.assigneeMembershipId);
    expect(loser).toMatchObject({
      code: 'SUPPORT_VERSION_CONFLICT',
      current: { id: fixture.departmentInboxCase.id, version: 2 }
    });
    expect(await prisma.supportCaseEvent.count({
      where: { caseId: fixture.departmentInboxCase.id, action: 'case.assigned' }
    })).toBe(1);
  });

  test('a transfer removes the former assignee immediately and invalidates their old support scope', async () => {
    const fixture = await createPrivacyFixture();
    const before = await inject(fixture, fixture.memberA.email, {
      method: 'GET',
      url: '/support/sync/bootstrap'
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().accessEpoch).toBe('1');

    const transfer = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/route`,
      payload: {
        targetDepartmentId: fixture.otherDepartment.id,
        reason: 'Specialist Department is now responsible.',
        baseVersion: 1
      }
    });
    expect(transfer.statusCode).toBe(200);

    const [detail, staleWrite, stalePull, after] = await Promise.all([
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: `/support/cases/${fixture.ownCase.key}`
      }),
      inject(fixture, fixture.memberA.email, {
        method: 'POST',
        url: `/support/cases/${fixture.ownCase.key}/interactions`,
        payload: {
          kind: 'NOTE',
          visibility: 'INTERNAL',
          channel: 'MANUAL',
          direction: 'INTERNAL',
          baseVersion: 1
        }
      }),
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: `/support/sync/pull?accessEpoch=1&cursor=${encodeURIComponent(before.json().cursor)}`
      }),
      inject(fixture, fixture.memberA.email, {
        method: 'GET',
        url: '/support/sync/bootstrap'
      })
    ]);
    expect(detail.statusCode).toBe(404);
    expect(staleWrite.statusCode).toBe(404);
    expect(stalePull.statusCode).toBe(409);
    expect(stalePull.json().code).toBe('SUPPORT_SCOPE_CHANGED');
    expect(after.statusCode).toBe(200);
    expect(after.json().accessEpoch).toBe('2');
    expect(after.json().cases.map((item: { id: string }) => item.id)).not.toContain(fixture.ownCase.id);
  });

  test('membership and permission changes bump the access epoch and deactivation returns owned Cases to the Department Inbox', async () => {
    const fixture = await createPrivacyFixture();
    const added = await inject(fixture, fixture.owner.email, {
      method: 'POST',
      url: `/support/departments/${fixture.department.id}/members`,
      payload: { userId: fixture.noAccess.id, role: 'MEMBER' }
    });
    expect(added.statusCode).toBe(201);
    const membershipId = added.json().id as string;
    expect((await bootstrapFor(fixture, fixture.noAccess.email)).accessEpoch).toBe('2');

    const assignment = await inject(fixture, fixture.owner.email, {
      method: 'POST',
      url: `/support/cases/${fixture.departmentInboxCase.key}/route`,
      payload: {
        targetDepartmentId: fixture.department.id,
        targetAssigneeMembershipId: membershipId,
        baseVersion: 1
      }
    });
    expect(assignment.statusCode).toBe(200);

    const promoted = await inject(fixture, fixture.owner.email, {
      method: 'PATCH',
      url: `/support/departments/${fixture.department.id}/members/${fixture.noAccess.id}`,
      payload: { role: 'MANAGER' }
    });
    expect(promoted.statusCode).toBe(200);
    expect((await bootstrapFor(fixture, fixture.noAccess.email)).accessEpoch).toBe('3');

    const granted = await inject(fixture, fixture.owner.email, {
      method: 'PUT',
      url: '/support/permission-grants',
      payload: { userId: fixture.noAccess.id, role: 'TRIAGER' }
    });
    expect(granted.statusCode).toBe(201);
    expect((await bootstrapFor(fixture, fixture.noAccess.email)).accessEpoch).toBe('4');

    const revoked = await inject(fixture, fixture.owner.email, {
      method: 'DELETE',
      url: `/support/permission-grants?userId=${fixture.noAccess.id}&role=TRIAGER`
    });
    expect(revoked.statusCode).toBe(204);
    expect((await bootstrapFor(fixture, fixture.noAccess.email)).accessEpoch).toBe('5');

    const deactivated = await inject(fixture, fixture.owner.email, {
      method: 'DELETE',
      url: `/support/departments/${fixture.department.id}/members/${fixture.noAccess.id}`
    });
    expect(deactivated.statusCode).toBe(204);
    const after = await bootstrapFor(fixture, fixture.noAccess.email);
    expect(after.accessEpoch).toBe('6');
    expect(after.cases).toEqual([]);

    const supportCase = await prisma.supportCase.findUniqueOrThrow({
      where: { id: fixture.departmentInboxCase.id }
    });
    expect(supportCase.assigneeMembershipId).toBeNull();
    expect(supportCase.version).toBe(3);
    expect(await prisma.supportCaseEvent.count({
      where: {
        caseId: supportCase.id,
        action: 'case.returned_to_department_inbox'
      }
    })).toBe(1);
  });

  test('guest users cannot receive Department membership or Support permission grants', async () => {
    const fixture = await createPrivacyFixture();
    const [membership, grant] = await Promise.all([
      inject(fixture, fixture.owner.email, {
        method: 'POST',
        url: `/support/departments/${fixture.otherDepartment.id}/members`,
        payload: { userId: fixture.guest.id, role: 'MEMBER' }
      }),
      inject(fixture, fixture.owner.email, {
        method: 'PUT',
        url: '/support/permission-grants',
        payload: { userId: fixture.guest.id, role: 'TRIAGER' }
      })
    ]);
    expect(membership.statusCode).toBe(400);
    expect(grant.statusCode).toBe(400);
    expect(await prisma.departmentMember.count({
      where: { workspaceId: fixture.workspace.id, userId: fixture.guest.id, departmentId: fixture.otherDepartment.id }
    })).toBe(0);
    expect(await prisma.supportPermissionGrant.count({
      where: { workspaceId: fixture.workspace.id, userId: fixture.guest.id }
    })).toBe(0);
  });

  test('a CONFIGURE credential cannot administer Support identity grants or promote itself', async () => {
    const fixture = await createPrivacyFixture();
    const credential = await prisma.agentCredential.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, userId: fixture.agent.id }
    });
    await prisma.agentCredential.update({
      where: { id: credential.id },
      data: { scope: 'READ_WRITE' }
    });
    await prisma.supportCredentialGrant.deleteMany({
      where: { workspaceId: fixture.workspace.id, credentialId: credential.id }
    });
    await prisma.supportCredentialGrant.create({
      data: { workspaceId: fixture.workspace.id, credentialId: credential.id, scope: 'CONFIGURE' }
    });

    const credentialHeaders = {
      'x-workspace-slug': fixture.workspace.slug,
      authorization: `Bearer ${fixture.agent.token}`
    };
    const [list, selfGrant, humanGrant] = await Promise.all([
      app.inject({ method: 'GET', url: '/support/credential-grants', headers: credentialHeaders }),
      app.inject({
        method: 'PUT',
        url: '/support/credential-grants',
        headers: credentialHeaders,
        payload: { credentialId: credential.id, scope: 'CASE_READ' }
      }),
      app.inject({
        method: 'PUT',
        url: '/support/permission-grants',
        headers: credentialHeaders,
        payload: { userId: fixture.noAccess.id, role: 'SUPERVISOR' }
      })
    ]);
    expect(list.statusCode).toBe(403);
    expect(selfGrant.statusCode).toBe(403);
    expect(humanGrant.statusCode).toBe(403);
    expect(await prisma.supportCredentialGrant.findMany({
      where: { workspaceId: fixture.workspace.id, credentialId: credential.id },
      select: { scope: true }
    })).toEqual([{ scope: 'CONFIGURE' }]);
    expect(await prisma.supportPermissionGrant.count({
      where: { workspaceId: fixture.workspace.id, userId: fixture.noAccess.id }
    })).toBe(0);
  });

  test('inline contact facts create a new identity and INTAKE credentials receive write-only projections', async () => {
    const fixture = await createPrivacyFixture();
    const sharedEmail = `same-contact-${crypto.randomUUID()}@example.test`;
    const privatePhone = '+41445550123';
    const first = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/cases',
      payload: {
        title: 'First contact report',
        sourceChannel: 'MANUAL',
        typeKey: 'request',
        idempotencyKey: `contact-first-${crypto.randomUUID()}`,
        contact: {
          name: 'First identity',
          email: sharedEmail,
          phone: privatePhone,
          externalCustomerId: 'private-upstream-id'
        }
      }
    });
    const second = await inject(fixture, fixture.triager.email, {
      method: 'POST',
      url: '/support/cases',
      payload: {
        title: 'Second contact report',
        sourceChannel: 'MANUAL',
        typeKey: 'request',
        idempotencyKey: `contact-second-${crypto.randomUUID()}`,
        contact: { name: 'Second identity', email: sharedEmail }
      }
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().contact.id).not.toBe(second.json().contact.id);
    expect(second.json().contact).toMatchObject({ name: 'Second identity', email: sharedEmail, phone: null });
    expect(JSON.stringify(second.json())).not.toContain(privatePhone);
    expect(JSON.stringify(first.json())).not.toContain('private-upstream-id');

    const credential = await prisma.agentCredential.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, userId: fixture.agent.id }
    });
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { scope: 'READ_WRITE' } });
    await prisma.supportCredentialGrant.deleteMany({ where: { credentialId: credential.id } });
    await prisma.supportCredentialGrant.create({
      data: { workspaceId: fixture.workspace.id, credentialId: credential.id, scope: 'INTAKE' }
    });
    const credentialHeaders = {
      'x-workspace-slug': fixture.workspace.slug,
      authorization: `Bearer ${fixture.agent.token}`
    };
    const created = await app.inject({
      method: 'POST',
      url: '/support/cases',
      headers: credentialHeaders,
      payload: {
        title: 'Credential intake',
        sourceChannel: 'API',
        typeKey: 'request',
        idempotencyKey: `credential-intake-${crypto.randomUUID()}`,
        contact: { email: sharedEmail }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(Object.keys(created.json()).sort()).toEqual([
      'accessEpoch', 'id', 'key', 'replayed', 'version'
    ]);
    expect(JSON.stringify(created.json())).not.toContain(sharedEmail);
    const lookup = await app.inject({
      method: 'GET',
      url: `/support/search?q=${encodeURIComponent(sharedEmail)}`,
      headers: credentialHeaders
    });
    expect(lookup.statusCode).toBe(403);
  });

  test('/me derives Support permissions, counts, and epochs for every actor class', async () => {
    const fixture = await createPrivacyFixture();
    const expected = [
      {
        email: fixture.owner.email,
        includes: ['support.setup', 'support.triage.read', 'support.department-inbox.read'],
        excludes: []
      },
      {
        email: fixture.supervisor.email,
        includes: ['support.triage.read', 'support.department-inbox.read', 'support.reports.read'],
        excludes: ['support.setup', 'support.departments.manage']
      },
      {
        email: fixture.triager.email,
        includes: ['support.triage.read', 'support.cases.create'],
        excludes: ['support.setup', 'support.department-inbox.read']
      },
      {
        email: fixture.manager.email,
        includes: ['support.department-inbox.read', 'support.cases.mine.read', 'support.cases.create'],
        excludes: ['support.setup', 'support.triage.read']
      },
      {
        email: fixture.memberA.email,
        includes: ['support.cases.mine.read', 'support.recovery.read'],
        excludes: ['support.setup', 'support.triage.read', 'support.department-inbox.read']
      },
      {
        email: fixture.guest.email,
        includes: [],
        excludes: ['support.setup', 'support.triage.read', 'support.cases.mine.read']
      },
      {
        email: fixture.noAccess.email,
        includes: [],
        excludes: ['support.setup', 'support.triage.read', 'support.cases.mine.read']
      }
    ];

    for (const persona of expected) {
      const response = await inject(fixture, persona.email, { method: 'GET', url: '/me' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.workspace.mode).toBe('SUPPORT');
      expect(body.supportAccessEpoch).toBe('1');
      expect(body.support.needsSetup).toBe(false);
      for (const permission of persona.includes) expect(body.permissions).toContain(permission);
      for (const permission of persona.excludes) expect(body.permissions).not.toContain(permission);
    }

    const credential = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        'x-workspace-slug': fixture.workspace.slug,
        authorization: `Bearer ${fixture.agent.token}`
      }
    });
    expect(credential.statusCode).toBe(200);
    expect(credential.json()).toMatchObject({ role: 'OWNER', supportAccessEpoch: '1' });
    expect(credential.json().permissions).toContain('support.department-inbox.read');
    expect(credential.json().permissions).not.toContain('support.setup');
    expect(credential.json().permissions).not.toContain('support.cases.create');
  });

  test('Support notifications are re-gated for list, sync, read, delivery, unread count, and transfer', async () => {
    const fixture = await createPrivacyFixture();
    const [ownNotification, peerNotification] = await Promise.all([
      prisma.notification.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.memberA.id,
          actorId: fixture.manager.id,
          actorType: 'USER',
          supportCaseId: fixture.ownCase.id,
          type: 'support_case_updated',
          title: 'Support Case updated'
        }
      }),
      prisma.notification.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.memberA.id,
          actorId: fixture.manager.id,
          actorType: 'USER',
          supportCaseId: fixture.peerCase.id,
          type: 'support_case_updated',
          title: 'Hidden peer Support Case updated'
        }
      })
    ]);

    const [list, sync, hiddenRead, delivered] = await Promise.all([
      inject(fixture, fixture.memberA.email, { method: 'GET', url: '/notifications?unread=true' }),
      inject(fixture, fixture.memberA.email, { method: 'GET', url: '/notifications/sync' }),
      inject(fixture, fixture.memberA.email, {
        method: 'PATCH',
        url: `/notifications/${peerNotification.id}/read`
      }),
      inject(fixture, fixture.memberA.email, {
        method: 'POST',
        url: '/notifications/delivered',
        payload: { ids: [ownNotification.id, peerNotification.id] }
      })
    ]);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, unreadCount: 1 });
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([ownNotification.id]);
    expect(sync.statusCode).toBe(200);
    expect(sync.json().items.map((item: { id: string }) => item.id)).toEqual([ownNotification.id]);
    expect(hiddenRead.statusCode).toBe(404);
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().updated).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: ownNotification.id } })).deliveredAt)
      .not.toBeNull();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: peerNotification.id } })).deliveredAt)
      .toBeNull();

    const transfer = await inject(fixture, fixture.manager.email, {
      method: 'POST',
      url: `/support/cases/${fixture.ownCase.key}/route`,
      payload: {
        targetDepartmentId: fixture.otherDepartment.id,
        reason: 'Transferred out of the former reader scope.',
        baseVersion: 1
      }
    });
    expect(transfer.statusCode).toBe(200);

    const after = await inject(fixture, fixture.memberA.email, {
      method: 'GET',
      url: '/notifications?unread=true'
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ items: [], total: 0, unreadCount: 0 });
  });
});

async function createPrivacyFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ['owner', 'manager', 'member-a', 'member-b', 'triager', 'no-access', 'guest', 'supervisor'].map((name) =>
      prisma.user.create({
        data: { email: `${name}-${suffix}@${EMAIL_DOMAIN}`, name }
      })
    )
  );
  const [owner, manager, memberA, memberB, triager, noAccess, guest, supervisor] = users;
  const agent = await prisma.user.create({
    data: {
      email: `agent-${suffix}@${EMAIL_DOMAIN}`,
      name: 'Support credential actor',
      kind: 'AGENT',
      operatorId: owner.id
    }
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'Support privacy', slug: `support-privacy-${suffix}`, mode: 'SUPPORT' }
  });
  cleanupWorkspaceIds.push(workspace.id);
  await prisma.supportWorkspaceState.create({
    data: { workspaceId: workspace.id, keyPrefix: 'SPRIV', nextCaseNumber: 7 }
  });
  await prisma.workspaceMember.createMany({
    data: [...users, agent].map((user) => ({
      workspaceId: workspace.id,
      userId: user.id,
      role: user.id === owner.id || user.id === agent.id
        ? 'OWNER'
        : user.id === guest.id
          ? 'GUEST'
          : 'MEMBER'
    }))
  });
  const department = await prisma.department.create({
    data: { workspaceId: workspace.id, name: 'Primary', slug: 'primary' }
  });
  const otherDepartment = await prisma.department.create({
    data: { workspaceId: workspace.id, name: 'Other', slug: 'other' }
  });
  const [managerMembership, memberAMembership, memberBMembership, guestMembership] = await Promise.all([
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: manager.id, role: 'MANAGER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberA.id, role: 'MEMBER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: memberB.id, role: 'MEMBER' }
    }),
    prisma.departmentMember.create({
      data: { workspaceId: workspace.id, departmentId: department.id, userId: guest.id, role: 'MEMBER' }
    })
  ]);
  await prisma.supportPermissionGrant.createMany({
    data: [
      { workspaceId: workspace.id, userId: triager.id, role: 'TRIAGER' },
      { workspaceId: workspace.id, userId: supervisor.id, role: 'SUPERVISOR' }
    ]
  });
  const minted = mintAgentCredentialToken();
  const agentCredential = await prisma.agentCredential.create({
    data: {
      workspaceId: workspace.id,
      userId: agent.id,
      name: 'Support read test',
      lookupId: minted.lookupId,
      tokenHash: minted.tokenHash,
      scope: 'READ_ONLY'
    }
  });
  await prisma.supportCredentialGrant.create({
    data: { workspaceId: workspace.id, credentialId: agentCredential.id, scope: 'CASE_READ' }
  });

  const [ownCase, peerCase, departmentInboxCase, triageCase, otherDepartmentCase, guestCase] = await Promise.all([
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 1,
        key: 'SPRIV-1',
        title: 'Own visible Case',
        sourceChannel: 'MANUAL',
        typeKey: 'request',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberAMembership.id
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 2,
        key: 'SPRIV-2',
        title: `Peer secret ${suffix}`,
        sourceChannel: 'CALL',
        typeKey: 'incident',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: memberBMembership.id
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 3,
        key: 'SPRIV-3',
        title: 'Department inbox Case',
        sourceChannel: 'API',
        typeKey: 'request',
        status: 'OPEN',
        departmentId: department.id
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 4,
        key: 'SPRIV-4',
        title: 'Triage Case',
        sourceChannel: 'API',
        typeKey: 'request',
        status: 'NEW'
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 5,
        key: 'SPRIV-5',
        title: 'Other Department Case',
        sourceChannel: 'API',
        typeKey: 'request',
        status: 'OPEN',
        departmentId: otherDepartment.id
      }
    }),
    prisma.supportCase.create({
      data: {
        workspaceId: workspace.id,
        sequence: 6,
        key: 'SPRIV-6',
        title: 'Guest must not see this Case',
        sourceChannel: 'API',
        typeKey: 'request',
        status: 'OPEN',
        departmentId: department.id,
        assigneeMembershipId: guestMembership.id
      }
    })
  ]);

  return {
    workspace,
    owner,
    manager,
    memberA,
    memberB,
    triager,
    noAccess,
    guest,
    supervisor,
    agent: { ...agent, token: minted.token },
    department,
    otherDepartment,
    managerMembership,
    memberAMembership,
    memberBMembership,
    guestMembership,
    ownCase,
    peerCase,
    departmentInboxCase,
    triageCase,
    otherDepartmentCase,
    guestCase
  };
}

function supportMemberAccess(
  fixture: Awaited<ReturnType<typeof createPrivacyFixture>>,
  member: 'A' | 'B',
  epoch: bigint
): SupportAccess {
  return {
    workspaceId: fixture.workspace.id,
    userId: member === 'A' ? fixture.memberA.id : fixture.memberB.id,
    workspaceWide: false,
    triager: false,
    supervisor: false,
    managedDepartmentIds: [],
    memberMembershipIds: [
      member === 'A' ? fixture.memberAMembership.id : fixture.memberBMembership.id
    ],
    credentialScopes: [],
    credentialActor: false,
    canWriteCases: true,
    canConfigure: false,
    canIntake: false,
    epoch
  };
}

async function installSupportSlaPolicy(workspaceId: string): Promise<void> {
  const calendar = await prisma.supportBusinessCalendar.create({
    data: { workspaceId, name: 'Support route test calendar', timezone: 'UTC' }
  });
  await prisma.supportBusinessCalendarPeriod.createMany({
    data: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      calendarId: calendar.id,
      dayOfWeek,
      startMinute: 0,
      endMinute: 24 * 60
    }))
  });
  await prisma.supportSlaPolicy.create({
    data: {
      workspaceId,
      calendarId: calendar.id,
      policyKey: 'route-test-default',
      name: 'Route test default',
      version: 1,
      conditions: {},
      targets: {
        TRIAGE: { businessSeconds: 60 * 60 },
        FIRST_RESPONSE: { businessSeconds: 4 * 60 * 60 },
        NEXT_RESPONSE: { businessSeconds: 2 * 60 * 60 },
        RESOLUTION: { businessSeconds: 8 * 60 * 60 },
        FOLLOW_UP: { businessSeconds: 4 * 60 * 60 },
        MEMBER_ASSIGNMENT: { businessSeconds: 60 * 60 }
      },
      pauseRules: {
        waitingOnCustomer: ['RESOLUTION'],
        waitingOnInternal: [],
        snoozed: [],
        automatedPublicResponseMeets: []
      },
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z')
    }
  });
}

function headers(workspaceSlug: string, email: string): Record<string, string> {
  return { 'x-workspace-slug': workspaceSlug, 'x-user-email': email };
}

function inject(
  fixture: Awaited<ReturnType<typeof createPrivacyFixture>>,
  email: string,
  options: Omit<InjectOptions, 'headers'>
) {
  return app.inject({ ...options, headers: headers(fixture.workspace.slug, email) });
}

async function bootstrapFor(
  fixture: Awaited<ReturnType<typeof createPrivacyFixture>>,
  email: string
) {
  const response = await inject(fixture, email, { method: 'GET', url: '/support/sync/bootstrap' });
  expect(response.statusCode).toBe(200);
  return response.json();
}
