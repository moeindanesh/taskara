import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type Workspace, type User } from '@taskara/db';
import { createSupportIntakeConnectorSchema } from '@taskara/shared';
import type { RequestActor } from './actor';
import {
  acceptSupportIntakeEvent,
  createSupportIntakeConnector,
  getSupportIntakeHealth,
  readSupportIntakeReceiptStatus,
  runSupportIntakeWorkerTick,
  supportIntakeSignature
} from './support-intake';

process.env.TASKARA_SUPPORT_DATA_SECRET ??= 'taskara-test-only-support-encryption-key-0001';

const EMAIL_DOMAIN = 'support-intake.test';
let workspace: Workspace;
let user: User;
let actor: RequestActor;
let connector: Awaited<ReturnType<typeof createSupportIntakeConnector>>;
const cleanupTeamWorkspaceIds: string[] = [];

describe('durable Support connector intake', () => {
  beforeAll(async () => {
    user = await prisma.user.create({
      data: { email: `owner-${crypto.randomUUID()}@${EMAIL_DOMAIN}`, name: 'Intake Owner' }
    });
    workspace = await prisma.workspace.create({
      data: {
        name: 'Support Intake Test',
        slug: `support-intake-${crypto.randomUUID()}`,
        mode: 'SUPPORT',
        users: { create: { userId: user.id, role: 'OWNER' } }
      }
    });
    actor = {
      workspace,
      user,
      role: 'OWNER',
      actorType: 'USER',
      actorRuntime: null,
      source: 'WEB'
    };
    connector = await createSupportIntakeConnector(actor, createSupportIntakeConnectorSchema.parse({
      name: 'API test source',
      sourceKey: `source-${crypto.randomUUID()}`,
      sourceChannel: 'API',
      replayWindowSeconds: 300,
      maxPayloadBytes: 1_048_576,
      rateLimitPerMinute: 120,
      config: { privateToken: 'connector-config-must-remain-private' }
    }));
  });

  afterAll(async () => {
    const workspaceIds = [workspace?.id, ...cleanupTeamWorkspaceIds].filter((id): id is string => Boolean(id));
    if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  test('verifies signature before parsing and persists one receipt for safe retries', async () => {
    expect(connector.connector).not.toHaveProperty('config');
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const invalidJson = Buffer.from('{definitely not json', 'utf8');
    await expect(acceptSupportIntakeEvent({
      lookupId: connector.connector.lookupId,
      rawBody: invalidJson,
      headers: {
        timestamp,
        eventId: 'invalid-before-parse',
        signature: `v1=${'0'.repeat(64)}`
      },
      now
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(await prisma.supportIntakeReceipt.count({
      where: { connectorId: connector.connector.id, eventKey: 'invalid-before-parse' }
    })).toBe(0);

    const body = eventBody('thread-idempotent', 'message-idempotent', 'Original body');
    const accepted = await accept(body, 'event-idempotent', now, 'same-idempotency-key');
    expect(accepted.replayed).toBe(false);
    const replayed = await accept(body, 'event-idempotent', now, 'same-idempotency-key');
    expect(replayed).toMatchObject({ receiptId: accepted.receiptId, replayed: true });
    expect(await prisma.supportIntakeReceipt.count({
      where: { connectorId: connector.connector.id, eventKey: 'event-idempotent' }
    })).toBe(1);

    const changed = eventBody('thread-idempotent', 'message-idempotent', 'Changed body');
    await expect(accept(changed, 'event-idempotent', now, 'same-idempotency-key'))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.supportOutboxEvent.count({
      where: { receiptId: accepted.receiptId, topic: 'support.security.intake_payload_mismatch' }
    })).toBe(1);
  });

  test('refuses an unsupported persisted signature scheme as an invalid connector', async () => {
    const unsupported = await createSupportIntakeConnector(actor, createSupportIntakeConnectorSchema.parse({
      name: 'Unsupported persisted source',
      sourceKey: `unsupported-${crypto.randomUUID()}`,
      sourceChannel: 'API'
    }));
    await prisma.supportIntakeConnector.update({
      where: { id: unsupported.connector.id },
      data: { signatureScheme: 'ED25519' }
    });

    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    try {
      await expect(acceptSupportIntakeEvent({
        lookupId: unsupported.connector.lookupId,
        rawBody: Buffer.from('{}'),
        headers: {
          timestamp,
          eventId: 'unsupported-signature-event',
          signature: 'invalid'
        },
        now
      })).rejects.toMatchObject({
        statusCode: 401,
        message: 'Invalid Support intake connector'
      });
      expect(await prisma.supportIntakeReceipt.count({
        where: { connectorId: unsupported.connector.id }
      })).toBe(0);
    } finally {
      await prisma.supportIntakeConnector.delete({ where: { id: unsupported.connector.id } });
    }
  });

  test('a worker maps encrypted receipt bytes to one Case/timeline and exposes a scoped status', async () => {
    const now = new Date();
    const accepted = await accept(
      eventBody('thread-process', 'message-process', 'Customer private text'),
      'event-process',
      now
    );
    const stored = await prisma.supportIntakeReceipt.findUniqueOrThrow({ where: { id: accepted.receiptId } });
    expect(stored.payloadCiphertext).not.toBeNull();
    expect(Buffer.from(stored.payloadCiphertext!).toString('utf8')).not.toContain('Customer private text');

    const stats = await runSupportIntakeWorkerTick({ owner: 'intake-test-worker', now });
    expect(stats.processed).toBeGreaterThanOrEqual(1);
    const receipt = await prisma.supportIntakeReceipt.findUniqueOrThrow({
      where: { id: accepted.receiptId },
      include: {
        case: {
          include: { interactions: { include: { content: true } }, events: true }
        }
      }
    });
    expect(receipt.status).toBe('PROCESSED');
    expect(receipt.case?.key).toMatch(/^[A-Z][A-Z0-9]{1,7}-\d+$/);
    expect(receipt.case?.interactions).toHaveLength(1);
    expect(receipt.case?.interactions[0]?.content?.bodyCiphertext).not.toBeNull();
    expect(receipt.case?.events.map((event) => event.action)).toContain('case.created');
    expect(receipt.case?.events.map((event) => event.action)).toContain('case.customer_interaction_received');

    const status = await readSupportIntakeReceiptStatus({
      lookupId: connector.connector.lookupId,
      receiptId: accepted.receiptId,
      bearerSecret: connector.signingSecret
    });
    expect(status).toMatchObject({ status: 'PROCESSED', caseKey: receipt.case?.key });
    await expect(readSupportIntakeReceiptStatus({
      lookupId: connector.connector.lookupId,
      receiptId: accepted.receiptId,
      bearerSecret: 'wrong-secret'
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  test('persists connector call direction as inbound on both the interaction and call detail', async () => {
    const now = new Date();
    const accepted = await accept(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      externalCaseId: 'thread-inbound-call',
      case: { title: 'Inbound connector call', typeKey: 'incident' },
      interaction: {
        externalId: 'interaction-inbound-call',
        kind: 'CALL',
        body: 'Caller needs assistance'
      },
      call: {
        disposition: 'ANSWERED',
        startedAt: now.toISOString(),
        recordingConsent: 'UNKNOWN',
        recordingExists: false,
        externalCallId: 'external-inbound-call'
      }
    }), 'utf8'), 'event-inbound-call', now);
    await runSupportIntakeWorkerTick({ owner: 'inbound-call-worker', now });

    const receipt = await prisma.supportIntakeReceipt.findUniqueOrThrow({
      where: { id: accepted.receiptId },
      include: { case: { include: { interactions: { include: { call: true } } } } }
    });
    expect(receipt.case?.interactions).toHaveLength(1);
    expect(receipt.case?.interactions[0]).toMatchObject({
      kind: 'CALL',
      direction: 'INBOUND',
      call: { direction: 'INBOUND' }
    });
  });

  test('versions, audits, and syncs connector snapshot-only Case updates', async () => {
    const firstAt = new Date();
    const externalCaseId = `thread-snapshot-${crypto.randomUUID()}`;
    const first = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      externalCaseId,
      sourceSequence: '1',
      case: { title: 'Original source snapshot', typeKey: 'incident', priority: 'NORMAL' }
    }), 'utf8');
    const firstReceipt = await accept(first, `event-snapshot-1-${crypto.randomUUID()}`, firstAt);
    await runSupportIntakeWorkerTick({ owner: 'snapshot-worker-1', now: firstAt });
    const created = await prisma.supportIntakeReceipt.findUniqueOrThrow({
      where: { id: firstReceipt.receiptId },
      include: { case: true }
    });
    expect(created.case?.version).toBe(1);

    const secondAt = new Date(firstAt.getTime() + 1_000);
    const second = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      externalCaseId,
      sourceSequence: '2',
      case: { title: 'Corrected source snapshot', typeKey: 'request', priority: 'HIGH' }
    }), 'utf8');
    await accept(second, `event-snapshot-2-${crypto.randomUUID()}`, secondAt);
    await runSupportIntakeWorkerTick({ owner: 'snapshot-worker-2', now: secondAt });

    const updated = await prisma.supportCase.findUniqueOrThrow({
      where: { id: created.case!.id },
      include: { events: { orderBy: { sequence: 'asc' } } }
    });
    expect(updated).toMatchObject({
      title: 'Corrected source snapshot',
      typeKey: 'request',
      priority: 'HIGH',
      version: 2
    });
    expect(updated.events.map((event) => event.action)).toContain('case.source_snapshot_updated');
    const latestSync = await prisma.syncEvent.findFirst({
      where: { workspaceId: workspace.id, entityType: 'support_case', entityId: updated.id },
      orderBy: { workspaceSeq: 'desc' }
    });
    expect(latestSync).toMatchObject({ operation: 'upsert', entityVersion: 2 });
  });

  test('a connector customer reply reopens the Case and updates only the coarse Team projection', async () => {
    const firstAt = new Date();
    const externalCaseId = `thread-linked-reopen-${crypto.randomUUID()}`;
    const firstReceipt = await accept(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      externalCaseId,
      sourceSequence: '1',
      case: { title: 'Private connector Case title', typeKey: 'incident', priority: 'NORMAL' }
    }), 'utf8'), `event-linked-reopen-1-${crypto.randomUUID()}`, firstAt);
    await runSupportIntakeWorkerTick({ owner: 'linked-reopen-worker-1', now: firstAt });
    const receipt = await prisma.supportIntakeReceipt.findUniqueOrThrow({
      where: { id: firstReceipt.receiptId },
      include: { case: true }
    });
    const supportCase = receipt.case!;
    const department = await prisma.department.create({
      data: { workspaceId: workspace.id, name: 'Connector reopen', slug: `connector-reopen-${crypto.randomUUID()}` }
    });
    const resolvedAt = new Date(firstAt.getTime() + 500);
    const resolved = await prisma.supportCase.update({
      where: { id: supportCase.id },
      data: {
        departmentId: department.id,
        status: 'RESOLVED',
        resolutionCode: 'FIXED',
        resolutionSummary: 'Awaiting customer verification.',
        resolvedAt,
        version: { increment: 1 }
      }
    });

    const teamWorkspace = await prisma.workspace.create({
      data: {
        name: 'Connector Team projection',
        slug: `connector-team-${crypto.randomUUID()}`,
        mode: 'TEAM',
        users: { create: { userId: user.id, role: 'OWNER' } }
      }
    });
    cleanupTeamWorkspaceIds.push(teamWorkspace.id);
    const project = await prisma.project.create({
      data: { workspaceId: teamWorkspace.id, name: 'Connector delivery', keyPrefix: `CR${crypto.randomUUID().slice(0, 4).toUpperCase()}` }
    });
    const task = await prisma.task.create({
      data: {
        workspaceId: teamWorkspace.id,
        projectId: project.id,
        sequence: 1,
        key: `${project.keyPrefix}-1`,
        title: 'Approved Team work',
        status: 'TODO'
      }
    });
    const approvedAt = new Date();
    const connection = await prisma.workspaceConnection.create({
      data: {
        supportWorkspaceId: workspace.id,
        teamWorkspaceId: teamWorkspace.id,
        status: 'ACTIVE',
        supportApprovedById: user.id,
        supportApprovedAt: approvedAt,
        teamApprovedById: user.id,
        teamApprovedAt: approvedAt
      }
    });
    const target = await prisma.departmentWorkTarget.create({
      data: {
        connectionId: connection.id,
        supportWorkspaceId: workspace.id,
        teamWorkspaceId: teamWorkspace.id,
        departmentId: department.id,
        projectId: project.id,
        allowCreateTasks: true,
        allowLinkTasks: true,
        createdById: user.id
      }
    });
    const link = await prisma.supportCaseTaskLink.create({
      data: {
        idempotencyKey: `connector-reopen-${crypto.randomUUID()}`,
        idempotencyHash: 'a'.repeat(64),
        connectionId: connection.id,
        workTargetId: target.id,
        supportWorkspaceId: workspace.id,
        teamWorkspaceId: teamWorkspace.id,
        caseId: resolved.id,
        taskId: task.id,
        taskWorkspaceId: teamWorkspace.id,
        relationType: 'FIX_WORK',
        handoffTitle: 'Approved connector handoff',
        handoffSummary: 'Only this approved brief crosses workspaces.',
        teamWorkspaceNameSnapshot: teamWorkspace.name,
        taskKeySnapshot: task.key,
        taskTitleSnapshot: 'Approved connector handoff',
        taskStatusSnapshot: task.status,
        supportWorkspaceNameSnapshot: workspace.name,
        caseKeySnapshot: resolved.key,
        caseTitleSnapshot: 'Approved connector handoff',
        caseStatusSnapshot: 'RESOLVED',
        lastTaskSignalAt: approvedAt,
        lastCaseSignalAt: approvedAt,
        createdById: user.id
      }
    });

    const replyAt = new Date(firstAt.getTime() + 1_000);
    await accept(eventBody(externalCaseId, `message-linked-reopen-${crypto.randomUUID()}`, 'The problem returned.', {
      sourceSequence: '2',
      title: 'A private updated source title'
    }), `event-linked-reopen-2-${crypto.randomUUID()}`, replyAt);
    await runSupportIntakeWorkerTick({ owner: 'linked-reopen-worker-2', now: replyAt });

    const [reopened, projected] = await Promise.all([
      prisma.supportCase.findUniqueOrThrow({ where: { id: resolved.id } }),
      prisma.supportCaseTaskLink.findUniqueOrThrow({ where: { id: link.id } })
    ]);
    expect(reopened.status).toBe('OPEN');
    expect(projected.caseStatusSnapshot).toBe('OPEN');
    expect(projected.caseTitleSnapshot).toBe('Approved connector handoff');
    const teamEvent = await prisma.syncEvent.findFirst({
      where: {
        workspaceId: teamWorkspace.id,
        entityType: 'support_case_task_link',
        entityId: link.id,
        operation: 'case_status_changed'
      }
    });
    expect(JSON.stringify(teamEvent?.payload)).not.toContain('private');
    expect(JSON.stringify(teamEvent?.payload)).not.toContain(resolved.id);
  });

  test('out-of-order source events preserve the newer Case snapshot but keep both interactions', async () => {
    const firstAt = new Date();
    const newer = eventBody('thread-order', 'message-newer', 'New interaction', {
      sourceSequence: '10',
      title: 'New source title'
    });
    const older = eventBody('thread-order', 'message-older', 'Late old interaction', {
      sourceSequence: '2',
      title: 'Old source title'
    });
    await accept(newer, 'event-order-new', firstAt);
    await runSupportIntakeWorkerTick({ owner: 'order-worker-new', now: firstAt });
    const laterAt = new Date(firstAt.getTime() + 1_000);
    await accept(older, 'event-order-old', laterAt);
    await runSupportIntakeWorkerTick({ owner: 'order-worker-old', now: laterAt });

    const ref = await prisma.supportExternalRef.findUniqueOrThrow({
      where: {
        connectorId_externalCaseId: {
          connectorId: connector.connector.id,
          externalCaseId: 'thread-order'
        }
      },
      include: { case: { include: { interactions: true } } }
    });
    expect(ref.sourceSequence).toBe('10');
    expect(ref.case.title).toBe('New source title');
    expect(ref.case.interactions).toHaveLength(2);
  });

  test('keeps source occurrence time on the timeline but uses trusted receipt time for operations', async () => {
    const receivedAt = new Date();
    const accepted = await accept(
      eventBody('thread-trusted-time', 'message-trusted-time', 'Timestamp boundary', {
        occurredAt: '2099-01-01T00:00:00.000Z'
      }),
      'event-trusted-time',
      receivedAt
    );
    await runSupportIntakeWorkerTick({ owner: 'trusted-time-worker', now: receivedAt });

    const receipt = await prisma.supportIntakeReceipt.findUniqueOrThrow({
      where: { id: accepted.receiptId },
      include: { case: { include: { interactions: true } } }
    });
    expect(receipt.case?.interactions[0]?.occurredAt.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    expect(receipt.case?.lastCustomerActivityAt?.toISOString()).toBe(receipt.receivedAt.toISOString());
    expect(receipt.case?.lastMeaningfulActivityAt.toISOString()).toBe(receipt.receivedAt.toISOString());
  });

  test('expired leases recover and corrupt payloads become visible dead letters', async () => {
    const now = new Date();
    const recoverable = await accept(
      eventBody('thread-recover', 'message-recover', 'Recover me'),
      'event-recover',
      now
    );
    await prisma.supportIntakeReceipt.update({
      where: { id: recoverable.receiptId },
      data: {
        status: 'PROCESSING',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(now.getTime() - 1_000)
      }
    });
    await runSupportIntakeWorkerTick({ owner: 'recovery-worker', now });
    expect((await prisma.supportIntakeReceipt.findUniqueOrThrow({ where: { id: recoverable.receiptId } })).status)
      .toBe('PROCESSED');

    const poisonAt = new Date(now.getTime() + 2_000);
    const poison = await accept(
      eventBody('thread-poison', 'message-poison', 'Poison'),
      'event-poison',
      poisonAt
    );
    await prisma.supportIntakeReceipt.update({
      where: { id: poison.receiptId },
      data: { payloadCiphertext: Uint8Array.from(Buffer.from('not-an-authenticated-envelope')) }
    });
    await runSupportIntakeWorkerTick({ owner: 'poison-worker', now: poisonAt, maxAttempts: 1 });
    const dead = await prisma.supportIntakeReceipt.findUniqueOrThrow({ where: { id: poison.receiptId } });
    expect(dead.status).toBe('DEAD_LETTER');
    expect(dead.lastErrorCode).toBeTruthy();
    const health = await getSupportIntakeHealth(actor);
    expect(health.deadLetters.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(health)).not.toContain('event-poison');
    expect(health.deadLetters.every((item) => !('eventKey' in item))).toBe(true);
  });
});

async function accept(
  body: Buffer,
  eventId: string,
  now: Date,
  idempotencyKey?: string
) {
  const timestamp = Math.floor(now.getTime() / 1_000).toString();
  return acceptSupportIntakeEvent({
    lookupId: connector.connector.lookupId,
    rawBody: body,
    headers: {
      timestamp,
      eventId,
      idempotencyKey,
      signature: supportIntakeSignature(connector.signingSecret, timestamp, body)
    },
    now
  });
}

function eventBody(
  externalCaseId: string,
  externalInteractionId: string,
  body: string,
  overrides: { sourceSequence?: string; title?: string; occurredAt?: string } = {}
): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    externalCaseId,
    sourceSequence: overrides.sourceSequence,
    case: {
      title: overrides.title ?? `Case ${externalCaseId}`,
      typeKey: 'incident',
      contact: { externalCustomerId: `contact-${externalCaseId}`, name: 'Customer' }
    },
    interaction: {
      externalId: externalInteractionId,
      kind: 'MESSAGE',
      occurredAt: overrides.occurredAt,
      body
    }
  }), 'utf8');
}
