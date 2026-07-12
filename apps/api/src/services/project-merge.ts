import { prisma, Prisma, type ProjectRole, type SyncEvent } from '@taskara/db';
import type { RequestActor } from './actor';
import { HttpError } from './http';
import { appendSyncEvent, publishSyncEvent } from './sync';

export interface MergeProjectsInput {
  destinationProjectId: string;
  sourceProjectIds: string[];
}

export interface MergeProjectsResult {
  project: {
    id: string;
    name: string;
    keyPrefix: string;
    status: string;
    nextTaskNumber: number;
  };
  mergedProjectIds: string[];
  moved: {
    tasks: number;
    milestones: number;
    cycles: number;
    meetings: number;
    healthUpdates: number;
    members: number;
    childProjects: number;
    knowledgeSpaces: number;
    knowledgePages: number;
    mattermostBindings: number;
  };
}

const projectRoleRank: Record<ProjectRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  LEAD: 2
};

export async function mergeProjects(actor: RequestActor, input: MergeProjectsInput): Promise<MergeProjectsResult> {
  const projectIds = [input.destinationProjectId, ...input.sourceProjectIds];
  let syncEvent: SyncEvent | null = null;
  const result = await prisma.$transaction(async (tx) => {
    const lockedProjects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Project"
      WHERE "workspaceId" = ${actor.workspace.id}::uuid
        AND "id" IN (${Prisma.join(projectIds.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY "id"
      FOR UPDATE
    `);
    if (lockedProjects.length !== projectIds.length) throw new HttpError(404, 'One or more projects were not found');
    const projects = await tx.project.findMany({
      where: { workspaceId: actor.workspace.id, id: { in: projectIds } },
      select: { id: true, name: true, keyPrefix: true, parentId: true }
    });
    const destination = await tx.project.findUniqueOrThrow({
      where: { id: input.destinationProjectId },
      select: { id: true, name: true, keyPrefix: true, status: true, nextTaskNumber: true, parentId: true }
    });
    const sourceIds = input.sourceProjectIds;

    const [sourceTasks, maxTargetSequence, sourceMembers, targetMembers, knowledgeSpaces] = await Promise.all([
      tx.task.findMany({
        where: { projectId: { in: sourceIds } },
        orderBy: [{ projectId: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
        select: { id: true }
      }),
      tx.task.aggregate({ where: { projectId: destination.id }, _max: { sequence: true } }),
      tx.projectMember.findMany({ where: { projectId: { in: sourceIds } } }),
      tx.projectMember.findMany({ where: { projectId: destination.id } }),
      tx.knowledgeSpace.findMany({
        where: { projectId: { in: projectIds } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, projectId: true }
      })
    ]);

    const counts = await moveSimpleProjectRelations(tx, sourceIds, destination.id);
    await mergeProjectMembers(tx, sourceMembers, targetMembers, destination.id);

    let nextSequence = Math.max(destination.nextTaskNumber, (maxTargetSequence._max.sequence ?? 0) + 1);
    for (const task of sourceTasks) {
      await tx.task.update({
        where: { id: task.id },
        data: { projectId: destination.id, sequence: nextSequence, version: { increment: 1 } }
      });
      nextSequence += 1;
    }
    if (sourceTasks.length > 0 || nextSequence !== destination.nextTaskNumber) {
      await tx.project.update({ where: { id: destination.id }, data: { nextTaskNumber: nextSequence } });
    }

    const knowledgeCounts = await mergeKnowledgeSpaces(tx, knowledgeSpaces, destination.id);
    const destinationParentId = resolveDestinationParentId(destination.id, destination.parentId, projects, sourceIds);
    if (destinationParentId !== destination.parentId) {
      await tx.project.update({ where: { id: destination.id }, data: { parentId: destinationParentId } });
    }
    const childProjects = await tx.project.updateMany({
      where: {
        parentId: { in: sourceIds },
        id: { notIn: [...sourceIds, destination.id] }
      },
      data: { parentId: destination.id }
    });

    await tx.project.deleteMany({ where: { id: { in: sourceIds }, workspaceId: actor.workspace.id } });
    const mergedProject = await tx.project.findUniqueOrThrow({
      where: { id: destination.id },
      select: { id: true, name: true, keyPrefix: true, status: true, nextTaskNumber: true }
    });

    const moved = {
      tasks: sourceTasks.length,
      milestones: counts.milestones,
      cycles: counts.cycles,
      meetings: counts.meetings,
      healthUpdates: counts.healthUpdates,
      members: sourceMembers.length,
      childProjects: childProjects.count,
      knowledgeSpaces: knowledgeCounts.spaces,
      knowledgePages: knowledgeCounts.pages,
      mattermostBindings: counts.mattermostBindings
    };
    const response = { project: mergedProject, mergedProjectIds: sourceIds, moved };
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'project',
      entityId: destination.id,
      operation: 'merged',
      actorId: actor.user.id,
      payload: response
    });
    return response;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 60_000
  });

  if (syncEvent) publishSyncEvent(syncEvent);
  return result;
}

async function moveSimpleProjectRelations(tx: Prisma.TransactionClient, sourceIds: string[], destinationId: string) {
  const [milestones, cycles, meetings, healthUpdates, mattermostBindings] = await Promise.all([
    tx.milestone.updateMany({ where: { projectId: { in: sourceIds } }, data: { projectId: destinationId } }),
    tx.cycle.updateMany({ where: { projectId: { in: sourceIds } }, data: { projectId: destinationId } }),
    tx.meeting.updateMany({ where: { projectId: { in: sourceIds } }, data: { projectId: destinationId } }),
    tx.projectHealthUpdate.updateMany({ where: { projectId: { in: sourceIds } }, data: { projectId: destinationId } }),
    tx.mattermostBinding.updateMany({ where: { projectId: { in: sourceIds } }, data: { projectId: destinationId } })
  ]);
  return {
    milestones: milestones.count,
    cycles: cycles.count,
    meetings: meetings.count,
    healthUpdates: healthUpdates.count,
    mattermostBindings: mattermostBindings.count
  };
}

async function mergeProjectMembers(
  tx: Prisma.TransactionClient,
  sourceMembers: Array<{ userId: string; role: ProjectRole }>,
  targetMembers: Array<{ userId: string; role: ProjectRole }>,
  destinationId: string
) {
  const strongestRole = new Map(targetMembers.map((member) => [member.userId, member.role]));
  for (const member of sourceMembers) {
    const current = strongestRole.get(member.userId);
    if (!current || projectRoleRank[member.role] > projectRoleRank[current]) strongestRole.set(member.userId, member.role);
  }
  for (const [userId, role] of strongestRole) {
    await tx.projectMember.upsert({
      where: { projectId_userId: { projectId: destinationId, userId } },
      update: { role },
      create: { projectId: destinationId, userId, role }
    });
  }
}

async function mergeKnowledgeSpaces(
  tx: Prisma.TransactionClient,
  spaces: Array<{ id: string; projectId: string | null }>,
  destinationId: string
): Promise<{ spaces: number; pages: number }> {
  if (spaces.length === 0) return { spaces: 0, pages: 0 };
  const destinationSpace = spaces.find((space) => space.projectId === destinationId) ?? spaces[0];
  if (destinationSpace.projectId !== destinationId) {
    await tx.knowledgeSpace.update({ where: { id: destinationSpace.id }, data: { projectId: destinationId } });
  }

  let movedPages = 0;
  for (const space of spaces) {
    if (space.id === destinationSpace.id) continue;
    const pages = await tx.knowledgePage.findMany({
      where: { spaceId: space.id },
      select: { id: true, path: true }
    });
    const pathPrefix = `/merged-${space.id.slice(0, 8)}`;
    for (const page of pages) {
      const suffix = page.path === '/' ? '' : page.path.startsWith('/') ? page.path : `/${page.path}`;
      await tx.knowledgePage.update({
        where: { id: page.id },
        data: { spaceId: destinationSpace.id, path: `${pathPrefix}${suffix}` }
      });
    }
    movedPages += pages.length;
    await tx.knowledgeSpace.delete({ where: { id: space.id } });
  }
  return { spaces: spaces.filter((space) => space.projectId !== destinationId).length, pages: movedPages };
}

function resolveDestinationParentId(
  destinationId: string,
  parentId: string | null,
  projects: Array<{ id: string; parentId: string | null }>,
  sourceIds: string[]
): string | null {
  const sourceIdSet = new Set(sourceIds);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const visited = new Set<string>();
  let candidate = parentId;
  while (candidate && sourceIdSet.has(candidate)) {
    if (visited.has(candidate)) return null;
    visited.add(candidate);
    candidate = byId.get(candidate)?.parentId ?? null;
  }
  return candidate === destinationId ? null : candidate;
}
