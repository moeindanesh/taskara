import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import {
  getSupportIntakeAdminHealth,
  getSupportIntakeDeadLetter,
  listSupportIntakeDeadLetters,
  retrySupportIntakeDeadLetter
} from '../services/support-intake';

const deadLetterListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(1_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  connectorId: z.string().uuid().optional()
}).strict();

const receiptParamsSchema = z.object({
  receiptId: z.string().uuid()
}).strict();

/**
 * Session-authenticated, workspace-admin-only operations. Keep these separate from the raw-body
 * source endpoints so connector content-type parsing and credentials cannot bleed into admin APIs.
 */
export async function registerSupportIntakeAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/intake-admin/health', async (request) => {
    return getSupportIntakeAdminHealth(await getRequestActor(request));
  });

  app.get('/support/intake-admin/dead-letters', async (request) => {
    const query = deadLetterListQuerySchema.parse(request.query);
    return listSupportIntakeDeadLetters(await getRequestActor(request), query);
  });

  app.get('/support/intake-admin/dead-letters/:receiptId', async (request) => {
    const { receiptId } = receiptParamsSchema.parse(request.params);
    return getSupportIntakeDeadLetter(await getRequestActor(request), receiptId);
  });

  app.post('/support/intake-admin/dead-letters/:receiptId/retry', async (request, reply) => {
    const { receiptId } = receiptParamsSchema.parse(request.params);
    const result = await retrySupportIntakeDeadLetter(await getRequestActor(request), receiptId);
    return reply.code(202).send(result);
  });
}
