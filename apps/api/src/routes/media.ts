import type { FastifyInstance } from 'fastify';
import { buildMediaUrl, uploadMediaToCdn } from '../services/media';
import { readMultipartMediaUpload } from '../services/upload-request';

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  app.post('/uploads', async (request, reply) => {
    const upload = await readMultipartMediaUpload(request);
    const media = await uploadMediaToCdn(upload);
    return reply.code(201).send(media);
  });

  app.get('/media/*', async (request, reply) => {
    const params = request.params as { '*': string };
    const object = params['*'];
    return reply.redirect(buildMediaUrl(object));
  });
}
