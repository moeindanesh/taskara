import { prisma, type Prisma, type ProjectHealthUpdate, type SyncEvent } from '@taskara/db';
import type { z } from 'zod';
import type { createProjectHealthUpdateSchema, projectHealthUpdateListQuerySchema } from '@taskara/shared';
import { config } from '../config';
import type { RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { appendSyncEvent, publishSyncEvent, type SyncMutationMeta } from './sync';
import {
  canManageProjectPlanning,
  projectWhereForAccess,
  resolveWorkspaceAccess
} from './team-access';

type CreateProjectHealthUpdateInput = z.infer<typeof createProjectHealthUpdateSchema>;
type ProjectHealthUpdateListInput = z.infer<typeof projectHealthUpdateListQuerySchema>;

const userSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

export const projectHealthUpdateInclude = {
  author: { select: userSelect },
  project: {
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      teamId: true,
      leadId: true,
      team: { select: { id: true, name: true, slug: true } }
    }
  }
} satisfies Prisma.ProjectHealthUpdateInclude;

export type ProjectHealthUpdateWithRelations = Prisma.ProjectHealthUpdateGetPayload<{
  include: typeof projectHealthUpdateInclude;
}>;

export async function listProjectHealthUpdates(
  actor: RequestActor,
  projectId: string,
  input: ProjectHealthUpdateListInput
) {
  await requireProjectHealthAccess(actor, projectId, { write: false });
  const where: Prisma.ProjectHealthUpdateWhereInput = {
    workspaceId: actor.workspace.id,
    projectId
  };
  const [items, total] = await Promise.all([
    prisma.projectHealthUpdate.findMany({
      where,
      include: projectHealthUpdateInclude,
      orderBy: { createdAt: 'desc' },
      take: input.limit,
      skip: input.offset
    }),
    prisma.projectHealthUpdate.count({ where })
  ]);

  return { items: items.map(serializeProjectHealthUpdate), total, limit: input.limit, offset: input.offset };
}

export async function createProjectHealthUpdate(
  actor: RequestActor,
  projectId: string,
  input: CreateProjectHealthUpdateInput,
  syncMutation?: SyncMutationMeta
) {
  await requireProjectHealthAccess(actor, projectId, { write: true });

  let syncEvent: SyncEvent | null = null;
  const update = await prisma.$transaction(async (tx) => {
    const row = await tx.projectHealthUpdate.create({
      data: {
        workspaceId: actor.workspace.id,
        projectId,
        authorId: actor.user.id,
        health: input.health,
        summary: input.summary,
        progress: input.progress?.trim() || undefined,
        risks: input.risks?.trim() || undefined,
        decisionsNeeded: input.decisionsNeeded?.trim() || undefined,
        nextUpdateDueAt: input.nextUpdateDueAt ? new Date(input.nextUpdateDueAt) : undefined
      },
      include: projectHealthUpdateInclude
    });
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'project_health_update',
      entityId: row.id,
      operation: 'created',
      actorId: actor.user.id,
      payload: { after: serializeProjectHealthUpdate(row) },
      mutation: syncMutation
    });
    return row;
  });
  if (syncEvent) publishSyncEvent(syncEvent);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'project_health_update',
    entityId: update.id,
    action: 'created',
    after: serializeProjectHealthUpdate(update),
    source: actor.source
  }).catch(() => undefined);

  return serializeProjectHealthUpdate(update);
}

export async function publishProjectHealthUpdate(actor: RequestActor, projectId: string, updateId: string) {
  await requireProjectHealthAccess(actor, projectId, { write: true });
  const update = await prisma.projectHealthUpdate.findFirst({
    where: { id: updateId, workspaceId: actor.workspace.id, projectId },
    include: projectHealthUpdateInclude
  });
  if (!update) throw new HttpError(404, 'Project health update not found');

  const binding = await prisma.mattermostBinding.findFirst({
    where: { workspaceId: actor.workspace.id, projectId },
    orderBy: { createdAt: 'desc' }
  });
  if (!binding) {
    return { update: serializeProjectHealthUpdate(update), published: false, reason: 'missing_binding' as const };
  }
  if (!config.MATTERMOST_BASE_URL || !config.MATTERMOST_BOT_TOKEN) {
    return { update: serializeProjectHealthUpdate(update), published: false, reason: 'missing_config' as const };
  }

  const response = await fetch(`${config.MATTERMOST_BASE_URL.replace(/\/$/, '')}/api/v4/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.MATTERMOST_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      channel_id: binding.channelId,
      message: formatProjectHealthMattermostMessage(update)
    })
  });
  if (!response.ok) {
    throw new HttpError(502, 'Mattermost project health publish failed');
  }

  const published = await prisma.projectHealthUpdate.update({
    where: { id: update.id },
    data: { publishedAt: new Date() },
    include: projectHealthUpdateInclude
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'project_health_update',
    entityId: published.id,
    action: 'published_mattermost',
    before: serializeProjectHealthUpdate(update),
    after: serializeProjectHealthUpdate(published),
    source: actor.source
  }).catch(() => undefined);

  return { update: serializeProjectHealthUpdate(published), published: true as const, channelId: binding.channelId };
}

export function serializeProjectHealthUpdate(row: ProjectHealthUpdateWithRelations) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    authorId: row.authorId,
    health: row.health,
    summary: row.summary,
    progress: row.progress,
    risks: row.risks,
    decisionsNeeded: row.decisionsNeeded,
    nextUpdateDueAt: row.nextUpdateDueAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    author: row.author,
    project: row.project
  };
}

export function projectHealthNeedsManagerAttention(
  update: Pick<ProjectHealthUpdate, 'health' | 'decisionsNeeded' | 'risks'>
): boolean {
  if (update.health === 'OFF_TRACK') return true;
  if (update.health === 'AT_RISK' && (update.decisionsNeeded?.trim() || update.risks?.trim())) return true;
  return false;
}

function formatProjectHealthMattermostMessage(update: ProjectHealthUpdateWithRelations): string {
  const lines = [
    `### ${update.project.name} (${healthLabel(update.health)})`,
    update.summary,
    update.progress ? `**Progress:** ${update.progress}` : null,
    update.risks ? `**Risks:** ${update.risks}` : null,
    update.decisionsNeeded ? `**Decisions needed:** ${update.decisionsNeeded}` : null,
    update.nextUpdateDueAt ? `**Next update:** ${update.nextUpdateDueAt.toISOString().slice(0, 10)}` : null
  ].filter(Boolean);
  return lines.join('\n\n');
}

function healthLabel(health: ProjectHealthUpdate['health']): string {
  if (health === 'ON_TRACK') return 'On track';
  if (health === 'AT_RISK') return 'At risk';
  return 'Off track';
}

/**
 * Who may read a project's health, and who may write to it.
 *
 * The read branch composes `projectWhereForAccess` and always has. The **write** branch was a second
 * spelling of "who may write to this project", alongside `canManageProjectPlanning`, and #59's audit
 * found the two disagreeing three ways. Two of those were plain bugs and are closed here; the third
 * is a real question and is left alone rather than settled by a cleanup.
 *
 * **Closed.** The old branch admitted *any* `ProjectMember` row and *any* `TeamMember` row, without
 * looking at the role on it. So a project member with role `VIEWER` — a role that exists precisely
 * to read — and a team member with role `GUEST` could both post a health update, while
 * `canManageProjectPlanning` refused them the milestone on the same project. Calling the shared rule
 * fixes both, and drops a query while it is there.
 *
 * **Left, and surfaced.** A **teamless** project is still writable by anybody who can read it, which
 * is everybody. `canManageProjectPlanning` refuses one to all but an admin or the lead, and it is
 * genuinely unclear which of the two is wrong: a teamless project is readable by the whole
 * workspace, so "nobody may plan it" makes milestones unusable in the default Inbox project, while
 * "anybody may post to it" is at least consistent with who can see it. Making health match planning
 * here would propagate a rule nobody has argued for into a second place. Recorded in
 * `.scratch/AUDIT-read-access-sites.md` and on #60 for the human.
 *
 * The workspace-level GUEST/AGENT refusal above is a different question — a workspace role, not a
 * project one — and stands.
 */
async function requireProjectHealthAccess(
  actor: RequestActor,
  projectId: string,
  options: { write: boolean }
) {
  if (options.write && (actor.role === 'GUEST' || actor.role === 'AGENT')) {
    throw new HttpError(403, 'Project health update access denied');
  }
  const access = await resolveWorkspaceAccess(actor);
  const project = await prisma.project.findFirst({
    where: {
      ...projectWhereForAccess(access),
      id: projectId
    },
    include: {
      team: { select: { id: true } },
      members: { select: { userId: true } }
    }
  });
  if (!project) throw new HttpError(404, 'Project not found');
  if (!options.write) return project;
  // The surfaced divergence, deliberately not resolved here. See the note above.
  if (!project.teamId) return project;
  if (!canManageProjectPlanning(actor, access, project)) {
    throw new HttpError(403, 'Project health update access denied');
  }
  return project;
}
