import type { FastifyInstance } from 'fastify';
import {
  createMilestoneSchema,
  milestoneCompletionSchema,
  milestoneListQuerySchema,
  milestoneOwnerCandidateQuerySchema,
  milestoneTransitionSchema,
  reorderMilestoneSchema,
  updateMilestoneSchema
} from '@taskara/shared';
import { prisma } from '@taskara/db';
import { getRequestActor } from '../services/actor';
import {
  activateMilestone,
  archiveMilestone,
  cancelMilestone,
  completeMilestone,
  createMilestone,
  getMilestone,
  listMilestoneOwnerCandidates,
  listMilestones,
  reopenMilestone,
  reorderMilestone,
  restoreMilestone,
  updateMilestone
} from '../services/milestones';

export async function registerMilestoneRoutes(app: FastifyInstance): Promise<void> {
  app.get('/milestones', async (request) => {
    const actor = await getRequestActor(request);
    return listMilestones(actor, milestoneListQuerySchema.parse(request.query));
  });

  app.get('/milestones/owner-candidates', async (request) => {
    const actor = await getRequestActor(request);
    return listMilestoneOwnerCandidates(actor, milestoneOwnerCandidateQuerySchema.parse(request.query));
  });

  app.post('/milestones', async (request, reply) => {
    const actor = await getRequestActor(request);
    const milestone = await createMilestone(actor, createMilestoneSchema.parse(request.body));
    return reply.code(201).send(milestone);
  });

  app.get('/milestones/:id/activity', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    await getMilestone(actor, id);
    return prisma.activityLog.findMany({
      where: { workspaceId: actor.workspace.id, entityType: 'milestone', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { id: true, name: true, email: true, avatarUrl: true } } }
    });
  });

  app.get('/milestones/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return getMilestone(actor, id);
  });

  app.patch('/milestones/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return updateMilestone(actor, id, updateMilestoneSchema.parse(request.body));
  });

  app.post('/milestones/:id/reorder', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return reorderMilestone(actor, id, reorderMilestoneSchema.parse(request.body));
  });

  app.post('/milestones/:id/activate', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return activateMilestone(actor, id, milestoneTransitionSchema.parse(request.body || {}));
  });

  app.post('/milestones/:id/complete', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return completeMilestone(actor, id, milestoneCompletionSchema.parse(request.body || {}));
  });

  app.post('/milestones/:id/reopen', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return reopenMilestone(actor, id, milestoneTransitionSchema.parse(request.body || {}));
  });

  app.post('/milestones/:id/cancel', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return cancelMilestone(actor, id, milestoneCompletionSchema.parse(request.body || {}));
  });

  app.post('/milestones/:id/archive', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return archiveMilestone(actor, id, milestoneTransitionSchema.parse(request.body || {}));
  });

  app.post('/milestones/:id/restore', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return restoreMilestone(actor, id, milestoneTransitionSchema.parse(request.body || {}));
  });
}
