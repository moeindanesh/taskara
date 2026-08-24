import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  Prisma,
  prisma,
  type SupportIntakeConnector,
  type SupportIntakeReceipt,
  type SupportOutboxEvent
} from '@taskara/db';
import { type createSupportIntakeConnectorSchema } from '@taskara/shared';
import type { z } from 'zod';
import { config } from '../config';
import type { RequestActor } from './actor';
import { isWorkspaceAdminRole } from './actor';
import { HttpError } from './http';
import {
  constantTimeTextEqual,
  decryptSupportBytes,
  decryptSupportText,
  encryptSupportBytes,
  encryptSupportText,
  hashSupportPayload,
  mintSupportConnectorSecret,
  verifySupportConnectorSecret
} from './support-crypto';
import {
  supportIntakeEventSchema,
  type SupportIntakeEvent
} from './support-intake-contract';
import {
  appendSupportCaseSystemEvent,
  reserveSupportCaseKey
} from './support-cases';
import { appendSupportCaseSyncEvent } from './support-sync';
import { applySupportSlaCaseEvent } from './support-sla';
import { applySupportCaseSignalToTaskLinksWithProvenance } from './support-task-link-signals';
import { assertSupportWorkspace } from './workspace-mode';

export type CreateSupportIntakeConnectorInput = z.infer<typeof createSupportIntakeConnectorSchema>;

const RECEIPT_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_TICK_MS = 1_000;
const SUPPORT_INTAKE_RECEIPT_STATUSES = [
  'RECEIVED',
  'PROCESSING',
  'RETRY_PENDING',
  'PROCESSED',
  'REJECTED',
  'DEAD_LETTER'
] as const satisfies readonly SupportIntakeReceipt['status'][];
const SUPPORT_INTAKE_PENDING_STATUSES = [
  'RECEIVED',
  'PROCESSING',
  'RETRY_PENDING'
] as const satisfies readonly SupportIntakeReceipt['status'][];
const PUBLIC_INTAKE_ERROR_CODES = new Set([
  'INTAKE_PAYLOAD_UNAVAILABLE',
  'INTAKE_PAYLOAD_INTEGRITY_FAILED',
  'INTAKE_PAYLOAD_INVALID_JSON',
  'INTAKE_PAYLOAD_INVALID',
  'INTAKE_WORKSPACE_MODE_INVALID',
  'INTAKE_LEASE_OR_VERSION_CONFLICT',
  'INTAKE_DUPLICATE_CONFLICT',
  'INTAKE_PROCESSING_FAILED'
]);

export interface IntakeAuthenticationHeaders {
  timestamp: string;
  eventId: string;
  signature: string;
  idempotencyKey?: string;
}

export interface AcceptedSupportIntake {
  receiptId: string;
  status: SupportIntakeReceipt['status'];
  replayed: boolean;
  location: string;
}

export interface SupportIntakeWorkerOptions {
  owner?: string;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  now?: Date;
  outboxHandler?: (event: SupportOutboxEvent) => Promise<void>;
}

export interface SupportIntakeWorkerHandle {
  owner: string;
  stop: () => Promise<void>;
}

export interface SupportIntakeDeadLetterPageInput {
  cursor?: string;
  limit?: number;
  connectorId?: string;
}

export async function createSupportIntakeConnector(
  actor: RequestActor,
  input: CreateSupportIntakeConnectorInput
) {
  assertCanConfigureConnectors(actor);
  if (input.signatureScheme !== 'HMAC_SHA256') {
    throw new HttpError(400, 'Only HMAC_SHA256 Support intake connectors are available in v1');
  }
  const minted = mintSupportConnectorSecret();
  const secret = encryptSupportText(minted.secret);
  const connector = await prisma.supportIntakeConnector.create({
    data: {
      workspaceId: actor.workspace.id,
      name: input.name,
      sourceKey: input.sourceKey,
      sourceChannel: input.sourceChannel,
      lookupId: minted.lookupId,
      secretHash: minted.secretHash,
      secretCiphertext: secret.ciphertext,
      secretEncryptionKeyId: secret.keyId,
      signatureScheme: input.signatureScheme,
      replayWindowSeconds: input.replayWindowSeconds,
      maxPayloadBytes: input.maxPayloadBytes,
      rateLimitPerMinute: input.rateLimitPerMinute,
      config: input.config as Prisma.InputJsonValue | undefined
    }
  });
  return {
    connector: serializeSupportIntakeConnector(connector),
    signingSecret: minted.secret,
    signature: {
      algorithm: connector.signatureScheme,
      header: 'x-taskara-signature',
      timestampHeader: 'x-taskara-timestamp',
      eventIdHeader: 'x-taskara-event-id',
      signedPayload: '<timestamp>.<exact request bytes>'
    }
  };
}

export async function listSupportIntakeConnectors(actor: RequestActor) {
  assertCanConfigureConnectors(actor);
  const connectors = await prisma.supportIntakeConnector.findMany({
    where: { workspaceId: actor.workspace.id },
    orderBy: [{ status: 'asc' }, { name: 'asc' }]
  });
  return { items: connectors.map(serializeSupportIntakeConnector) };
}

export async function rotateSupportIntakeConnector(actor: RequestActor, connectorId: string) {
  assertCanConfigureConnectors(actor);
  const current = await prisma.supportIntakeConnector.findFirst({
    where: { id: connectorId, workspaceId: actor.workspace.id },
    select: { id: true, status: true }
  });
  if (!current) throw new HttpError(404, 'Support intake connector not found');
  if (current.status !== 'ACTIVE') throw new HttpError(409, 'A revoked connector cannot be rotated');

  const minted = mintSupportConnectorSecret();
  const encrypted = encryptSupportText(minted.secret);
  // The public lookup id is stable so source configuration needs only a secret rotation. Old
  // signatures stop working as soon as this transaction commits.
  const connector = await prisma.supportIntakeConnector.update({
    where: { id: current.id },
    data: {
      secretHash: minted.secretHash,
      secretCiphertext: encrypted.ciphertext,
      secretEncryptionKeyId: encrypted.keyId,
      secretVersion: { increment: 1 },
      rotatedAt: new Date()
    }
  });
  return { connector: serializeSupportIntakeConnector(connector), signingSecret: minted.secret };
}

export async function revokeSupportIntakeConnector(
  actor: RequestActor,
  connectorId: string,
  reason?: string
) {
  assertCanConfigureConnectors(actor);
  const connector = await prisma.supportIntakeConnector.findFirst({
    where: { id: connectorId, workspaceId: actor.workspace.id }
  });
  if (!connector) throw new HttpError(404, 'Support intake connector not found');
  if (connector.status === 'REVOKED') return serializeSupportIntakeConnector(connector);
  const updated = await prisma.supportIntakeConnector.update({
    where: { id: connector.id },
    data: {
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedById: actor.user.id,
      config: reason
        ? mergePrivateConfig(connector.config, { revocationReason: reason.slice(0, 1_000) })
        : undefined
    }
  });
  return serializeSupportIntakeConnector(updated);
}

export async function getSupportIntakeHealth(actor: RequestActor) {
  assertCanConfigureConnectors(actor);
  const rows = await prisma.supportIntakeReceipt.groupBy({
    by: ['status'],
    where: { workspaceId: actor.workspace.id },
    _count: { _all: true }
  });
  const oldestPending = await prisma.supportIntakeReceipt.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      status: { in: ['RECEIVED', 'PROCESSING', 'RETRY_PENDING'] }
    },
    orderBy: { receivedAt: 'asc' },
    select: { receivedAt: true }
  });
  const recentDeadLetters = await prisma.supportIntakeReceipt.findMany({
    where: { workspaceId: actor.workspace.id, status: 'DEAD_LETTER' },
    orderBy: { deadLetteredAt: 'desc' },
    take: 50,
    select: {
      id: true,
      connectorId: true,
      attemptCount: true,
      lastErrorCode: true,
      receivedAt: true,
      deadLetteredAt: true
    }
  });
  return {
    counts: Object.fromEntries(rows.map((row) => [row.status, row._count._all])),
    oldestPendingAt: oldestPending?.receivedAt.toISOString() ?? null,
    deadLetters: recentDeadLetters.map((receipt) => ({
      id: receipt.id,
      connectorId: receipt.connectorId,
      attemptCount: receipt.attemptCount,
      lastErrorCode: publicIntakeErrorCode(receipt.lastErrorCode),
      receivedAt: receipt.receivedAt.toISOString(),
      deadLetteredAt: receipt.deadLetteredAt?.toISOString() ?? null
    }))
  };
}

/**
 * Operational connector health for workspace administrators. Connector credentials, private
 * configuration and receipt identity/payload fields are deliberately never selected here.
 */
export async function getSupportIntakeAdminHealth(actor: RequestActor, now = new Date()) {
  assertCanConfigureConnectors(actor);
  const workspaceId = actor.workspace.id;
  const [connectors, countRows, timestampRows, pendingRows] = await Promise.all([
    prisma.supportIntakeConnector.findMany({
      where: { workspaceId },
      orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        sourceChannel: true,
        status: true,
        createdAt: true,
        rotatedAt: true,
        revokedAt: true
      }
    }),
    prisma.supportIntakeReceipt.groupBy({
      by: ['connectorId', 'status'],
      where: { workspaceId },
      _count: { _all: true }
    }),
    prisma.supportIntakeReceipt.groupBy({
      by: ['connectorId'],
      where: { workspaceId },
      _max: {
        receivedAt: true,
        processedAt: true,
        deadLetteredAt: true
      }
    }),
    prisma.supportIntakeReceipt.groupBy({
      by: ['connectorId'],
      where: { workspaceId, status: { in: [...SUPPORT_INTAKE_PENDING_STATUSES] } },
      _min: { receivedAt: true }
    })
  ]);

  const workspaceCounts = emptySupportIntakeReceiptCounts();
  const countsByConnector = new Map<string, ReturnType<typeof emptySupportIntakeReceiptCounts>>();
  for (const row of countRows) {
    const connectorCounts = countsByConnector.get(row.connectorId)
      ?? emptySupportIntakeReceiptCounts();
    connectorCounts[row.status] = row._count._all;
    workspaceCounts[row.status] += row._count._all;
    countsByConnector.set(row.connectorId, connectorCounts);
  }
  const timestampsByConnector = new Map(timestampRows.map((row) => [row.connectorId, row._max]));
  const oldestPendingByConnector = new Map(
    pendingRows.map((row) => [row.connectorId, row._min.receivedAt])
  );
  const oldestPendingAt = pendingRows.reduce<Date | null>((oldest, row) => {
    const candidate = row._min.receivedAt;
    if (!candidate) return oldest;
    return !oldest || candidate < oldest ? candidate : oldest;
  }, null);

  return {
    generatedAt: now.toISOString(),
    summary: {
      connectorCount: connectors.length,
      activeConnectorCount: connectors.filter((connector) => connector.status === 'ACTIVE').length,
      receiptCounts: workspaceCounts,
      pendingCount: pendingReceiptCount(workspaceCounts),
      deadLetterCount: workspaceCounts.DEAD_LETTER,
      oldestPendingAt: oldestPendingAt?.toISOString() ?? null
    },
    items: connectors.map((connector) => {
      const counts = countsByConnector.get(connector.id) ?? emptySupportIntakeReceiptCounts();
      const timestamps = timestampsByConnector.get(connector.id);
      return {
        connector: {
          id: connector.id,
          name: connector.name,
          sourceChannel: connector.sourceChannel,
          status: connector.status,
          createdAt: connector.createdAt.toISOString(),
          rotatedAt: connector.rotatedAt?.toISOString() ?? null,
          revokedAt: connector.revokedAt?.toISOString() ?? null
        },
        receiptCounts: counts,
        pendingCount: pendingReceiptCount(counts),
        deadLetterCount: counts.DEAD_LETTER,
        oldestPendingAt: oldestPendingByConnector.get(connector.id)?.toISOString() ?? null,
        lastReceivedAt: timestamps?.receivedAt?.toISOString() ?? null,
        lastProcessedAt: timestamps?.processedAt?.toISOString() ?? null,
        lastDeadLetteredAt: timestamps?.deadLetteredAt?.toISOString() ?? null
      };
    })
  };
}

/** Cursor pagination uses immutable trusted receipt time plus id for a deterministic order. */
export async function listSupportIntakeDeadLetters(
  actor: RequestActor,
  input: SupportIntakeDeadLetterPageInput = {}
) {
  assertCanConfigureConnectors(actor);
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const cursor = decodeSupportIntakeDeadLetterCursor(input.cursor);
  const page = await prisma.supportIntakeReceipt.findMany({
    where: {
      workspaceId: actor.workspace.id,
      status: 'DEAD_LETTER',
      ...(input.connectorId ? { connectorId: input.connectorId } : {}),
      ...(cursor
        ? {
            OR: [
              { receivedAt: { lt: cursor.receivedAt } },
              { receivedAt: cursor.receivedAt, id: { lt: cursor.id } }
            ]
          }
        : {})
    },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: supportIntakeAdminReceiptSelect
  });
  const hasMore = page.length > limit;
  const rows = hasMore ? page.slice(0, limit) : page;
  const last = rows.at(-1);
  return {
    items: rows.map(serializeSupportIntakeAdminReceipt),
    nextCursor: hasMore && last
      ? encodeSupportIntakeDeadLetterCursor({ receivedAt: last.receivedAt, id: last.id })
      : null
  };
}

export async function getSupportIntakeDeadLetter(actor: RequestActor, receiptId: string) {
  assertCanConfigureConnectors(actor);
  const receipt = await prisma.supportIntakeReceipt.findFirst({
    where: {
      id: receiptId,
      workspaceId: actor.workspace.id,
      status: 'DEAD_LETTER'
    },
    select: supportIntakeAdminReceiptSelect
  });
  if (!receipt) throw new HttpError(404, 'Support intake dead letter not found');
  return serializeSupportIntakeAdminReceipt(receipt);
}

export async function retrySupportIntakeDeadLetter(
  actor: RequestActor,
  receiptId: string,
  now = new Date()
) {
  assertCanConfigureConnectors(actor);
  const receipt = await prisma.supportIntakeReceipt.findFirst({
    where: { id: receiptId, workspaceId: actor.workspace.id },
    select: {
      id: true,
      status: true,
      connectorId: true,
      payloadCiphertext: true,
      connector: { select: { status: true } }
    }
  });
  if (!receipt) throw new HttpError(404, 'Support intake receipt not found');
  if (receipt.status !== 'DEAD_LETTER') {
    throw new HttpError(409, 'Only a dead-lettered Support intake receipt can be retried');
  }
  if (receipt.connector.status !== 'ACTIVE') {
    throw new HttpError(409, 'A receipt from a revoked Support connector cannot be retried');
  }
  if (!receipt.payloadCiphertext) {
    throw new HttpError(409, 'The encrypted Support intake payload is no longer available');
  }

  const scheduled = await prisma.supportIntakeReceipt.updateMany({
    where: {
      id: receipt.id,
      workspaceId: actor.workspace.id,
      connectorId: receipt.connectorId,
      status: 'DEAD_LETTER',
      payloadCiphertext: { not: null },
      connector: { status: 'ACTIVE' }
    },
    data: {
      status: 'RETRY_PENDING',
      attemptCount: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      deadLetteredAt: null
    }
  });
  if (scheduled.count !== 1) {
    throw new HttpError(409, 'Support intake receipt retry state changed; refresh and try again');
  }
  return {
    receiptId: receipt.id,
    status: 'RETRY_PENDING' as const,
    scheduledAt: now.toISOString()
  };
}

/**
 * Authenticate over the exact bytes, then and only then parse JSON. The successful response means
 * the durable receipt exists—not that downstream Case mapping has already completed.
 */
export async function acceptSupportIntakeEvent(input: {
  lookupId: string;
  rawBody: Buffer;
  headers: IntakeAuthenticationHeaders;
  now?: Date;
}): Promise<AcceptedSupportIntake> {
  const now = input.now ?? new Date();
  const connector = await prisma.supportIntakeConnector.findUnique({
    where: { lookupId: input.lookupId },
    include: { workspace: { select: { id: true, mode: true } } }
  });
  if (!connector || connector.status !== 'ACTIVE' || connector.workspace.mode !== 'SUPPORT') {
    throw new HttpError(401, 'Invalid Support intake connector');
  }
  if (input.rawBody.byteLength > connector.maxPayloadBytes) {
    throw new HttpError(413, 'Support intake payload exceeds the connector limit');
  }

  const timestamp = parseAndAssertReplayTimestamp(
    input.headers.timestamp,
    connector.replayWindowSeconds,
    now
  );
  if (connector.signatureScheme !== 'HMAC_SHA256') {
    // Treat a legacy or manually-corrupted connector as an invalid credential. The public API
    // provisions only HMAC connectors and must not expose an implementation-detail 501 to an
    // unauthenticated intake caller.
    throw new HttpError(401, 'Invalid Support intake connector');
  }
  const secret = decryptSupportText(connector.secretCiphertext);
  assertHmacSignature(secret, input.headers.timestamp, input.rawBody, input.headers.signature);

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Support intake payload is not valid JSON');
  }
  const event = supportIntakeEventSchema.parse(decoded);
  const payloadHash = hashSupportPayload(input.rawBody);

  const replay = await findReceiptReplay(
    connector.id,
    input.headers.eventId,
    input.headers.idempotencyKey
  );
  if (replay) {
    return resolveReceiptReplay(connector, replay, payloadHash, input.headers.eventId);
  }

  const receivedLastMinute = await prisma.supportIntakeReceipt.count({
    where: {
      connectorId: connector.id,
      receivedAt: { gte: new Date(now.getTime() - 60_000) }
    }
  });
  if (receivedLastMinute >= connector.rateLimitPerMinute) {
    throw new HttpError(429, 'Support intake connector rate limit exceeded');
  }

  const encrypted = encryptSupportBytes(input.rawBody);
  try {
    const receipt = await prisma.supportIntakeReceipt.create({
      data: {
        workspaceId: connector.workspaceId,
        connectorId: connector.id,
        eventKey: input.headers.eventId,
        idempotencyKey: input.headers.idempotencyKey,
        payloadHash,
        payloadCiphertext: Uint8Array.from(encrypted.ciphertext),
        payloadEncryptionKeyId: encrypted.keyId,
        payloadRetentionUntil: new Date(now.getTime() + RECEIPT_PAYLOAD_RETENTION_MS),
        sourceOccurredAt: event.occurredAt ? new Date(event.occurredAt) : timestamp,
        sourceSequence: event.sourceSequence,
        receivedAt: now,
        nextAttemptAt: now
      }
    });
    return acceptedReceipt(connector.lookupId, receipt, false);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await findReceiptReplay(
      connector.id,
      input.headers.eventId,
      input.headers.idempotencyKey
    );
    if (!raced) throw error;
    return resolveReceiptReplay(connector, raced, payloadHash, input.headers.eventId);
  }
}

export async function readSupportIntakeReceiptStatus(input: {
  lookupId: string;
  receiptId: string;
  bearerSecret: string;
}) {
  const connector = await prisma.supportIntakeConnector.findUnique({
    where: { lookupId: input.lookupId }
  });
  if (
    !connector
    || connector.status !== 'ACTIVE'
    || !verifySupportConnectorSecret(input.bearerSecret, connector.secretHash)
  ) {
    throw new HttpError(401, 'Invalid Support intake connector');
  }
  const receipt = await prisma.supportIntakeReceipt.findFirst({
    where: { id: input.receiptId, connectorId: connector.id },
    select: {
      id: true,
      status: true,
      attemptCount: true,
      case: { select: { key: true } },
      lastErrorCode: true,
      receivedAt: true,
      processedAt: true,
      deadLetteredAt: true
    }
  });
  if (!receipt) throw new HttpError(404, 'Support intake receipt not found');
  return {
    receiptId: receipt.id,
    status: receipt.status,
    attempts: receipt.attemptCount,
    caseKey: receipt.case?.key ?? null,
    errorCode: receipt.status === 'DEAD_LETTER' ? receipt.lastErrorCode : null,
    receivedAt: receipt.receivedAt.toISOString(),
    processedAt: receipt.processedAt?.toISOString() ?? null,
    deadLetteredAt: receipt.deadLetteredAt?.toISOString() ?? null
  };
}

export async function runSupportIntakeWorkerTick(
  options: SupportIntakeWorkerOptions = {}
): Promise<{ claimed: number; processed: number; retried: number; deadLettered: number; outboxDelivered: number }> {
  const owner = options.owner ?? `support-worker-${randomUUID()}`;
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 20, 100));
  const claimed = await claimSupportIntakeReceipts(owner, now, leaseMs, batchSize);
  let processed = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const receipt of claimed) {
    try {
      await processClaimedReceipt(receipt, owner, now);
      processed += 1;
    } catch (error) {
      const terminal = receipt.attemptCount >= maxAttempts || isPermanentIntakeError(error);
      await failClaimedReceipt(receipt, owner, error, terminal, now);
      if (terminal) deadLettered += 1;
      else retried += 1;
    }
  }

  const outboxDelivered = await drainSupportOutbox({
    owner,
    now,
    leaseMs,
    batchSize,
    maxAttempts,
    handler: options.outboxHandler
  });
  await purgeExpiredSupportIntakePayloads(now);
  return { claimed: claimed.length, processed, retried, deadLettered, outboxDelivered };
}

export function startSupportIntakeWorker(
  options: Omit<SupportIntakeWorkerOptions, 'now'> & { intervalMs?: number } = {}
): SupportIntakeWorkerHandle {
  const owner = options.owner ?? `support-worker-${randomUUID()}`;
  if (!config.TASKARA_SUPPORT_INTAKE_WORKER_ENABLED) {
    return { owner, stop: async () => undefined };
  }
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;
  const run = () => {
    if (stopped || inFlight) return;
    inFlight = runSupportIntakeWorkerTick({ ...options, owner })
      .catch(() => undefined)
      .finally(() => { inFlight = null; });
  };
  const timer = setInterval(run, options.intervalMs ?? DEFAULT_TICK_MS);
  timer.unref?.();
  run();
  return {
    owner,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await releaseSupportWorkerLeases(owner);
    }
  };
}

export async function releaseSupportWorkerLeases(owner: string, now = new Date()): Promise<void> {
  await Promise.all([
    prisma.supportIntakeReceipt.updateMany({
      where: { leaseOwner: owner, status: 'PROCESSING' },
      data: {
        status: 'RETRY_PENDING',
        nextAttemptAt: now,
        leaseOwner: null,
        leaseExpiresAt: null
      }
    }),
    prisma.supportOutboxEvent.updateMany({
      where: { leaseOwner: owner, status: 'PROCESSING' },
      data: {
        status: 'RETRY_PENDING',
        nextAttemptAt: now,
        leaseOwner: null,
        leaseExpiresAt: null
      }
    })
  ]);
}

export function serializeSupportIntakeConnector(connector: SupportIntakeConnector) {
  return {
    id: connector.id,
    workspaceId: connector.workspaceId,
    name: connector.name,
    sourceKey: connector.sourceKey,
    sourceChannel: connector.sourceChannel,
    lookupId: connector.lookupId,
    secretVersion: connector.secretVersion,
    signatureScheme: connector.signatureScheme,
    status: connector.status,
    replayWindowSeconds: connector.replayWindowSeconds,
    maxPayloadBytes: connector.maxPayloadBytes,
    rateLimitPerMinute: connector.rateLimitPerMinute,
    rotatedAt: connector.rotatedAt?.toISOString() ?? null,
    revokedAt: connector.revokedAt?.toISOString() ?? null,
    createdAt: connector.createdAt.toISOString(),
    updatedAt: connector.updatedAt.toISOString()
  };
}

export function supportIntakeSignature(secret: string, timestamp: string, body: Buffer): string {
  return `v1=${createHmac('sha256', secret)
    .update(timestamp, 'utf8')
    .update('.', 'utf8')
    .update(body)
    .digest('hex')}`;
}

function assertCanConfigureConnectors(actor: RequestActor): void {
  assertSupportWorkspace(actor.workspace);
  if (actor.credential || !isWorkspaceAdminRole(actor.role)) {
    throw new HttpError(403, 'Workspace admin access required for Support connectors');
  }
}

function assertHmacSignature(secret: string, timestamp: string, body: Buffer, signature: string): void {
  const expected = supportIntakeSignature(secret, timestamp, body);
  if (!constantTimeTextEqual(expected.toLowerCase(), signature.toLowerCase())) {
    throw new HttpError(401, 'Invalid Support intake signature');
  }
}

function parseAndAssertReplayTimestamp(value: string, windowSeconds: number, now: Date): Date {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new HttpError(401, 'Invalid Support intake timestamp');
  const milliseconds = value.length === 13 ? numeric : numeric * 1_000;
  const timestamp = new Date(milliseconds);
  if (Math.abs(now.getTime() - timestamp.getTime()) > windowSeconds * 1_000) {
    throw new HttpError(401, 'Support intake timestamp is outside the replay window');
  }
  return timestamp;
}

async function findReceiptReplay(
  connectorId: string,
  eventKey: string,
  idempotencyKey?: string
): Promise<SupportIntakeReceipt | null> {
  return prisma.supportIntakeReceipt.findFirst({
    where: {
      connectorId,
      OR: [
        { eventKey },
        ...(idempotencyKey ? [{ idempotencyKey }] : [])
      ]
    },
    orderBy: { receivedAt: 'asc' }
  });
}

async function resolveReceiptReplay(
  connector: Pick<SupportIntakeConnector, 'id' | 'workspaceId' | 'lookupId'>,
  receipt: SupportIntakeReceipt,
  payloadHash: string,
  eventKey: string
): Promise<AcceptedSupportIntake> {
  if (constantTimeTextEqual(receipt.payloadHash, payloadHash)) {
    return acceptedReceipt(connector.lookupId, receipt, true);
  }
  await prisma.supportOutboxEvent.upsert({
    where: {
      workspaceId_dedupeKey: {
        workspaceId: connector.workspaceId,
        dedupeKey: `intake-security:${connector.id}:${receipt.id}:${payloadHash}`
      }
    },
    update: {},
    create: {
      workspaceId: connector.workspaceId,
      receiptId: receipt.id,
      topic: 'support.security.intake_payload_mismatch',
      aggregateType: 'support_intake_receipt',
      aggregateId: receipt.id,
      dedupeKey: `intake-security:${connector.id}:${receipt.id}:${payloadHash}`,
      payload: {
        connectorId: connector.id,
        receiptId: receipt.id,
        eventKeyHash: createHash('sha256').update(eventKey).digest('hex'),
        mismatchHash: payloadHash
      }
    }
  });
  throw new HttpError(409, 'Support intake event identifier was reused with different content');
}

function acceptedReceipt(
  lookupId: string,
  receipt: Pick<SupportIntakeReceipt, 'id' | 'status'>,
  replayed: boolean
): AcceptedSupportIntake {
  return {
    receiptId: receipt.id,
    status: receipt.status,
    replayed,
    location: `/support/intake/${lookupId}/receipts/${receipt.id}`
  };
}

async function claimSupportIntakeReceipts(
  owner: string,
  now: Date,
  leaseMs: number,
  batchSize: number
): Promise<SupportIntakeReceipt[]> {
  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH claimable AS (
      SELECT "id"
      FROM "SupportIntakeReceipt"
      WHERE (
        ("status" IN ('RECEIVED', 'RETRY_PENDING') AND "nextAttemptAt" <= ${now})
        OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < ${now})
      )
      ORDER BY "receivedAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "SupportIntakeReceipt" receipt
    SET "status" = 'PROCESSING',
        "attemptCount" = receipt."attemptCount" + 1,
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = ${new Date(now.getTime() + leaseMs)},
        "updatedAt" = CURRENT_TIMESTAMP
    FROM claimable
    WHERE receipt."id" = claimable."id"
    RETURNING receipt."id"
  `);
  if (!ids.length) return [];
  return prisma.supportIntakeReceipt.findMany({
    where: { id: { in: ids.map((row) => row.id) } },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }]
  });
}

async function processClaimedReceipt(receipt: SupportIntakeReceipt, owner: string, now: Date): Promise<void> {
  if (!receipt.payloadCiphertext) throw new PermanentIntakeError('INTAKE_PAYLOAD_UNAVAILABLE');
  const exactBytes = decryptSupportBytes(receipt.payloadCiphertext);
  if (!constantTimeTextEqual(hashSupportPayload(exactBytes), receipt.payloadHash)) {
    throw new PermanentIntakeError('INTAKE_PAYLOAD_INTEGRITY_FAILED');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(exactBytes.toString('utf8'));
  } catch {
    throw new PermanentIntakeError('INTAKE_PAYLOAD_INVALID_JSON');
  }
  const parsed = supportIntakeEventSchema.safeParse(decoded);
  if (!parsed.success) throw new PermanentIntakeError('INTAKE_PAYLOAD_INVALID');

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.supportIntakeReceipt.findFirst({
      where: { id: receipt.id, status: 'PROCESSING', leaseOwner: owner },
      include: { connector: true }
    });
    if (!claimed) throw new HttpError(409, 'Support intake lease was lost');
    const caseId = await applySupportIntakeEvent(tx, claimed, parsed.data);
    await tx.supportIntakeReceipt.update({
      where: { id: claimed.id },
      data: {
        status: 'PROCESSED',
        caseId,
        processedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });
    await tx.supportOutboxEvent.upsert({
      where: {
        workspaceId_dedupeKey: {
          workspaceId: claimed.workspaceId,
          dedupeKey: `support-intake-processed:${claimed.id}`
        }
      },
      update: {},
      create: {
        workspaceId: claimed.workspaceId,
        caseId,
        receiptId: claimed.id,
        topic: 'support.intake.processed',
        aggregateType: 'support_case',
        aggregateId: caseId,
        dedupeKey: `support-intake-processed:${claimed.id}`,
        payload: { caseId, receiptId: claimed.id }
      }
    });
  });
}

async function applySupportIntakeEvent(
  tx: Prisma.TransactionClient,
  receipt: SupportIntakeReceipt & { connector: SupportIntakeConnector },
  event: SupportIntakeEvent
): Promise<string> {
  let externalRef = await tx.supportExternalRef.findUnique({
    where: {
      connectorId_externalCaseId: {
        connectorId: receipt.connectorId,
        externalCaseId: event.externalCaseId
      }
    }
  });
  let supportCase = externalRef
    ? await tx.supportCase.findUnique({ where: { id: externalRef.caseId } })
    : null;
  let projectionChanged = false;

  // A terminal Case never receives new customer content implicitly. Move the external thread to a
  // fresh Case and keep the predecessor relation in both append-only event ledgers.
  const splitFromClosed = supportCase?.status === 'CLOSED' && Boolean(event.interaction);
  const previousClosedCase = splitFromClosed ? supportCase : null;
  if (!supportCase || splitFromClosed) {
    const contactId = await resolveConnectorContact(tx, receipt, event, externalRef?.contactId);
    const identity = await reserveConnectorCaseKey(tx, receipt.workspaceId);
    supportCase = await tx.supportCase.create({
      data: {
        workspaceId: receipt.workspaceId,
        ...identity,
        title: event.case.title,
        description: event.case.description,
        sourceChannel: receipt.connector.sourceChannel,
        typeKey: event.case.typeKey,
        priority: event.case.priority,
        impact: event.case.impact,
        urgency: event.case.urgency,
        status: 'NEW',
        contactId,
        receivedAt: receipt.receivedAt,
        lastMeaningfulActivityAt: receipt.receivedAt,
        lastCustomerActivityAt: event.interaction ? receipt.receivedAt : null
      }
    });
    projectionChanged = true;
    await lockCaseLedger(tx, supportCase.id);
    await appendConnectorCaseEvent(tx, supportCase.id, receipt, {
      action: previousClosedCase ? 'case.created_from_closed_followup' : 'case.created',
      after: { key: supportCase.key, status: supportCase.status, version: supportCase.version },
      reason: previousClosedCase ? `Prior closed Case ${previousClosedCase.key}` : undefined
    });
    await applySupportSlaCaseEvent(tx, {
      workspaceId: receipt.workspaceId,
      caseId: supportCase.id,
      event: 'CASE_CREATED',
      at: receipt.receivedAt
    });
    if (externalRef) {
      externalRef = await tx.supportExternalRef.update({
        where: { id: externalRef.id },
        data: {
          caseId: supportCase.id,
          contactId,
          sourceSequence: newerSourceSequence(event.sourceSequence, externalRef.sourceSequence)
            ? event.sourceSequence
            : externalRef.sourceSequence,
          metadata: previousClosedCase
            ? mergePrivateConfig(externalRef.metadata, { priorClosedCaseId: previousClosedCase.id })
            : undefined
        }
      });
      await lockCaseLedger(tx, previousClosedCase!.id);
      await appendConnectorCaseEvent(tx, previousClosedCase!.id, receipt, {
        action: 'case.closed_followup_split',
        after: { followupCaseKey: supportCase.key }
      });
    } else {
      externalRef = await tx.supportExternalRef.create({
        data: {
          workspaceId: receipt.workspaceId,
          connectorId: receipt.connectorId,
          caseId: supportCase.id,
          contactId,
          externalCaseId: event.externalCaseId,
          externalContactId: event.case.contact?.externalCustomerId,
          sourceSequence: event.sourceSequence
        }
      });
    }
  } else {
    await lockCaseLedger(tx, supportCase.id);
    if (newerSourceSequence(event.sourceSequence, externalRef?.sourceSequence)) {
      const before = {
        status: supportCase.status,
        typeKey: supportCase.typeKey,
        priority: supportCase.priority,
        impact: supportCase.impact,
        urgency: supportCase.urgency,
        version: supportCase.version
      };
      supportCase = await tx.supportCase.update({
        where: { id: supportCase.id },
        data: {
          title: event.case.title,
          description: event.case.description,
          typeKey: event.case.typeKey,
          // Priority/impact/urgency may be corrected by a source snapshot, but lifecycle and all
          // routing/SLA facts remain owned by Taskara staff commands.
          priority: event.case.priority,
          impact: event.case.impact,
          urgency: event.case.urgency,
          version: { increment: 1 }
        }
      });
      projectionChanged = true;
      await appendConnectorCaseEvent(tx, supportCase.id, receipt, {
        action: 'case.source_snapshot_updated',
        before,
        after: {
          status: supportCase.status,
          typeKey: supportCase.typeKey,
          priority: supportCase.priority,
          impact: supportCase.impact,
          urgency: supportCase.urgency,
          version: supportCase.version
        }
      });
      externalRef = await tx.supportExternalRef.update({
        where: { id: externalRef!.id },
        data: { sourceSequence: event.sourceSequence }
      });
    }
  }

  if (!event.interaction) {
    if (projectionChanged) await appendIntakeCaseSyncEvent(tx, receipt, supportCase);
    return supportCase.id;
  }
  const duplicateInteraction = await tx.supportInteraction.findUnique({
    where: {
      connectorId_externalId: {
        connectorId: receipt.connectorId,
        externalId: event.interaction.externalId
      }
    },
    select: { id: true }
  });
  if (duplicateInteraction) {
    if (projectionChanged) await appendIntakeCaseSyncEvent(tx, receipt, supportCase);
    return supportCase.id;
  }

  const occurredAt = event.interaction.occurredAt
    ? new Date(event.interaction.occurredAt)
    : event.occurredAt
      ? new Date(event.occurredAt)
      : receipt.receivedAt;
  const contentHash = event.interaction.body
    ? createHash('sha256').update(event.interaction.body, 'utf8').digest('hex')
    : null;
  const interaction = await tx.supportInteraction.create({
    data: {
      workspaceId: receipt.workspaceId,
      caseId: supportCase.id,
      connectorId: receipt.connectorId,
      kind: event.interaction.kind,
      visibility: 'PUBLIC',
      channel: receipt.connector.sourceChannel,
      direction: 'INBOUND',
      contactId: supportCase.contactId,
      externalId: event.interaction.externalId,
      occurredAt,
      receivedAt: receipt.receivedAt,
      contentHash
    }
  });
  if (event.interaction.body) {
    const encrypted = encryptSupportBytes(Buffer.from(event.interaction.body, 'utf8'));
    await tx.supportInteractionContent.create({
      data: {
        interactionId: interaction.id,
        bodyCiphertext: Uint8Array.from(encrypted.ciphertext),
        bodyHash: contentHash!,
        format: event.interaction.format,
        encryptionKeyId: encrypted.keyId
      }
    });
  }
  if (event.call) {
    const callbackOwnerId = event.call.callbackDueAt
      ? await configuredCallbackOwnerId(tx, receipt)
      : null;
    await tx.supportCallDetail.create({
      data: {
        interactionId: interaction.id,
        workspaceId: receipt.workspaceId,
        direction: 'INBOUND',
        disposition: event.call.disposition,
        startedAt: new Date(event.call.startedAt),
        answeredAt: event.call.answeredAt ? new Date(event.call.answeredAt) : undefined,
        endedAt: event.call.endedAt ? new Date(event.call.endedAt) : undefined,
        durationSeconds: event.call.durationSeconds,
        recordingConsent: event.call.recordingConsent,
        recordingExists: event.call.recordingExists,
        callbackOwnerId: callbackOwnerId ?? undefined,
        callbackDueAt: callbackOwnerId && event.call.callbackDueAt
          ? new Date(event.call.callbackDueAt)
          : undefined,
        externalCallId: event.call.externalCallId
      }
    });
  }

  const nextStatus = supportCase.status === 'WAITING_ON_CUSTOMER'
    ? (supportCase.departmentId ? 'OPEN' : 'NEW')
    : supportCase.status === 'RESOLVED'
      ? (supportCase.departmentId ? 'OPEN' : 'NEW')
      : supportCase.status;
  const reopened = supportCase.status === 'RESOLVED';
  const meaningfulAt = receipt.receivedAt > supportCase.lastMeaningfulActivityAt
    ? receipt.receivedAt
    : supportCase.lastMeaningfulActivityAt;
  const customerAt = !supportCase.lastCustomerActivityAt || receipt.receivedAt > supportCase.lastCustomerActivityAt
    ? receipt.receivedAt
    : supportCase.lastCustomerActivityAt;
  const updated = await tx.supportCase.update({
    where: { id: supportCase.id },
    data: {
      status: nextStatus,
      waitingReason: nextStatus === supportCase.status ? undefined : null,
      nextActionAt: nextStatus === supportCase.status ? undefined : null,
      lastCustomerActivityAt: customerAt,
      lastMeaningfulActivityAt: meaningfulAt,
      // A missed/abandoned call with no configured human callback owner still becomes actionable
      // in Triage through the Case's next-action clock; it is never dropped merely because routing
      // has not happened yet.
      ...(event.call?.callbackDueAt && !supportCase.nextActionAt
        ? { nextActionAt: new Date(event.call.callbackDueAt) }
        : {}),
      ...(reopened
        ? {
            resolutionCode: null,
            resolutionSummary: null,
            duplicateOfCaseId: null,
            resolvedAt: null,
            closedAt: null,
            reopenedAt: receipt.receivedAt,
            reopenCount: { increment: 1 }
          }
        : {}),
      version: { increment: 1 }
    }
  });
  await appendConnectorCaseEvent(tx, updated.id, receipt, {
    action: reopened ? 'case.reopened_by_customer' : 'case.customer_interaction_received',
    after: {
      status: updated.status,
      version: updated.version,
      interactionId: interaction.id,
      kind: interaction.kind,
      channel: interaction.channel
    }
  });
  await applySupportSlaCaseEvent(tx, {
    workspaceId: receipt.workspaceId,
    caseId: updated.id,
    event: reopened ? 'REOPENED' : 'CUSTOMER_ACTIVITY',
    at: receipt.receivedAt
  });
  if (reopened) {
    await applySupportCaseSignalToTaskLinksWithProvenance(tx, {
      actorId: null,
      actorType: 'SYSTEM',
      actorRuntime: null,
      source: 'SYSTEM'
    }, supportCase, updated);
  }
  await appendIntakeCaseSyncEvent(tx, receipt, updated);
  return updated.id;
}

async function appendIntakeCaseSyncEvent(
  tx: Prisma.TransactionClient,
  receipt: Pick<SupportIntakeReceipt, 'workspaceId'>,
  supportCase: { id: string; version: number }
): Promise<void> {
  await appendSupportCaseSyncEvent(tx, {
    workspaceId: receipt.workspaceId,
    caseId: supportCase.id,
    caseVersion: supportCase.version,
    operation: 'upsert'
  });
}

async function configuredCallbackOwnerId(
  tx: Prisma.TransactionClient,
  receipt: SupportIntakeReceipt & { connector: SupportIntakeConnector }
): Promise<string | null> {
  const configValue = receipt.connector.config;
  const candidate = configValue && typeof configValue === 'object' && !Array.isArray(configValue)
    ? (configValue as Prisma.JsonObject).callbackOwnerId
    : null;
  if (typeof candidate !== 'string' || !isUuid(candidate)) return null;
  const member = await tx.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: receipt.workspaceId, userId: candidate }
    },
    select: { userId: true }
  });
  return member?.userId ?? null;
}

async function resolveConnectorContact(
  tx: Prisma.TransactionClient,
  receipt: SupportIntakeReceipt & { connector: SupportIntakeConnector },
  event: SupportIntakeEvent,
  existingContactId?: string | null
): Promise<string | null> {
  if (existingContactId) return existingContactId;
  const contact = event.case.contact;
  if (!contact) return null;
  if (contact.externalCustomerId) {
    const authoritative = await tx.supportExternalRef.findFirst({
      where: {
        connectorId: receipt.connectorId,
        externalContactId: contact.externalCustomerId,
        contactId: { not: null }
      },
      select: { contactId: true }
    });
    if (authoritative?.contactId) return authoritative.contactId;
  }
  // Phone/email are deliberately not merge keys. They are candidate-search fields for a human;
  // only the source connector's external customer id is authoritative enough to deduplicate.
  return (await tx.supportContact.create({
    data: {
      workspaceId: receipt.workspaceId,
      name: contact.name,
      email: contact.email,
      normalizedEmail: contact.email?.toLowerCase(),
      phone: contact.phone,
      normalizedPhone: contact.phone?.replace(/[^+\d]/g, ''),
      metadata: contact.externalCustomerId
        ? { connectorId: receipt.connectorId, externalCustomerId: contact.externalCustomerId }
        : undefined
    },
    select: { id: true }
  })).id;
}

async function reserveConnectorCaseKey(
  tx: Prisma.TransactionClient,
  workspaceId: string
): Promise<{ key: string; sequence: number }> {
  const workspace = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { slug: true, mode: true }
  });
  if (workspace.mode !== 'SUPPORT') throw new PermanentIntakeError('INTAKE_WORKSPACE_MODE_INVALID');
  return reserveSupportCaseKey(tx, { id: workspaceId, slug: workspace.slug });
}

async function lockCaseLedger(tx: Prisma.TransactionClient, caseId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`support-case:${caseId}`}))`);
}

async function appendConnectorCaseEvent(
  tx: Prisma.TransactionClient,
  caseId: string,
  receipt: Pick<SupportIntakeReceipt, 'id' | 'workspaceId'>,
  input: { action: string; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; reason?: string }
): Promise<void> {
  await appendSupportCaseSystemEvent(tx, { id: caseId, workspaceId: receipt.workspaceId }, {
    source: 'CONNECTOR',
    correlationId: receipt.id,
    idempotencyKey: receipt.id,
    action: input.action,
    before: input.before,
    after: input.after,
    reason: input.reason
  });
}

function newerSourceSequence(incoming?: string, current?: string | null): boolean {
  if (incoming === undefined) return current == null;
  if (current == null) return true;
  return BigInt(incoming) > BigInt(current);
}

async function failClaimedReceipt(
  receipt: SupportIntakeReceipt,
  owner: string,
  error: unknown,
  terminal: boolean,
  now: Date
): Promise<void> {
  const code = intakeErrorCode(error);
  await prisma.supportIntakeReceipt.updateMany({
    where: { id: receipt.id, status: 'PROCESSING', leaseOwner: owner },
    data: terminal
      ? {
          status: 'DEAD_LETTER',
          deadLetteredAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: code,
          lastErrorMessage: safeIntakeErrorMessage(code)
        }
      : {
          status: 'RETRY_PENDING',
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(receipt.attemptCount)),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: code,
          lastErrorMessage: safeIntakeErrorMessage(code)
        }
  });
}

async function drainSupportOutbox(input: {
  owner: string;
  now: Date;
  leaseMs: number;
  batchSize: number;
  maxAttempts: number;
  handler?: (event: SupportOutboxEvent) => Promise<void>;
}): Promise<number> {
  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH claimable AS (
      SELECT "id"
      FROM "SupportOutboxEvent"
      WHERE (
        ("status" IN ('PENDING', 'RETRY_PENDING') AND "nextAttemptAt" <= ${input.now})
        OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < ${input.now})
      )
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.batchSize}
    )
    UPDATE "SupportOutboxEvent" event
    SET "status" = 'PROCESSING',
        "attemptCount" = event."attemptCount" + 1,
        "leaseOwner" = ${input.owner},
        "leaseExpiresAt" = ${new Date(input.now.getTime() + input.leaseMs)},
        "updatedAt" = CURRENT_TIMESTAMP
    FROM claimable
    WHERE event."id" = claimable."id"
    RETURNING event."id"
  `);
  if (!ids.length) return 0;
  const events = await prisma.supportOutboxEvent.findMany({
    where: { id: { in: ids.map((row) => row.id) } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
  let delivered = 0;
  for (const event of events) {
    try {
      if (input.handler) await input.handler(event);
      else if (!['support.intake.processed', 'support.security.intake_payload_mismatch'].includes(event.topic)) {
        throw new Error('No Support outbox handler registered');
      }
      await prisma.supportOutboxEvent.updateMany({
        where: { id: event.id, status: 'PROCESSING', leaseOwner: input.owner },
        data: {
          status: 'DELIVERED',
          deliveredAt: input.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null
        }
      });
      delivered += 1;
    } catch {
      const terminal = event.attemptCount >= input.maxAttempts;
      await prisma.supportOutboxEvent.updateMany({
        where: { id: event.id, status: 'PROCESSING', leaseOwner: input.owner },
        data: terminal
          ? {
              status: 'DEAD_LETTER',
              deadLetteredAt: input.now,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: 'OUTBOX_DELIVERY_FAILED',
              lastErrorMessage: 'Support outbox delivery failed'
            }
          : {
              status: 'RETRY_PENDING',
              nextAttemptAt: new Date(input.now.getTime() + retryDelayMs(event.attemptCount)),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: 'OUTBOX_DELIVERY_FAILED',
              lastErrorMessage: 'Support outbox delivery failed'
            }
      });
    }
  }
  return delivered;
}

async function purgeExpiredSupportIntakePayloads(now: Date): Promise<void> {
  await prisma.supportIntakeReceipt.updateMany({
    where: {
      payloadRetentionUntil: { lte: now },
      status: { in: ['PROCESSED', 'REJECTED', 'DEAD_LETTER'] },
      payloadCiphertext: { not: null }
    },
    data: {
      payloadCiphertext: null,
      payloadEncryptionKeyId: null,
      payloadRef: null
    }
  });
}

class PermanentIntakeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function isPermanentIntakeError(error: unknown): boolean {
  return error instanceof PermanentIntakeError;
}

function intakeErrorCode(error: unknown): string {
  if (error instanceof PermanentIntakeError) return error.code;
  if (error instanceof HttpError && error.statusCode === 409) return 'INTAKE_LEASE_OR_VERSION_CONFLICT';
  if (isUniqueConstraintError(error)) return 'INTAKE_DUPLICATE_CONFLICT';
  return 'INTAKE_PROCESSING_FAILED';
}

function safeIntakeErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    INTAKE_PAYLOAD_UNAVAILABLE: 'Encrypted intake payload is unavailable',
    INTAKE_PAYLOAD_INTEGRITY_FAILED: 'Encrypted intake payload failed integrity verification',
    INTAKE_PAYLOAD_INVALID_JSON: 'Intake payload is not valid JSON',
    INTAKE_PAYLOAD_INVALID: 'Intake payload does not match the connector contract',
    INTAKE_WORKSPACE_MODE_INVALID: 'Connector workspace is not a Support workspace',
    INTAKE_LEASE_OR_VERSION_CONFLICT: 'Intake processing lost its lease or encountered a version conflict',
    INTAKE_DUPLICATE_CONFLICT: 'Intake processing encountered a duplicate identity',
    INTAKE_PROCESSING_FAILED: 'Intake processing failed and will be retried'
  };
  return messages[code] ?? 'Intake processing failed';
}

const supportIntakeAdminReceiptSelect = {
  id: true,
  status: true,
  attemptCount: true,
  lastErrorCode: true,
  receivedAt: true,
  processedAt: true,
  deadLetteredAt: true,
  updatedAt: true,
  connector: {
    select: {
      id: true,
      name: true,
      sourceChannel: true,
      status: true
    }
  },
  case: {
    select: {
      id: true,
      key: true
    }
  }
} satisfies Prisma.SupportIntakeReceiptSelect;

type SupportIntakeAdminReceipt = Prisma.SupportIntakeReceiptGetPayload<{
  select: typeof supportIntakeAdminReceiptSelect;
}>;

function serializeSupportIntakeAdminReceipt(receipt: SupportIntakeAdminReceipt) {
  const errorCode = publicIntakeErrorCode(receipt.lastErrorCode);
  return {
    receiptId: receipt.id,
    connector: receipt.connector,
    case: receipt.case,
    status: receipt.status,
    attempts: receipt.attemptCount,
    error: errorCode
      ? { code: errorCode, message: safeIntakeErrorMessage(errorCode) }
      : null,
    receivedAt: receipt.receivedAt.toISOString(),
    processedAt: receipt.processedAt?.toISOString() ?? null,
    deadLetteredAt: receipt.deadLetteredAt?.toISOString() ?? null,
    updatedAt: receipt.updatedAt.toISOString()
  };
}

function publicIntakeErrorCode(code: string | null): string | null {
  if (!code) return null;
  return PUBLIC_INTAKE_ERROR_CODES.has(code) ? code : 'INTAKE_PROCESSING_FAILED';
}

function emptySupportIntakeReceiptCounts(): Record<(typeof SUPPORT_INTAKE_RECEIPT_STATUSES)[number], number> {
  return {
    RECEIVED: 0,
    PROCESSING: 0,
    RETRY_PENDING: 0,
    PROCESSED: 0,
    REJECTED: 0,
    DEAD_LETTER: 0
  };
}

function pendingReceiptCount(counts: ReturnType<typeof emptySupportIntakeReceiptCounts>): number {
  return counts.RECEIVED + counts.PROCESSING + counts.RETRY_PENDING;
}

function encodeSupportIntakeDeadLetterCursor(input: { receivedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({
    receivedAt: input.receivedAt.toISOString(),
    id: input.id
  }), 'utf8').toString('base64url');
}

function decodeSupportIntakeDeadLetterCursor(
  cursor?: string
): { receivedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      receivedAt?: unknown;
      id?: unknown;
    };
    if (typeof decoded.receivedAt !== 'string' || typeof decoded.id !== 'string' || !isUuid(decoded.id)) {
      throw new Error('invalid cursor fields');
    }
    const receivedAt = new Date(decoded.receivedAt);
    if (!Number.isFinite(receivedAt.getTime()) || receivedAt.toISOString() !== decoded.receivedAt) {
      throw new Error('invalid cursor timestamp');
    }
    return { receivedAt, id: decoded.id };
  } catch {
    throw new HttpError(400, 'Invalid Support intake dead-letter cursor');
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 10));
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mergePrivateConfig(
  existing: Prisma.JsonValue,
  extra: Record<string, Prisma.InputJsonValue>
): Prisma.InputJsonObject {
  const current = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Prisma.JsonObject
    : {};
  return { ...current, ...extra };
}
