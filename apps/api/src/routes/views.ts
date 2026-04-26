import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import {
  createTaskViewSchema,
  taskViewQuerySchema,
  taskViewStateSchema,
  updateTaskViewSchema
} from '@taskara/shared';
import { getRequestActor } from '../services/actor';

function serializeView(view: {
  id: string;
  workspaceId: string;
  ownerId: string | null;
  name: string;
  filters: unknown;
  isShared: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    ownerId: view.ownerId,
    name: view.name,
    isShared: view.isShared,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    state: taskViewStateSchema.parse(view.filters)
  };
}

export async function registerViewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/views', async (request) => {
    const actor = await getRequestActor(request);
    const query = taskViewQuerySchema.parse(request.query);
    const views = await prisma.view.findMany({
      where: {
        workspaceId: actor.workspace.id,
        OR: [{ isShared: true }, { ownerId: actor.user.id }]
      },
      orderBy: [{ updatedAt: 'desc' }]
    });

    return views
      .map(serializeView)
      .filter((view) => view.state.scope === query.scope && view.state.teamId === query.teamId);
  });

  app.post('/views', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createTaskViewSchema.parse(request.body);
    const view = await prisma.view.create({
      data: {
        workspaceId: actor.workspace.id,
        ownerId: actor.user.id,
        name: input.name,
        filters: input.state,
        isShared: input.isShared
      }
    });

    return reply.code(201).send(serializeView(view));
  });

  app.patch('/views/:id', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = updateTaskViewSchema.parse(request.body);
    const existing = await prisma.view.findFirst({
      where: {
        id,
        workspaceId: actor.workspace.id,
        OR: [{ ownerId: actor.user.id }, { ownerId: null }]
      }
    });

    if (!existing) return reply.code(404).send({ message: 'View not found' });

    const view = await prisma.view.update({
      where: { id },
      data: {
        name: input.name,
        isShared: input.isShared,
        filters: input.state
      }
    });

    return serializeView(view);
  });

  app.delete('/views/:id', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.view.findFirst({
      where: {
        id,
        workspaceId: actor.workspace.id,
        ownerId: actor.user.id
      }
    });

    if (!existing) return reply.code(404).send({ message: 'View not found' });

    await prisma.view.delete({ where: { id } });
    return reply.code(204).send();
  });
}
