import type { FastifyInstance } from 'fastify';
import { getRequestActor } from '../services/actor';
import {
  applySupportEnablement,
  applySupportEnablementSchema,
  approveSupportEnablementDefinition,
  changeSupportProblemClusterCaseSchema,
  createSupportEnablementDefinitionSchema,
  createSupportEnablementDefinitionVersion,
  createSupportKnowledgeGap,
  createSupportKnowledgeGapSchema,
  createSupportProblemCluster,
  createSupportProblemClusterSchema,
  evaluateSupportAutomations,
  getSupportProblemCluster,
  linkSupportProblemClusterCase,
  listSupportCaseKnowledgeUses,
  listSupportEnablementDefinitions,
  listSupportEnablementDefinitionsSchema,
  listSupportKnowledgeGaps,
  listSupportKnowledgeGapsSchema,
  listSupportProblemClusters,
  listSupportProblemClustersSchema,
  previewSupportEnablement,
  previewSupportEnablementSchema,
  recordSupportCaseKnowledgeUse,
  recordSupportKnowledgeUseSchema,
  retireSupportEnablementDefinition,
  searchSupportKnowledgeForCase,
  searchSupportKnowledgeSchema,
  undoSupportEnablementApplication,
  undoSupportEnablementSchema,
  unlinkSupportProblemClusterCase,
  updateSupportKnowledgeGap,
  updateSupportKnowledgeGapSchema,
  updateSupportProblemCluster,
  updateSupportProblemClusterSchema
} from '../services/support-enablement';

export async function registerSupportEnablementRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/enablement/definitions', async (request) => {
    return listSupportEnablementDefinitions(
      await getRequestActor(request),
      listSupportEnablementDefinitionsSchema.parse(request.query)
    );
  });

  app.post('/support/enablement/definitions', async (request, reply) => {
    const definition = await createSupportEnablementDefinitionVersion(
      await getRequestActor(request),
      createSupportEnablementDefinitionSchema.parse(request.body)
    );
    return reply.code(201).send(definition);
  });

  app.post('/support/enablement/definitions/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    return approveSupportEnablementDefinition(await getRequestActor(request), id);
  });

  app.post('/support/enablement/definitions/:id/retire', async (request) => {
    const { id } = request.params as { id: string };
    return retireSupportEnablementDefinition(await getRequestActor(request), id);
  });

  app.post('/support/cases/:idOrKey/automation-evaluations', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return evaluateSupportAutomations(
      await getRequestActor(request),
      idOrKey,
      previewSupportEnablementSchema.parse(request.body)
    );
  });

  app.post('/support/cases/:idOrKey/enablement/:definitionId/preview', async (request) => {
    const { idOrKey, definitionId } = request.params as {
      idOrKey: string;
      definitionId: string;
    };
    return previewSupportEnablement(
      await getRequestActor(request),
      idOrKey,
      definitionId,
      previewSupportEnablementSchema.parse(request.body)
    );
  });

  app.post('/support/cases/:idOrKey/enablement/:definitionId/apply', async (request) => {
    const { idOrKey, definitionId } = request.params as {
      idOrKey: string;
      definitionId: string;
    };
    return applySupportEnablement(
      await getRequestActor(request),
      idOrKey,
      definitionId,
      applySupportEnablementSchema.parse(request.body)
    );
  });

  app.post('/support/enablement/applications/:id/undo', async (request) => {
    const { id } = request.params as { id: string };
    return undoSupportEnablementApplication(
      await getRequestActor(request),
      id,
      undoSupportEnablementSchema.parse(request.body)
    );
  });

  app.get('/support/problem-clusters', async (request) => {
    return listSupportProblemClusters(
      await getRequestActor(request),
      listSupportProblemClustersSchema.parse(request.query)
    );
  });

  app.post('/support/problem-clusters', async (request, reply) => {
    const cluster = await createSupportProblemCluster(
      await getRequestActor(request),
      createSupportProblemClusterSchema.parse(request.body)
    );
    return reply.code(201).send(cluster);
  });

  app.get('/support/problem-clusters/:id', async (request) => {
    const { id } = request.params as { id: string };
    return getSupportProblemCluster(await getRequestActor(request), id);
  });

  app.patch('/support/problem-clusters/:id', async (request) => {
    const { id } = request.params as { id: string };
    return updateSupportProblemCluster(
      await getRequestActor(request),
      id,
      updateSupportProblemClusterSchema.parse(request.body)
    );
  });

  app.post('/support/problem-clusters/:clusterId/cases/:idOrKey', async (request) => {
    const { clusterId, idOrKey } = request.params as {
      clusterId: string;
      idOrKey: string;
    };
    return linkSupportProblemClusterCase(
      await getRequestActor(request),
      clusterId,
      idOrKey,
      changeSupportProblemClusterCaseSchema.parse(request.body)
    );
  });

  app.delete('/support/problem-clusters/:clusterId/cases/:idOrKey', async (request, reply) => {
    const { clusterId, idOrKey } = request.params as {
      clusterId: string;
      idOrKey: string;
    };
    await unlinkSupportProblemClusterCase(
      await getRequestActor(request),
      clusterId,
      idOrKey,
      changeSupportProblemClusterCaseSchema.parse(request.body)
    );
    return reply.code(204).send();
  });

  app.get('/support/cases/:idOrKey/knowledge/search', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return searchSupportKnowledgeForCase(
      await getRequestActor(request),
      idOrKey,
      searchSupportKnowledgeSchema.parse(request.query)
    );
  });

  app.get('/support/cases/:idOrKey/knowledge/uses', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return listSupportCaseKnowledgeUses(await getRequestActor(request), idOrKey);
  });

  app.post('/support/cases/:idOrKey/knowledge/uses', async (request, reply) => {
    const { idOrKey } = request.params as { idOrKey: string };
    const use = await recordSupportCaseKnowledgeUse(
      await getRequestActor(request),
      idOrKey,
      recordSupportKnowledgeUseSchema.parse(request.body)
    );
    return reply.code(201).send(use);
  });

  app.post('/support/cases/:idOrKey/knowledge/gaps', async (request, reply) => {
    const { idOrKey } = request.params as { idOrKey: string };
    const gap = await createSupportKnowledgeGap(
      await getRequestActor(request),
      idOrKey,
      createSupportKnowledgeGapSchema.parse(request.body)
    );
    return reply.code(201).send(gap);
  });

  app.get('/support/knowledge/gaps', async (request) => {
    return listSupportKnowledgeGaps(
      await getRequestActor(request),
      listSupportKnowledgeGapsSchema.parse(request.query)
    );
  });

  app.patch('/support/knowledge/gaps/:id', async (request) => {
    const { id } = request.params as { id: string };
    return updateSupportKnowledgeGap(
      await getRequestActor(request),
      id,
      updateSupportKnowledgeGapSchema.parse(request.body)
    );
  });
}
