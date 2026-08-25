import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { prisma, type Prisma, type SyncEvent } from '@taskara/db';
import { HttpError } from './http';
import { appendSyncEvent, type SyncMutationMeta } from './sync';
import type { SupportAccess } from './support-access';

const CURSOR_VERSION = 'ssc1';
const CURSOR_IV_BYTES = 12;
// Support v1 is deliberately memory-only. A process restart invalidates cursors and causes a safe
// bootstrap; no long-lived cursor secret or peer-visible numeric sequence reaches the browser.
const cursorKey = randomBytes(32);

export interface SupportCursorFacts {
  workspaceId: string;
  userId: string;
  accessEpoch: string;
  workspaceSeq: bigint;
}

export interface SupportSyncEventPayload {
  removedUserIds?: string[];
}

export type SupportSyncWakeup =
  | { type: 'sync'; accessEpoch: string }
  | { type: 'scopeReset'; accessEpoch: string };

export interface SupportSyncStreamClient {
  id: string;
  workspaceId: string;
  userId: string;
  accessEpoch: bigint;
  workspaceSeq: bigint;
  resolveAccess: () => Promise<SupportAccess>;
  send: (wakeup: SupportSyncWakeup) => void;
  scopeResetSent?: boolean;
}

/** A separate audience hub: unlike Team sync, it has no workspace-broadcast operation. */
export class SupportSyncHub {
  private readonly clients = new Map<string, SupportSyncStreamClient>();

  add(client: SupportSyncStreamClient): () => void {
    this.clients.set(client.id, client);
    return () => { this.clients.delete(client.id); };
  }

  activeClients(): SupportSyncStreamClient[] {
    return [...this.clients.values()];
  }

  count(): number {
    return this.clients.size;
  }
}

export const supportSyncHub = new SupportSyncHub();

export async function appendSupportCaseSyncEvent(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    caseId: string;
    caseVersion: number;
    operation: 'upsert' | 'route' | 'remove';
    actorId?: string | null;
    removedUserIds?: Iterable<string>;
    mutation?: SyncMutationMeta;
  }
) {
  return appendSyncEvent(tx, {
    workspaceId: input.workspaceId,
    entityType: 'support_case',
    entityId: input.caseId,
    operation: input.operation,
    entityVersion: input.caseVersion,
    actorId: input.actorId,
    // Only audience routing metadata is stored in the workspace-internal event. Case/contact/body
    // content is fetched through supportCaseWhereForAccess at pull time.
    payload: {
      removedUserIds: [...new Set(input.removedUserIds ?? [])]
    },
    mutation: input.mutation
  });
}

export async function appendSupportDepartmentSyncEvent(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    departmentId: string;
    operation: 'upsert' | 'remove';
    actorId?: string | null;
  }
) {
  return appendSyncEvent(tx, {
    workspaceId: input.workspaceId,
    entityType: 'support_department',
    entityId: input.departmentId,
    operation: input.operation,
    actorId: input.actorId,
    payload: {}
  });
}

export async function latestSupportCursor(input: {
  workspaceId: string;
  userId: string;
  accessEpoch: bigint;
}, client: Pick<Prisma.TransactionClient, 'workspaceSyncState'> = prisma): Promise<string> {
  const state = await client.workspaceSyncState.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { nextSeq: true }
  });
  return sealSupportCursor({
    workspaceId: input.workspaceId,
    userId: input.userId,
    accessEpoch: input.accessEpoch.toString(),
    workspaceSeq: (state?.nextSeq ?? 1n) - 1n
  });
}

export function assertSupportAccessEpoch(
  supplied: string | undefined,
  current: bigint
): void {
  if (supplied === current.toString()) return;
  throw supportScopeChanged(current);
}

export function supportScopeChanged(current: bigint): HttpError {
  return new HttpError(409, 'Support access scope changed', {
    code: 'SUPPORT_SCOPE_CHANGED',
    accessEpoch: current.toString()
  });
}

export function sealSupportCursor(input: SupportCursorFacts): string {
  const iv = randomBytes(CURSOR_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', cursorKey, iv);
  const plaintext = Buffer.from(JSON.stringify({
    workspaceId: input.workspaceId,
    userId: input.userId,
    accessEpoch: input.accessEpoch,
    workspaceSeq: input.workspaceSeq.toString()
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    CURSOR_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url')
  ].join('.');
}

export function openSupportCursor(
  cursor: string,
  expected: { workspaceId: string; userId: string; accessEpoch: bigint }
): SupportCursorFacts {
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, ...rest] = cursor.split('.');
    if (
      version !== CURSOR_VERSION
      || !encodedIv
      || !encodedTag
      || encodedCiphertext === undefined
      || rest.length
    ) throw new Error('invalid cursor envelope');
    const decipher = createDecipheriv('aes-256-gcm', cursorKey, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    const decoded = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final()
    ]).toString('utf8')) as Record<string, unknown>;
    if (
      decoded.workspaceId !== expected.workspaceId
      || decoded.userId !== expected.userId
      || decoded.accessEpoch !== expected.accessEpoch.toString()
      || typeof decoded.workspaceSeq !== 'string'
      || !/^\d+$/.test(decoded.workspaceSeq)
    ) throw new Error('cursor audience mismatch');
    return {
      workspaceId: expected.workspaceId,
      userId: expected.userId,
      accessEpoch: expected.accessEpoch.toString(),
      workspaceSeq: BigInt(decoded.workspaceSeq)
    };
  } catch {
    throw new HttpError(409, 'Support sync cursor is no longer valid', {
      code: 'SUPPORT_CURSOR_RESET_REQUIRED',
      accessEpoch: expected.accessEpoch.toString()
    });
  }
}

export function supportSyncEventPayload(value: Prisma.JsonValue): SupportSyncEventPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const removed = (value as Prisma.JsonObject).removedUserIds;
  return {
    removedUserIds: Array.isArray(removed)
      ? removed.filter((item): item is string => typeof item === 'string')
      : []
  };
}

/**
 * Advances each private stream position over every internal event, but emits a wakeup only when
 * that user can observe one. The wakeup itself carries no workspace sequence, entity type, id, or
 * payload; the sealed pull cursor remains the only resumption token.
 */
export async function pollSupportSyncWakeups(
  hub: SupportSyncHub = supportSyncHub,
  batchSize = 200
): Promise<void> {
  const take = Math.max(1, Math.min(batchSize, 500));
  for (const client of hub.activeClients()) {
    try {
      await pollSupportSyncClient(client, take);
    } catch {
      // One disconnected/deleted audience or transient query must not prevent other users from
      // receiving their targeted wakeups. The next interval retries this client's private scan.
    }
  }
}

async function pollSupportSyncClient(client: SupportSyncStreamClient, take: number): Promise<void> {
  const access = await client.resolveAccess();
  if (access.epoch !== client.accessEpoch) {
    if (!client.scopeResetSent) {
      client.scopeResetSent = true;
      client.send({ type: 'scopeReset', accessEpoch: access.epoch.toString() });
    }
    return;
  }

  const events = await prisma.syncEvent.findMany({
    where: {
      workspaceId: client.workspaceId,
      workspaceSeq: { gt: client.workspaceSeq }
    },
    orderBy: { workspaceSeq: 'asc' },
    take
  });
  if (!events.length) return;

  let visible = false;
  for (const event of events) {
    if (await supportSyncEventVisibleTo(event, access)) visible = true;
  }
  // The private server-side scan point advances over peer events too. A peer-only page therefore
  // neither wakes this reader nor stalls and gets inspected again forever.
  client.workspaceSeq = events.at(-1)!.workspaceSeq;
  if (visible) client.send({ type: 'sync', accessEpoch: access.epoch.toString() });
}

let supportSyncPollerStarted = false;

export function startSupportSyncWakeupPoller(intervalMilliseconds = 2_000): void {
  if (supportSyncPollerStarted) return;
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error('Support sync poll interval must be a positive integer');
  }
  supportSyncPollerStarted = true;
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void pollSupportSyncWakeups()
      .catch(() => undefined)
      .finally(() => { polling = false; });
  }, intervalMilliseconds).unref?.();
}

async function supportSyncEventVisibleTo(event: SyncEvent, access: SupportAccess): Promise<boolean> {
  const payload = supportSyncEventPayload(event.payload);
  if (payload.removedUserIds?.includes(access.userId)) return true;

  const caseId = supportCaseIdForEvent(event);
  if (caseId) {
    return (await prisma.supportCase.count({
      where: {
        AND: [
          supportCaseAccessWhere(access),
          // A close event removes the Case from the hot in-memory store. Readers who can still
          // authorize the now-closed aggregate must be woken so pull can deliver that tombstone;
          // filtering CLOSED here would leave the stale Case cached until an unrelated event.
          event.operation === 'remove'
            ? { id: caseId }
            : { id: caseId, status: { not: 'CLOSED' } }
        ]
      }
    })) > 0;
  }

  if (event.entityType === 'support_department') {
    return (await prisma.department.count({
      where: {
        id: event.entityId,
        workspaceId: access.workspaceId,
        active: true,
        ...(access.workspaceWide || access.triager
          ? {}
          : {
              OR: [
                ...(access.managedDepartmentIds.length
                  ? [{ id: { in: access.managedDepartmentIds } }]
                  : []),
                ...(access.memberMembershipIds.length
                  ? [{ members: { some: { id: { in: access.memberMembershipIds }, active: true } } }]
                  : [])
              ]
            })
      }
    })) > 0;
  }
  return false;
}

function supportCaseAccessWhere(access: SupportAccess): Prisma.SupportCaseWhereInput {
  if (access.workspaceWide) return { workspaceId: access.workspaceId };
  const alternatives: Prisma.SupportCaseWhereInput[] = [];
  if (access.triager) alternatives.push({ departmentId: null });
  if (access.managedDepartmentIds.length) {
    alternatives.push({ departmentId: { in: access.managedDepartmentIds } });
  }
  if (access.memberMembershipIds.length) {
    alternatives.push({ assigneeMembershipId: { in: access.memberMembershipIds } });
  }
  return alternatives.length
    ? { workspaceId: access.workspaceId, OR: alternatives }
    : { workspaceId: access.workspaceId, id: { in: [] } };
}

export function supportCaseIdForEvent(event: Pick<SyncEvent, 'entityType' | 'entityId' | 'payload'>): string | null {
  if (event.entityType === 'support_case') return event.entityId;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  const payload = event.payload as Prisma.JsonObject;
  for (const key of ['supportCaseId', 'caseId']) {
    if (typeof payload[key] === 'string') return payload[key] as string;
  }
  return null;
}
