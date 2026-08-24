import type { FastifyInstance } from 'fastify';
import { getRequestActor } from '../services/actor';
import {
  createSupportSavedView,
  createSupportSavedViewSchema,
  deleteSupportSavedView,
  deleteSupportSavedViewSchema,
  getSupportSavedView,
  listCasesForSupportSavedView,
  listSupportSavedViews,
  readSupportCasePresence,
  readSupportCasePresenceSchema,
  releaseSupportCasePresence,
  releaseSupportCasePresenceSchema,
  supportSavedViewIdSchema,
  touchSupportCasePresence,
  touchSupportCasePresenceSchema,
  updateSupportSavedView,
  updateSupportSavedViewSchema,
  useSupportSavedViewSchema
} from '../services/support-collaboration';

export async function registerSupportCollaborationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/saved-views', async (request) => {
    return listSupportSavedViews(await getRequestActor(request));
  });

  app.post('/support/saved-views', async (request, reply) => {
    const view = await createSupportSavedView(
      await getRequestActor(request),
      createSupportSavedViewSchema.parse(request.body)
    );
    return reply.code(201).send(view);
  });

  app.get('/support/saved-views/:id', async (request) => {
    const id = supportSavedViewIdSchema.parse((request.params as { id: string }).id);
    return getSupportSavedView(await getRequestActor(request), id);
  });

  app.patch('/support/saved-views/:id', async (request) => {
    const id = supportSavedViewIdSchema.parse((request.params as { id: string }).id);
    return updateSupportSavedView(
      await getRequestActor(request),
      id,
      updateSupportSavedViewSchema.parse(request.body)
    );
  });

  app.delete('/support/saved-views/:id', async (request, reply) => {
    const id = supportSavedViewIdSchema.parse((request.params as { id: string }).id);
    const { baseVersion } = deleteSupportSavedViewSchema.parse(request.query);
    await deleteSupportSavedView(await getRequestActor(request), id, baseVersion);
    return reply.code(204).send();
  });

  app.get('/support/saved-views/:id/cases', async (request) => {
    const id = supportSavedViewIdSchema.parse((request.params as { id: string }).id);
    return listCasesForSupportSavedView(
      await getRequestActor(request),
      id,
      useSupportSavedViewSchema.parse(request.query)
    );
  });

  app.post('/support/cases/:idOrKey/presence', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return touchSupportCasePresence(
      await getRequestActor(request),
      idOrKey,
      touchSupportCasePresenceSchema.parse(request.body)
    );
  });

  app.get('/support/cases/:idOrKey/presence', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return readSupportCasePresence(
      await getRequestActor(request),
      idOrKey,
      readSupportCasePresenceSchema.parse(request.query)
    );
  });

  app.delete('/support/cases/:idOrKey/presence', async (request, reply) => {
    const { idOrKey } = request.params as { idOrKey: string };
    await releaseSupportCasePresence(
      await getRequestActor(request),
      idOrKey,
      releaseSupportCasePresenceSchema.parse(request.query)
    );
    return reply.code(204).send();
  });
}
