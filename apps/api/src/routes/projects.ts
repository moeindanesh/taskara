import type { FastifyInstance } from 'fastify';
import { prisma, type Project } from '@taskara/db';
import { createProjectSchema, updateProjectSchema } from '@taskara/shared';
import { getRequestActor } from '../services/actor';
import { logActivity } from '../services/audit';
import { HttpError } from '../services/http';

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async (request) => {
    const actor = await getRequestActor(request);
    return prisma.project.findMany({
      where: { workspaceId: actor.workspace.id },
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
    await assertProjectRelations(actor.workspace.id, input);

    let project: Project;
    try {
      project = await prisma.project.create({
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
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, 'Project key prefix already exists in this workspace');
      }
      throw error;
    }

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'project',
      entityId: project.id,
      action: 'created',
      after: project,
      source: actor.source
    });

    return reply.code(201).send(project);
  });

  app.get('/projects/:id', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const project = await prisma.project.findFirst({
      where: { id, workspaceId: actor.workspace.id },
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
    const { id } = request.params as { id: string };
    const input = updateProjectSchema.parse(request.body);
    const existing = await prisma.project.findFirst({ where: { id, workspaceId: actor.workspace.id } });
    if (!existing) return reply.code(404).send({ message: 'Project not found' });
    await assertProjectRelations(actor.workspace.id, input, id);

    let project: Project;
    try {
      project = await prisma.project.update({
        where: { id },
        data: input
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, 'Project key prefix already exists in this workspace');
      }
      throw error;
    }

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
    });

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
