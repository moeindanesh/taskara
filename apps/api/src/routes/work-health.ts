import type { FastifyInstance } from 'fastify';
import { getRequestActor } from '../services/actor';
import { getWorkHealthSummary } from '../services/work-health';

export async function registerWorkHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-health/summary', async (request) => {
    const actor = await getRequestActor(request);
    return getWorkHealthSummary(actor);
  });
}
