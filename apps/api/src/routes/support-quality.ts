import type { FastifyInstance } from 'fastify';
import { getRequestActor } from '../services/actor';
import {
  createSupportCsatInvitation,
  createSupportCsatInvitationSchema,
  createSupportQualityReview,
  createSupportQualityReviewSchema,
  createSupportQualityRubric,
  createSupportQualityRubricSchema,
  createSupportSuggestion,
  createSupportSuggestionSchema,
  decideSupportSuggestion,
  decideSupportSuggestionSchema,
  getSupportCsatForCase,
  listSupportQualityReviews,
  listSupportQualityRubrics,
  listSupportSuggestions,
  submitSupportCsat,
  submitSupportCsatSchema
} from '../services/support-quality';

export async function registerSupportQualityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/cases/:idOrKey/assistance', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return listSupportSuggestions(await getRequestActor(request), idOrKey);
  });

  app.post('/support/cases/:idOrKey/assistance', async (request, reply) => {
    const { idOrKey } = request.params as { idOrKey: string };
    const suggestion = await createSupportSuggestion(
      await getRequestActor(request),
      idOrKey,
      createSupportSuggestionSchema.parse(request.body)
    );
    return reply.code(201).send(suggestion);
  });

  app.post('/support/assistance/:suggestionId/decide', async (request) => {
    const { suggestionId } = request.params as { suggestionId: string };
    return decideSupportSuggestion(
      await getRequestActor(request),
      suggestionId,
      decideSupportSuggestionSchema.parse(request.body)
    );
  });

  app.post('/support/cases/:idOrKey/csat/invitations', async (request, reply) => {
    const { idOrKey } = request.params as { idOrKey: string };
    const invitation = await createSupportCsatInvitation(
      await getRequestActor(request),
      idOrKey,
      createSupportCsatInvitationSchema.parse(request.body)
    );
    return reply.code(201).send(invitation);
  });

  app.get('/support/cases/:idOrKey/csat', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return getSupportCsatForCase(await getRequestActor(request), idOrKey);
  });

  // Public-by-token endpoint. Its response deliberately contains no Case, workspace, contact,
  // validity, expiry, scale, or replay state.
  app.post('/support/csat/respond', async (request, reply) => {
    const result = await submitSupportCsat(submitSupportCsatSchema.parse(request.body));
    return reply.code(202).send(result);
  });

  app.get('/support/quality/rubrics', async (request) => {
    return listSupportQualityRubrics(await getRequestActor(request));
  });

  app.post('/support/quality/rubrics', async (request, reply) => {
    const rubric = await createSupportQualityRubric(
      await getRequestActor(request),
      createSupportQualityRubricSchema.parse(request.body)
    );
    return reply.code(201).send(rubric);
  });

  app.get('/support/quality/reviews', async (request) => {
    return listSupportQualityReviews(await getRequestActor(request));
  });

  app.post('/support/quality/reviews', async (request, reply) => {
    const review = await createSupportQualityReview(
      await getRequestActor(request),
      createSupportQualityReviewSchema.parse(request.body)
    );
    return reply.code(201).send(review);
  });
}
