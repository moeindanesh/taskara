import { prisma, type Prisma, type SyncEvent } from '@taskara/db';

export interface SyncMutationMeta {
  clientId: string;
  mutationId: string;
  mutationName: string;
  userId: string;
}

export interface AppendSyncEventInput {
  workspaceId: string;
  entityType: string;
  entityId: string;
  operation: string;
  entityVersion?: number | null;
  actorId?: string | null;
  clientId?: string | null;
  mutationId?: string | null;
  payload: unknown;
  mutation?: SyncMutationMeta;
}

export interface SyncPoke {
  workspaceId: string;
  cursor: string;
  entityTypes: string[];
  clientId?: string | null;
  mutationId?: string | null;
}

export interface SyncStreamClient {
  id: string;
  workspaceId: string;
  userId: string;
  clientId?: string;
  send: (poke: SyncPoke) => void;
}

class SyncHub {
  private clients = new Map<string, Map<string, SyncStreamClient>>();
  private latestPublishedCursor = new Map<string, bigint>();

  add(client: SyncStreamClient): () => void {
    const workspaceClients = this.clients.get(client.workspaceId) ?? new Map<string, SyncStreamClient>();
    workspaceClients.set(client.id, client);
    this.clients.set(client.workspaceId, workspaceClients);

    return () => {
      const current = this.clients.get(client.workspaceId);
      if (!current) return;
      current.delete(client.id);
      if (current.size === 0) this.clients.delete(client.workspaceId);
    };
  }

  publish(poke: SyncPoke): void {
    const workspaceClients = this.clients.get(poke.workspaceId);
    this.latestPublishedCursor.set(poke.workspaceId, BigInt(poke.cursor));
    if (!workspaceClients) return;

    for (const client of workspaceClients.values()) {
      client.send(poke);
    }
  }

  count(workspaceId?: string): number {
    if (workspaceId) return this.clients.get(workspaceId)?.size ?? 0;
    let count = 0;
    for (const clients of this.clients.values()) count += clients.size;
    return count;
  }

  activeWorkspaceIds(): string[] {
    return [...this.clients.keys()];
  }

  latestCursor(workspaceId: string): bigint {
    return this.latestPublishedCursor.get(workspaceId) ?? BigInt(0);
  }
}

export const syncHub = new SyncHub();

let syncPollerStarted = false;

export function startSyncEventPoller(intervalMs = 2000): void {
  if (syncPollerStarted) return;
  syncPollerStarted = true;

  setInterval(() => {
    void pollSyncEventsForActiveStreams();
  }, intervalMs).unref?.();
}

export async function appendSyncEvent(
  tx: Prisma.TransactionClient,
  input: AppendSyncEventInput
): Promise<SyncEvent> {
  const workspaceSeq = await reserveWorkspaceSeq(tx, input.workspaceId);
  const event = await tx.syncEvent.create({
    data: {
      workspaceId: input.workspaceId,
      workspaceSeq,
      entityType: input.entityType,
      entityId: input.entityId,
      operation: input.operation,
      entityVersion: input.entityVersion ?? undefined,
      actorId: input.actorId ?? undefined,
      clientId: input.clientId ?? input.mutation?.clientId,
      mutationId: input.mutationId ?? input.mutation?.mutationId,
      payload: toJsonValue(input.payload)
    }
  });

  if (input.mutation) {
    await tx.clientMutation.upsert({
      where: {
        workspaceId_clientId_mutationId: {
          workspaceId: input.workspaceId,
          clientId: input.mutation.clientId,
          mutationId: input.mutation.mutationId
        }
      },
      update: {
        name: input.mutation.mutationName,
        status: 'APPLIED',
        resultWorkspaceSeq: workspaceSeq,
        errorCode: null,
        errorMessage: null
      },
      create: {
        workspaceId: input.workspaceId,
        userId: input.mutation.userId,
        clientId: input.mutation.clientId,
        mutationId: input.mutation.mutationId,
        name: input.mutation.mutationName,
        status: 'APPLIED',
        resultWorkspaceSeq: workspaceSeq
      }
    });
  }

  return event;
}

export function publishSyncEvent(event: Pick<SyncEvent, 'workspaceId' | 'workspaceSeq' | 'entityType' | 'clientId' | 'mutationId'>): void {
  syncHub.publish({
    workspaceId: event.workspaceId,
    cursor: event.workspaceSeq.toString(),
    entityTypes: [event.entityType],
    clientId: event.clientId,
    mutationId: event.mutationId
  });
}

async function pollSyncEventsForActiveStreams(): Promise<void> {
  const workspaceIds = syncHub.activeWorkspaceIds();
  if (workspaceIds.length === 0) return;

  for (const workspaceId of workspaceIds) {
    const latest = await prisma.syncEvent.findFirst({
      where: { workspaceId },
      orderBy: { workspaceSeq: 'desc' },
      select: { workspaceSeq: true, entityType: true }
    });
    if (!latest || latest.workspaceSeq <= syncHub.latestCursor(workspaceId)) continue;

    syncHub.publish({
      workspaceId,
      cursor: latest.workspaceSeq.toString(),
      entityTypes: [latest.entityType]
    });
  }
}

export function serializeSyncEvent(event: SyncEvent) {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    workspaceSeq: event.workspaceSeq.toString(),
    cursor: event.workspaceSeq.toString(),
    entityType: event.entityType,
    entityId: event.entityId,
    operation: event.operation,
    entityVersion: event.entityVersion,
    actorId: event.actorId,
    clientId: event.clientId,
    mutationId: event.mutationId,
    payload: event.payload,
    createdAt: event.createdAt.toISOString()
  };
}

export async function ensurePendingClientMutation(input: SyncMutationMeta & { workspaceId: string }): Promise<'created' | 'existing'> {
  try {
    await prisma.clientMutation.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        clientId: input.clientId,
        mutationId: input.mutationId,
        name: input.mutationName,
        status: 'PENDING'
      }
    });
    return 'created';
  } catch (error) {
    if (isUniqueConstraintError(error)) return 'existing';
    throw error;
  }
}

export async function markClientMutationRejected(
  workspaceId: string,
  clientId: string,
  mutationId: string,
  code: string,
  message: string
): Promise<void> {
  await prisma.clientMutation.updateMany({
    where: { workspaceId, clientId, mutationId },
    data: {
      status: 'REJECTED',
      errorCode: code,
      errorMessage: message
    }
  });
}

export function syncCursor(value: bigint | number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  return value.toString();
}

async function reserveWorkspaceSeq(tx: Prisma.TransactionClient, workspaceId: string): Promise<bigint> {
  await tx.$executeRaw`
    INSERT INTO "WorkspaceSyncState" ("workspaceId", "updatedAt")
    VALUES (${workspaceId}::uuid, NOW())
    ON CONFLICT ("workspaceId") DO NOTHING
  `;

  const rows = await tx.$queryRaw<Array<{ workspaceSeq: bigint }>>`
    UPDATE "WorkspaceSyncState"
    SET "nextSeq" = "nextSeq" + 1, "updatedAt" = NOW()
    WHERE "workspaceId" = ${workspaceId}::uuid
    RETURNING "nextSeq" - 1 AS "workspaceSeq"
  `;

  const workspaceSeq = rows[0]?.workspaceSeq;
  if (workspaceSeq === undefined) throw new Error('Failed to reserve workspace sync cursor');
  return workspaceSeq;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
