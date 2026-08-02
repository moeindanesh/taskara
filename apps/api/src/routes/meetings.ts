import type { FastifyInstance } from 'fastify';
import { createMeetingSchema, createMeetingTasksSchema, meetingListQuerySchema, updateMeetingSchema } from '@taskara/shared';
import { getRequestActor } from '../services/actor';
import {
  createMeeting,
  createTasksFromMeeting,
  getMeeting,
  listMeetings,
  sendMeetingSms,
  updateMeeting
} from '../services/meetings';

export async function registerMeetingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meetings', async (request) => {
    const actor = await getRequestActor(request);
    const query = meetingListQuerySchema.parse(request.query);
    return listMeetings(actor, query);
  });

  app.post('/meetings', async (request, reply) => {
    const actor = await getRequestActor(request);
    const input = createMeetingSchema.parse(request.body);
    const meeting = await createMeeting(actor, input);
    return reply.code(201).send(meeting);
  });

  app.get('/meetings/:id', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const meeting = await getMeeting(actor, id);
    if (!meeting) return reply.code(404).send({ message: 'Meeting not found' });
    return meeting;
  });

  app.patch('/meetings/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = updateMeetingSchema.parse(request.body);
    return updateMeeting(actor, id, input);
  });

  app.post('/meetings/:id/tasks', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = createMeetingTasksSchema.parse(request.body);
    const result = await createTasksFromMeeting(actor, id, input);
    return reply.code(201).send(result);
  });

  app.post('/meetings/:id/sms', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return sendMeetingSms(actor, id);
  });
}
