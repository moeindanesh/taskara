import type { FastifyInstance } from 'fastify';
import {
  carryForwardMeetingActionItemSchema,
  checkInListQuerySchema,
  createCheckInResponseSchema,
  createMeetingActionItemSchema,
  createOneOnOneAgendaItemSchema,
  createOneOnOneSeriesSchema,
  createTaskFromMeetingActionItemSchema,
  meetingActionItemListQuerySchema,
  missingCheckInQuerySchema,
  oneOnOneListQuerySchema,
  updateMeetingActionItemSchema
} from '@taskara/shared';
import { getRequestActor } from '../services/actor';
import {
  addOneOnOneAgendaItem,
  cancelMeetingActionItem,
  carryForwardMeetingActionItem,
  completeMeetingActionItem,
  createCheckInResponse,
  createMeetingActionItem,
  createOneOnOneSeries,
  createTaskFromMeetingActionItem,
  getOneOnOneAgenda,
  listCheckIns,
  listMeetingActionItems,
  listMissingCheckIns,
  listOneOnOnes,
  updateMeetingActionItem
} from '../services/check-ins';

export async function registerCheckInRoutes(app: FastifyInstance): Promise<void> {
  app.get('/check-ins', async (request) => {
    const actor = await getRequestActor(request);
    const query = checkInListQuerySchema.parse(request.query);
    return listCheckIns(actor, query);
  });

  app.post('/check-ins', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createCheckInResponseSchema.parse(request.body);
    const row = await createCheckInResponse(actor, input);
    return reply.code(201).send(row);
  });

  app.get('/check-ins/missing', async (request) => {
    const actor = await getRequestActor(request);
    const query = missingCheckInQuerySchema.parse(request.query);
    return listMissingCheckIns(actor, query.hours);
  });

  app.get('/one-on-ones', async (request) => {
    const actor = await getRequestActor(request);
    const query = oneOnOneListQuerySchema.parse(request.query);
    return listOneOnOnes(actor, query);
  });

  app.post('/one-on-ones', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createOneOnOneSeriesSchema.parse(request.body);
    const series = await createOneOnOneSeries(actor, input);
    return reply.code(201).send(series);
  });

  app.get('/one-on-ones/:id/agenda', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return getOneOnOneAgenda(actor, id);
  });

  app.post('/one-on-ones/:id/agenda-items', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = createOneOnOneAgendaItemSchema.parse(request.body);
    const item = await addOneOnOneAgendaItem(actor, id, input);
    return reply.code(201).send(item);
  });

  app.post('/meetings/:id/action-items', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = createMeetingActionItemSchema.parse(request.body);
    const item = await createMeetingActionItem(actor, id, input);
    return reply.code(201).send(item);
  });

  app.get('/meeting-action-items', async (request) => {
    const actor = await getRequestActor(request);
    const query = meetingActionItemListQuerySchema.parse(request.query);
    return listMeetingActionItems(actor, query);
  });

  app.patch('/meeting-action-items/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = updateMeetingActionItemSchema.parse(request.body);
    return updateMeetingActionItem(actor, id, input);
  });

  app.post('/meeting-action-items/:id/complete', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return completeMeetingActionItem(actor, id);
  });

  app.post('/meeting-action-items/:id/cancel', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return cancelMeetingActionItem(actor, id);
  });

  app.post('/meeting-action-items/:id/carry-forward', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = carryForwardMeetingActionItemSchema.parse(request.body);
    return carryForwardMeetingActionItem(actor, id, input);
  });

  app.post('/meeting-action-items/:id/create-task', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = createTaskFromMeetingActionItemSchema.parse(request.body);
    const result = await createTaskFromMeetingActionItem(actor, id, input);
    return reply.code(201).send(result);
  });
}
