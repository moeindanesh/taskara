import type { FastifyInstance } from 'fastify';
import { buildMediaUrl } from '../services/media';

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/media/*', async (request, reply) => {
    const params = request.params as { '*': string };
    const object = params['*'];
    // The object comes out of the request path, so the caller chooses it. Without this the endpoint
    // is an open redirect: a link on Taskara's own domain that lands anywhere the caller names.
    return reply.redirect(buildMediaUrl(object, { allowAbsolute: false }));
  });
}
