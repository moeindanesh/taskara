import type { FastifyInstance } from 'fastify';
import {
  triageAcceptSchema,
  triageDeclineSchema,
  triageDuplicateSchema,
  triageRequestInfoSchema,
  triageSplitSchema,
  triageSnoozeSchema
} from '@taskara/shared';
import { getRequestActor } from '../services/actor';
import {
  acceptBacklogTask,
  declineBacklogTask,
  markBacklogTaskDuplicate,
  requestBacklogTaskInfo,
  splitBacklogTask,
  snoozeBacklogTask
} from '../services/triage';

export async function registerTriageRoutes(app: FastifyInstance): Promise<void> {
  app.post('/triage/tasks/:idOrKey/accept', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = triageAcceptSchema.parse(request.body);
    return acceptBacklogTask(actor, idOrKey, input);
  });

  app.post('/triage/tasks/:idOrKey/request-info', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = triageRequestInfoSchema.parse(request.body);
    return requestBacklogTaskInfo(actor, idOrKey, input);
  });

  app.post('/triage/tasks/:idOrKey/decline', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = triageDeclineSchema.parse(request.body);
    return declineBacklogTask(actor, idOrKey, input);
  });

  app.post('/triage/tasks/:idOrKey/duplicate', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = triageDuplicateSchema.parse(request.body);
    return markBacklogTaskDuplicate(actor, idOrKey, input);
  });

  app.post('/triage/tasks/:idOrKey/snooze', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = triageSnoozeSchema.parse(request.body);
    return snoozeBacklogTask(actor, idOrKey, input);
  });

  app.post('/triage/tasks/:idOrKey/split', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const input = triageSplitSchema.parse(request.body);
    return splitBacklogTask(actor, idOrKey, input);
  });
}
