import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createSupportIntakeConnectorSchema } from '@taskara/shared';
import { getRequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import {
  acceptSupportIntakeEvent,
  createSupportIntakeConnector,
  getSupportIntakeHealth,
  listSupportIntakeConnectors,
  readSupportIntakeReceiptStatus,
  revokeSupportIntakeConnector,
  rotateSupportIntakeConnector
} from '../services/support-intake';
import { supportIntakeHeadersSchema } from '../services/support-intake-contract';

const revokeConnectorSchema = z.object({
  reason: z.string().trim().min(1).max(1_000)
});

export async function registerSupportIntakeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/intake-connectors', async (request) => {
    return listSupportIntakeConnectors(await getRequestActor(request));
  });

  app.post('/support/intake-connectors', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createSupportIntakeConnectorSchema.parse(request.body);
    const result = await createSupportIntakeConnector(actor, input);
    return reply.code(201).send(result);
  });

  app.post('/support/intake-connectors/:id/rotate', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return rotateSupportIntakeConnector(actor, id);
  });

  app.delete('/support/intake-connectors/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const { reason } = revokeConnectorSchema.parse(request.body);
    return revokeSupportIntakeConnector(actor, id, reason);
  });

  app.get('/support/intake-health', async (request) => {
    return getSupportIntakeHealth(await getRequestActor(request));
  });

  // Encapsulation is load-bearing: only these source-authenticated endpoints replace Fastify's
  // JSON parser with an exact-byte parser. Session-authenticated `/support/*` routes keep normal
  // parsed bodies. Signature verification happens before JSON.parse in the service.
  await app.register(async (rawApp) => {
    rawApp.removeContentTypeParser('application/json');
    rawApp.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    rawApp.addContentTypeParser(/^application\/[a-z0-9!#$&^_.+-]+\+json$/i, { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    rawApp.post('/support/intake/:lookupId/events', async (request, reply) => {
      const { lookupId } = request.params as { lookupId: string };
      if (!Buffer.isBuffer(request.body)) {
        throw new HttpError(415, 'Support intake requires an application/json body');
      }
      const headers = supportIntakeHeadersSchema.parse({
        timestamp: oneHeader(request, 'x-taskara-timestamp'),
        eventId: oneHeader(request, 'x-taskara-event-id'),
        signature: oneHeader(request, 'x-taskara-signature'),
        idempotencyKey: oneHeader(request, 'idempotency-key')
      });
      const accepted = await acceptSupportIntakeEvent({
        lookupId,
        rawBody: request.body,
        headers
      });
      return reply.header('Location', accepted.location).code(202).send(accepted);
    });

    rawApp.get('/support/intake/:lookupId/receipts/:receiptId', async (request) => {
      const { lookupId, receiptId } = request.params as { lookupId: string; receiptId: string };
      return readSupportIntakeReceiptStatus({
        lookupId,
        receiptId,
        bearerSecret: bearerSecret(request)
      });
    });
  });
}

function oneHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerSecret(request: FastifyRequest): string {
  const authorization = oneHeader(request, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!match) throw new HttpError(401, 'Support connector bearer secret is required');
  return match[1];
}
