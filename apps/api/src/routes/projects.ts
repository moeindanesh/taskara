import type { FastifyInstance } from 'fastify';
import { prisma, type Project, type SyncEvent } from '@taskara/db';
import { createProjectSchema, updateProjectSchema } from '@taskara/shared';
import { getRequestActor } from '../services/actor';
import { logActivity } from '../services/audit';
import { HttpError } from '../services/http';
import { appendSyncEvent, publishSyncEvent } from '../services/sync';
import { assertActorCanAccessTeamId, listAccessibleTeamIds } from '../services/team-access';

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async (request) => {
    const actor = await getRequestActor(request);
    const teamIds = await listAccessibleTeamIds(actor);
    return prisma.project.findMany({
      where: {
        workspaceId: actor.workspace.id,
        ...(teamIds ? { OR: [{ teamId: null }, { teamId: { in: teamIds } }] } : {})
      },
      orderBy: [{ parentId: 'asc' }, { updatedAt: 'desc' }],
      include: {
        team: { select: { id: true, name: true, slug: true } },
        parent: { select: { id: true, name: true, keyPrefix: true } },
        lead: { select: { id: true, name: true, email: true, avatarUrl: true } },
        _count: { select: { tasks: true, subprojects: true } }
      }
    });
  });

  app.post('/projects', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createProjectSchema.parse(request.body);
    if (input.teamId) await assertActorCanAccessTeamId(actor, input.teamId);
    await assertProjectRelations(actor.workspace.id, input);

    let syncEvent: SyncEvent | null = null;
    let project: Project;
    try {
      project = await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            workspaceId: actor.workspace.id,
            teamId: input.teamId,
            parentId: input.parentId,
            leadId: input.leadId,
            name: input.name,
            keyPrefix: input.keyPrefix,
            description: input.description
          }
        });
        syncEvent = await appendSyncEvent(tx, {
          workspaceId: actor.workspace.id,
          entityType: 'project',
          entityId: project.id,
          operation: 'created',
          actorId: actor.user.id,
          payload: { after: project, changedFields: Object.keys(input) }
        });
        return project;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, 'Project key prefix already exists in this workspace');
      }
      throw error;
    }
    if (syncEvent) publishSyncEvent(syncEvent);

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'project',
      entityId: project.id,
      action: 'created',
      after: project,
      source: actor.source
    }).catch(() => undefined);

    return reply.code(201).send(project);
  });

  app.get('/projects/:id', async (request, reply) => {
    const actor = await getRequestActor(request);
    const teamIds = await listAccessibleTeamIds(actor);
    const { id } = request.params as { id: string };
    const project = await prisma.project.findFirst({
      where: {
        id,
        workspaceId: actor.workspace.id,
        ...(teamIds ? { OR: [{ teamId: null }, { teamId: { in: teamIds } }] } : {})
      },
      include: {
        subprojects: { orderBy: { updatedAt: 'desc' }, include: { _count: { select: { tasks: true } } } },
        tasks: { take: 50, orderBy: { updatedAt: 'desc' } },
        _count: { select: { tasks: true, subprojects: true } }
      }
    });
    if (!project) return reply.code(404).send({ message: 'Project not found' });
    return project;
  });

  app.patch('/projects/:id', async (request, reply) => {
    const actor = await getRequestActor(request);
    const teamIds = await listAccessibleTeamIds(actor);
    const { id } = request.params as { id: string };
    const input = updateProjectSchema.parse(request.body);
    const existing = await prisma.project.findFirst({
      where: {
        id,
        workspaceId: actor.workspace.id,
        ...(teamIds ? { OR: [{ teamId: null }, { teamId: { in: teamIds } }] } : {})
      }
    });
    if (!existing) return reply.code(404).send({ message: 'Project not found' });
    if (input.teamId) await assertActorCanAccessTeamId(actor, input.teamId);
    await assertProjectRelations(actor.workspace.id, input, id);

    let syncEvent: SyncEvent | null = null;
    let project: Project;
    try {
      project = await prisma.$transaction(async (tx) => {
        const project = await tx.project.update({
          where: { id },
          data: input
        });
        syncEvent = await appendSyncEvent(tx, {
          workspaceId: actor.workspace.id,
          entityType: 'project',
          entityId: project.id,
          operation: 'updated',
          actorId: actor.user.id,
          payload: { before: existing, after: project, changedFields: Object.keys(input) }
        });
        return project;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, 'Project key prefix already exists in this workspace');
      }
      throw error;
    }
    if (syncEvent) publishSyncEvent(syncEvent);

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'project',
      entityId: project.id,
      action: 'updated',
      before: existing,
      after: project,
      source: actor.source
    }).catch(() => undefined);

    return project;
  });
}

async function assertProjectRelations(
  workspaceId: string,
  input: { teamId?: string | null; parentId?: string | null; leadId?: string | null },
  projectId?: string
): Promise<void> {
  if (input.parentId && input.parentId === projectId) {
    throw new HttpError(400, 'Project cannot be its own parent');
  }

  const [team, parent, leadMembership] = await Promise.all([
    input.teamId
      ? prisma.team.findFirst({ where: { id: input.teamId, workspaceId }, select: { id: true } })
      : Promise.resolve(null),
    input.parentId
      ? prisma.project.findFirst({ where: { id: input.parentId, workspaceId }, select: { id: true } })
      : Promise.resolve(null),
    input.leadId
      ? prisma.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: input.leadId } },
          select: { id: true }
        })
      : Promise.resolve(null)
  ]);

  if (input.teamId && !team) throw new HttpError(400, 'Team not found in this workspace');
  if (input.parentId && !parent) throw new HttpError(400, 'Parent project not found in this workspace');
  if (input.leadId && !leadMembership) throw new HttpError(400, 'Project lead must belong to this workspace');
}
