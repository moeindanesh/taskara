import type { FastifyInstance } from 'fastify';
import {
  approveWorkspaceConnectionSchema,
  createDepartmentWorkTargetSchema,
  createLinkedTaskFromSupportCaseSchema,
  createWorkspaceConnectionSchema,
  linkSupportCaseToTaskSchema,
  revokeWorkspaceConnectionSchema,
  unlinkSupportCaseTaskSchema
} from '@taskara/shared';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import {
  approveWorkspaceConnection,
  createDepartmentWorkTarget,
  createLinkedTaskFromSupportCase,
  createWorkspaceConnection,
  linkSupportCaseToTask,
  listDepartmentWorkTargets,
  listEndpointWorkspaceConnections,
  listSupportCaseHandoffOptions,
  listSupportCaseTaskLinks,
  listSupportWorkspaceConnections,
  listTaskSupportCaseLinks,
  listWorkspaceConnectionProjectOptions,
  revokeWorkspaceConnection,
  searchDepartmentWorkTargetTasks,
  unlinkSupportCaseTask,
  updateDepartmentWorkTarget
} from '../services/support-links';

const updateWorkTargetSchema = z.object({
  active: z.boolean().optional(),
  allowCreateTasks: z.boolean().optional(),
  allowLinkTasks: z.boolean().optional()
}).strict();

const taskPickerQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

export async function registerSupportHandoffRoutes(app: FastifyInstance): Promise<void> {
  // Common because the two approvals are deliberately made from different active workspaces.
  app.get('/workspace-connections', async (request) => ({
    items: await listEndpointWorkspaceConnections(await getRequestActor(request))
  }));

  // Compatibility alias; the canonical Support setup route is /support/workspace-connections.
  app.post('/workspace-connections', async (request, reply) => {
    const actor = await getRequestActor(request);
    const result = await createWorkspaceConnection(actor, createWorkspaceConnectionSchema.parse(request.body));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.post('/workspace-connections/:id/approve', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = approveWorkspaceConnectionSchema.parse(request.body);
    if (input.side !== actor.workspace.mode) {
      throw new HttpError(400, 'Approval side must match the current workspace');
    }
    return approveWorkspaceConnection(actor, id);
  });

  app.post('/workspace-connections/:id/revoke', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return revokeWorkspaceConnection(actor, id, revokeWorkspaceConnectionSchema.parse(request.body));
  });

  app.get('/support/workspace-connections', async (request) => ({
    items: await listSupportWorkspaceConnections(await getRequestActor(request))
  }));

  app.post('/support/workspace-connections', async (request, reply) => {
    const actor = await getRequestActor(request);
    const result = await createWorkspaceConnection(actor, createWorkspaceConnectionSchema.parse(request.body));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get('/support/workspace-connections/:id/projects', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return { items: await listWorkspaceConnectionProjectOptions(actor, id) };
  });

  app.get('/support/department-work-targets', async (request) => ({
    items: await listDepartmentWorkTargets(await getRequestActor(request))
  }));

  app.post('/support/department-work-targets', async (request, reply) => {
    const actor = await getRequestActor(request);
    const result = await createDepartmentWorkTarget(actor, createDepartmentWorkTargetSchema.parse(request.body));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.patch('/support/department-work-targets/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return updateDepartmentWorkTarget(actor, id, updateWorkTargetSchema.parse(request.body));
  });

  app.get('/support/department-work-targets/:id/tasks', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return { items: await searchDepartmentWorkTargetTasks(actor, id, taskPickerQuerySchema.parse(request.query)) };
  });

  app.get('/support/cases/:idOrKey/handoff-options', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    return listSupportCaseHandoffOptions(actor, idOrKey);
  });

  app.get('/support/cases/:idOrKey/task-links', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    return listSupportCaseTaskLinks(actor, idOrKey);
  });

  app.post('/support/cases/:idOrKey/task-links', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const result = await linkSupportCaseToTask(actor, idOrKey, linkSupportCaseToTaskSchema.parse(request.body));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.post('/support/cases/:idOrKey/team-tasks', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    const result = await createLinkedTaskFromSupportCase(
      actor,
      idOrKey,
      createLinkedTaskFromSupportCaseSchema.parse(request.body)
    );
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.delete('/support/cases/:idOrKey/task-links/:linkId', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey, linkId } = request.params as { idOrKey: string; linkId: string };
    return unlinkSupportCaseTask(actor, idOrKey, linkId, unlinkSupportCaseTaskSchema.parse(request.body));
  });

  // Team-classified read path. Opening the full Case remains independently Support-authorized.
  app.get('/tasks/:idOrKey/support-case-links', async (request) => {
    const actor = await getRequestActor(request);
    const { idOrKey } = request.params as { idOrKey: string };
    return { items: await listTaskSupportCaseLinks(actor, idOrKey) };
  });
}
