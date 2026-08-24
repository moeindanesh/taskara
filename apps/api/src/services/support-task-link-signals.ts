import {
  type ActorType,
  type AgentRuntime,
  Prisma,
  type SupportCaseEventSource,
  type SupportCaseSignalStatus,
  type SupportCaseStatus,
  type SyncEvent,
  type TaskSource,
  type TaskStatus
} from '@taskara/db';
import type { RequestActor } from './actor';
import {
  serializeSupportLinkProjection,
  serializeTeamLinkProjection,
  supportCaseTaskLinkProjectionSelect,
  type SupportCaseTaskLinkProjectionRecord
} from './support-link-projections';
import { appendSupportCaseSyncEvent } from './support-sync';
import { appendSyncEvent, lockWorkspaceSyncState } from './sync';

export interface TaskLinkSignalRecord {
  id: string;
  workspaceId: string;
  key: string;
  title: string;
  status: TaskStatus;
}

export interface CaseLinkSignalRecord {
  id: string;
  workspaceId: string;
  key: string;
  status: SupportCaseStatus;
}

export interface SupportCaseLinkSignalProvenance {
  actorId: string | null;
  actorType: ActorType;
  actorRuntime: AgentRuntime | null;
  source: TaskSource;
}

/**
 * Refresh a live Task status projection. The approved handoff title is deliberately frozen:
 * arbitrary later Team titles were never previewed for the Support audience.
 */
export async function signalSupportLinksForTaskUpdate(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  before: TaskLinkSignalRecord,
  after: TaskLinkSignalRecord
): Promise<SyncEvent[]> {
  if (before.status === after.status) return [];
  const links = await tx.supportCaseTaskLink.findMany({
    where: {
      teamWorkspaceId: after.workspaceId,
      taskId: after.id,
      taskDeletedAt: null,
      unlinkedAt: null,
      connectionRevokedAt: null,
      workTarget: { connection: { status: 'ACTIVE' } }
    },
    select: supportCaseTaskLinkProjectionSelect
  });
  if (!links.length) return [];

  await lockSupportCases(tx, links.map((link) => link.caseId));
  // Revocation/unlink owns the same Case rows before freezing a link. Re-read only after those
  // locks so a signal selected just before a freeze cannot publish just after it.
  const liveLinks = await tx.supportCaseTaskLink.findMany({
    where: {
      id: { in: links.map((link) => link.id) },
      teamWorkspaceId: after.workspaceId,
      taskId: after.id,
      taskDeletedAt: null,
      unlinkedAt: null,
      connectionRevokedAt: null,
      workTarget: { connection: { status: 'ACTIVE' } }
    },
    orderBy: [{ caseId: 'asc' }, { id: 'asc' }],
    select: supportCaseTaskLinkProjectionSelect
  });
  if (!liveLinks.length) return [];

  await lockWorkspaceSyncStates(tx, [after.workspaceId, ...liveLinks.map((link) => link.supportWorkspaceId)]);
  const now = new Date();
  const events: SyncEvent[] = [];
  const changesByCase = new Map<string, LinkProjectionChange[]>();
  for (const link of liveLinks) {
    const updated = await tx.supportCaseTaskLink.update({
      where: { id: link.id },
      data: {
        taskStatusSnapshot: after.status,
        lastTaskSignalAt: now,
        version: { increment: 1 }
      },
      select: supportCaseTaskLinkProjectionSelect
    });
    addProjectionChange(changesByCase, link.caseId, { before: link, after: updated });
    events.push(...await appendProjectionEvents(tx, actor.user.id, updated, 'updated'));
  }

  for (const [caseId, changes] of changesByCase) {
    const supportCase = await advanceCaseForTaskSignal(tx, caseId, after.status, now);
    await appendCaseLinkAudit(tx, actor, supportCase, {
      action: 'case.linked_task_status_changed',
      before: serializeProjectionChanges(changes, 'before'),
      after: serializeProjectionChanges(changes, 'after')
    });
    await notifyCaseOwner(
      tx,
      actor,
      supportCase,
      changes[0]!.after,
      `Team Task status changed to ${after.status}.`
    );
    events.push(await appendSupportCaseSyncEvent(tx, {
      workspaceId: supportCase.workspaceId,
      caseId: supportCase.id,
      caseVersion: supportCase.version,
      operation: 'upsert',
      actorId: actor.user.id
    }));
  }
  return events;
}

/**
 * Null the live FK before Task deletion so the database truth constraint and frozen tombstone move
 * atomically with the delete. This covers revoked/unlinked history too; only live links notify.
 */
export async function tombstoneSupportLinksForTaskDeletion(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  task: TaskLinkSignalRecord
): Promise<SyncEvent[]> {
  const links = await tx.supportCaseTaskLink.findMany({
    where: { teamWorkspaceId: task.workspaceId, taskId: task.id, taskDeletedAt: null },
    select: supportCaseTaskLinkProjectionSelect
  });
  if (!links.length) return [];

  await lockSupportCases(tx, links.map((link) => link.caseId));
  const currentLinks = await tx.supportCaseTaskLink.findMany({
    where: { id: { in: links.map((link) => link.id) }, taskDeletedAt: null },
    orderBy: [{ caseId: 'asc' }, { id: 'asc' }],
    select: supportCaseTaskLinkProjectionSelect
  });
  const liveIds = new Set((await tx.supportCaseTaskLink.findMany({
    where: {
      id: { in: currentLinks.map((link) => link.id) },
      unlinkedAt: null,
      connectionRevokedAt: null,
      workTarget: { connection: { status: 'ACTIVE' } }
    },
    select: { id: true }
  })).map((link) => link.id));
  const liveLinks = currentLinks.filter((link) => liveIds.has(link.id));
  if (liveLinks.length) {
    await lockWorkspaceSyncStates(tx, [task.workspaceId, ...liveLinks.map((link) => link.supportWorkspaceId)]);
  }
  const now = new Date();
  const events: SyncEvent[] = [];
  const changesByCase = new Map<string, LinkProjectionChange[]>();
  for (const link of currentLinks) {
    const updated = await tx.supportCaseTaskLink.update({
      where: { id: link.id },
      data: {
        taskId: null,
        taskWorkspaceId: null,
        taskDeletedAt: now,
        version: { increment: 1 }
      },
      select: supportCaseTaskLinkProjectionSelect
    });
    if (liveIds.has(link.id)) {
      addProjectionChange(changesByCase, link.caseId, { before: link, after: updated });
      events.push(...await appendProjectionEvents(tx, actor.user.id, updated, 'task_deleted'));
    }
  }

  for (const [caseId, changes] of changesByCase) {
    const supportCase = await advanceCaseForTaskSignal(tx, caseId, task.status, now, true);
    await appendCaseLinkAudit(tx, actor, supportCase, {
      action: 'case.linked_task_deleted',
      before: serializeProjectionChanges(changes, 'before'),
      after: serializeProjectionChanges(changes, 'after')
    });
    await notifyCaseOwner(
      tx,
      actor,
      supportCase,
      changes[0]!.after,
      'The linked Team Task was deleted; follow-up is required.'
    );
    events.push(await appendSupportCaseSyncEvent(tx, {
      workspaceId: supportCase.workspaceId,
      caseId: supportCase.id,
      caseVersion: supportCase.version,
      operation: 'upsert',
      actorId: actor.user.id
    }));
  }
  return events;
}

/** Publish only the coarse Case lifecycle signal into active Team links. Never mutate the Task. */
export async function applySupportCaseSignalToTaskLinks(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  before: CaseLinkSignalRecord,
  after: CaseLinkSignalRecord
): Promise<SyncEvent[]> {
  return applySupportCaseSignalToTaskLinksWithProvenance(tx, {
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    source: actor.source
  }, before, after);
}

/** Connector/system seam: callers provide truthful nullable provenance instead of inventing a User. */
export async function applySupportCaseSignalToTaskLinksWithProvenance(
  tx: Prisma.TransactionClient,
  provenance: SupportCaseLinkSignalProvenance,
  before: CaseLinkSignalRecord,
  after: CaseLinkSignalRecord
): Promise<SyncEvent[]> {
  const beforeSignal = coarseCaseStatus(before.status);
  const afterSignal = coarseCaseStatus(after.status);
  if (beforeSignal === afterSignal) return [];
  const links = await tx.supportCaseTaskLink.findMany({
    where: {
      supportWorkspaceId: after.workspaceId,
      caseId: after.id,
      unlinkedAt: null,
      connectionRevokedAt: null,
      workTarget: { connection: { status: 'ACTIVE' } }
    },
    select: supportCaseTaskLinkProjectionSelect
  });
  if (!links.length) return [];

  await lockWorkspaceSyncStates(tx, [after.workspaceId, ...links.map((link) => link.teamWorkspaceId)]);
  const now = new Date();
  const events: SyncEvent[] = [];
  for (const link of links) {
    const updated = await tx.supportCaseTaskLink.update({
      where: { id: link.id },
      data: {
        caseStatusSnapshot: afterSignal,
        lastCaseSignalAt: now,
        version: { increment: 1 }
      },
      select: supportCaseTaskLinkProjectionSelect
    });
    if (updated.taskId) {
      await tx.activityLog.create({
        data: {
          workspaceId: updated.teamWorkspaceId,
          actorId: provenance.actorId,
          actorType: provenance.actorType,
          actorRuntime: provenance.actorRuntime,
          entityType: 'task',
          entityId: updated.taskId,
          action: 'support_case_status_signal_changed',
          before: serializeTeamLinkProjection(link),
          after: serializeTeamLinkProjection(updated),
          source: provenance.source
        }
      });
    }
    events.push(...await appendProjectionEvents(tx, provenance.actorId, updated, 'case_status_changed'));
  }
  return events;
}

interface CaseOwnerRecord {
  id: string;
  workspaceId: string;
  key: string;
  status: SupportCaseStatus;
  version: number;
  assigneeMembership: { userId: string } | null;
}

interface LinkProjectionChange {
  before: SupportCaseTaskLinkProjectionRecord;
  after: SupportCaseTaskLinkProjectionRecord;
}

async function advanceCaseForTaskSignal(
  tx: Prisma.TransactionClient,
  caseId: string,
  taskStatus: TaskStatus,
  now: Date,
  force = false
): Promise<CaseOwnerRecord> {
  if (force || taskStatus === 'DONE' || taskStatus === 'CANCELED') {
    await tx.supportCase.updateMany({
      where: { id: caseId, status: { not: 'CLOSED' }, nextActionAt: null },
      data: { nextActionAt: now }
    });
  }
  // The Case version is the Support detail cache's projection epoch. Advance it once for every
  // Task signal even when no Case field (for example nextActionAt) otherwise changes.
  return tx.supportCase.update({
    where: { id: caseId },
    data: { version: { increment: 1 } },
    select: {
      id: true,
      workspaceId: true,
      key: true,
      status: true,
      version: true,
      assigneeMembership: { select: { userId: true } }
    }
  });
}

function addProjectionChange(
  groups: Map<string, LinkProjectionChange[]>,
  caseId: string,
  change: LinkProjectionChange
): void {
  const changes = groups.get(caseId) ?? [];
  changes.push(change);
  groups.set(caseId, changes);
}

function serializeProjectionChanges(
  changes: LinkProjectionChange[],
  side: keyof LinkProjectionChange
): Prisma.InputJsonValue {
  const projections = changes.map((change) => serializeSupportLinkProjection(change[side]));
  return projections.length === 1 ? projections[0]! : { links: projections };
}

async function notifyCaseOwner(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  supportCase: CaseOwnerRecord,
  link: SupportCaseTaskLinkProjectionRecord,
  body: string
): Promise<void> {
  const userId = supportCase.assigneeMembership?.userId;
  if (!userId || userId === actor.user.id) return;
  await tx.notification.create({
    data: {
      workspaceId: supportCase.workspaceId,
      userId,
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      supportCaseId: supportCase.id,
      type: 'SUPPORT_LINKED_TASK_SIGNAL',
      title: `${supportCase.key}: ${link.taskKeySnapshot}`,
      body
    }
  });
}

async function appendCaseLinkAudit(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  supportCase: Pick<CaseOwnerRecord, 'id' | 'workspaceId'>,
  input: {
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
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
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      source: supportEventSource(actor),
      action: input.action,
      before: input.before,
      after: input.after
    }
  });
}

async function appendProjectionEvents(
  tx: Prisma.TransactionClient,
  actorId: string | null,
  link: SupportCaseTaskLinkProjectionRecord,
  operation: string
): Promise<SyncEvent[]> {
  return Promise.all([
    appendSyncEvent(tx, {
      workspaceId: link.supportWorkspaceId,
      entityType: 'support_case_task_link',
      entityId: link.id,
      operation,
      entityVersion: link.version,
      actorId,
      payload: { after: serializeSupportLinkProjection(link) }
    }),
    appendSyncEvent(tx, {
      workspaceId: link.teamWorkspaceId,
      entityType: 'support_case_task_link',
      entityId: link.id,
      operation,
      entityVersion: link.version,
      actorId,
      payload: { after: serializeTeamLinkProjection(link) }
    })
  ]);
}

async function lockSupportCases(tx: Prisma.TransactionClient, caseIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(caseIds)].sort();
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "SupportCase" WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY "id" FOR UPDATE
  `);
}

async function lockWorkspaceSyncStates(
  tx: Prisma.TransactionClient,
  workspaceIds: Iterable<string>
): Promise<void> {
  for (const workspaceId of [...new Set(workspaceIds)].sort()) {
    await lockWorkspaceSyncState(tx, workspaceId);
  }
}

function coarseCaseStatus(status: SupportCaseStatus): SupportCaseSignalStatus {
  if (status === 'RESOLVED') return 'RESOLVED';
  if (status === 'CLOSED') return 'CLOSED';
  return 'OPEN';
}

function supportEventSource(actor: RequestActor): SupportCaseEventSource {
  if (actor.source === 'WEB') return 'WEB';
  if (actor.source === 'SYSTEM') return 'SYSTEM';
  return 'API';
}
