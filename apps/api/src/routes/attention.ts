import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import {
  dismissAttentionItem,
  listAttentionItems,
  resolveAttentionItem,
  snoozeAttentionItem,
  synchronizeAttention
} from '../services/attention';

const attentionListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'ALL', 'OPEN', 'SNOOZED', 'RESOLVED', 'DISMISSED']).optional(),
  includeSnoozed: z.coerce.boolean().optional(),
  generate: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const attentionSnoozeSchema = z.object({
  snoozedUntil: z.string().datetime({ offset: true })
});

const attentionDismissSchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

export async function registerAttentionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/attention', async (request) => {
    const actor = await getRequestActor(request);
    const query = attentionListQuerySchema.parse(request.query);
    return listAttentionItems(actor, query);
  });

  app.post('/attention/generate', async (request) => {
    const actor = await getRequestActor(request);
    const result = await synchronizeAttention(actor);
    return {
      generatedAt: result.generatedAt,
      candidates: result.candidates.length
    };
  });

  app.post('/attention/:id/snooze', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = attentionSnoozeSchema.parse(request.body);
    return snoozeAttentionItem(actor, id, new Date(input.snoozedUntil));
  });

  app.post('/attention/:id/resolve', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return resolveAttentionItem(actor, id);
  });

  app.post('/attention/:id/dismiss', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = attentionDismissSchema.parse(request.body);
    return dismissAttentionItem(actor, id, input.reason);
  });
}
