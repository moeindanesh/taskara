import { type Prisma } from '@taskara/db';
import { HttpError } from './http';

export const supportCaseTaskLinkProjectionSelect = {
  id: true,
  version: true,
  idempotencyKey: true,
  idempotencyHash: true,
  connectionId: true,
  workTargetId: true,
  supportWorkspaceId: true,
  teamWorkspaceId: true,
  caseId: true,
  taskId: true,
  taskWorkspaceId: true,
  relationType: true,
  handoffTitle: true,
  handoffSummary: true,
  teamWorkspaceNameSnapshot: true,
  taskKeySnapshot: true,
  taskTitleSnapshot: true,
  taskStatusSnapshot: true,
  supportWorkspaceNameSnapshot: true,
  caseKeySnapshot: true,
  caseTitleSnapshot: true,
  caseStatusSnapshot: true,
  lastTaskSignalAt: true,
  lastCaseSignalAt: true,
  connectionRevokedAt: true,
  taskDeletedAt: true,
  unlinkedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.SupportCaseTaskLinkSelect;

export type SupportCaseTaskLinkProjectionRecord = Prisma.SupportCaseTaskLinkGetPayload<{
  select: typeof supportCaseTaskLinkProjectionSelect;
}>;

/** The exact v1 payload a Support reader may learn about the Team side. */
export function serializeSupportLinkProjection(link: SupportCaseTaskLinkProjectionRecord) {
  const freezeAt = earliestDate(link.connectionRevokedAt, link.unlinkedAt);
  const visibleTaskDeletedAt = link.taskDeletedAt && (!freezeAt || link.taskDeletedAt <= freezeAt)
    ? link.taskDeletedAt
    : null;
  return {
    projectionVersion: 1 as const,
    linkId: link.id,
    teamWorkspaceName: link.teamWorkspaceNameSnapshot,
    taskKey: link.taskKeySnapshot,
    title: link.taskTitleSnapshot,
    status: link.taskStatusSnapshot,
    lastSignalAt: (link.lastTaskSignalAt ?? link.createdAt).toISOString(),
    tombstone: {
      // A historical projection freezes at unlink/revocation. The database still clears the live
      // Task FK on a later deletion, but that later fact must not cross an already-closed boundary.
      taskDeletedAt: visibleTaskDeletedAt?.toISOString() ?? null,
      connectionRevokedAt: link.connectionRevokedAt?.toISOString() ?? null,
      unlinkedAt: link.unlinkedAt?.toISOString() ?? null
    }
  };
}

function earliestDate(...values: Array<Date | null>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (!dates.length) return null;
  return dates.reduce((earliest, value) => value < earliest ? value : earliest);
}

/** The exact v1 payload a Team reader may learn about the Support side. */
export function serializeTeamLinkProjection(link: SupportCaseTaskLinkProjectionRecord) {
  return {
    projectionVersion: 1 as const,
    linkId: link.id,
    supportWorkspaceName: link.supportWorkspaceNameSnapshot,
    caseKey: link.caseKeySnapshot,
    title: link.handoffTitle,
    status: link.caseStatusSnapshot,
    lastSignalAt: (link.lastCaseSignalAt ?? link.createdAt).toISOString(),
    tombstone: {
      connectionRevokedAt: link.connectionRevokedAt?.toISOString() ?? null,
      unlinkedAt: link.unlinkedAt?.toISOString() ?? null
    }
  };
}

/**
 * User-approved handoff titles are the boundary. This removes obvious direct contact data and
 * controls, but deliberately does not claim to make arbitrary later Team titles safe to publish.
 */
export function sanitizeCrossWorkspaceTitle(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted-phone]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) throw new HttpError(400, 'Handoff title is empty after sanitization');
  return normalized.slice(0, 240);
}
