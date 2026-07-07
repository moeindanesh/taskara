import type { FastifyInstance } from 'fastify';
import {
  reassignTaskReviewSchema,
  requestTaskReviewSchema,
  taskReviewDecisionSchema
} from '@taskara/shared';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import {
  approveTaskReview,
  cancelTaskReview,
  listMyTaskReviews,
  listTaskReviews,
  reassignTaskReview,
  requestTaskReview,
  requestTaskReviewChanges
} from '../services/task-reviews';

const reviewListQuerySchema = z.object({
  status: z.enum(['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'CANCELED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export async function registerTaskReviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reviews/mine', async (request) => {
    const actor = await getRequestActor(request);
    const query = reviewListQuerySchema.parse(request.query);
    return listMyTaskReviews(actor, query);
  });

  app.get('/tasks/:idOrKey/reviews', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    return listTaskReviews(actor, idOrKey);
  });

  app.post('/tasks/:idOrKey/reviews', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = requestTaskReviewSchema.parse(request.body);
    const review = await requestTaskReview(actor, idOrKey, input);
    return reply.code(201).send(review);
  });

  app.patch('/reviews/:id/reassign', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = reassignTaskReviewSchema.parse(request.body);
    return reassignTaskReview(actor, id, input);
  });

  app.post('/reviews/:id/approve', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = taskReviewDecisionSchema.parse(request.body || {});
    return approveTaskReview(actor, id, input);
  });

  app.post('/reviews/:id/request-changes', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = taskReviewDecisionSchema.parse(request.body || {});
    return requestTaskReviewChanges(actor, id, input);
  });

  app.post('/reviews/:id/cancel', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = taskReviewDecisionSchema.parse(request.body || {});
    return cancelTaskReview(actor, id, input);
  });
}
