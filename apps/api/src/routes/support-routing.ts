import type { FastifyInstance } from 'fastify';
import { getRequestActor } from '../services/actor';
import {
  activateSupportRoutingPolicy,
  applySupportRouting,
  applySupportRoutingSchema,
  createSupportRoutingPolicySchema,
  createSupportRoutingPolicyVersion,
  decideSupportCasePriority,
  decideSupportPrioritySchema,
  listDepartmentRoutingMembers,
  listSupportRoutingPolicies,
  simulateSupportRouting,
  supportRoutingSimulationSchema,
  updateDepartmentRoutingMember,
  updateSupportRoutingMemberSchema
} from '../services/support-routing';

export async function registerSupportRoutingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/routing/policies', async (request) => {
    return listSupportRoutingPolicies(await getRequestActor(request));
  });

  app.post('/support/routing/policies', async (request, reply) => {
    const policy = await createSupportRoutingPolicyVersion(
      await getRequestActor(request),
      createSupportRoutingPolicySchema.parse(request.body)
    );
    return reply.code(201).send(policy);
  });

  app.post('/support/routing/policies/:id/activate', async (request) => {
    const { id } = request.params as { id: string };
    return activateSupportRoutingPolicy(await getRequestActor(request), id);
  });

  app.get('/support/routing/departments/:departmentId/members', async (request) => {
    const { departmentId } = request.params as { departmentId: string };
    return listDepartmentRoutingMembers(await getRequestActor(request), departmentId);
  });

  app.patch(
    '/support/routing/departments/:departmentId/members/:userId',
    async (request) => {
      const { departmentId, userId } = request.params as {
        departmentId: string;
        userId: string;
      };
      return updateDepartmentRoutingMember(
        await getRequestActor(request),
        departmentId,
        userId,
        updateSupportRoutingMemberSchema.parse(request.body)
      );
    }
  );

  app.post('/support/cases/:idOrKey/routing/simulate', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return simulateSupportRouting(
      await getRequestActor(request),
      idOrKey,
      supportRoutingSimulationSchema.parse(request.body)
    );
  });

  app.post('/support/cases/:idOrKey/routing/apply', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return applySupportRouting(
      await getRequestActor(request),
      idOrKey,
      applySupportRoutingSchema.parse(request.body)
    );
  });

  app.post('/support/cases/:idOrKey/routing/priority', async (request) => {
    const { idOrKey } = request.params as { idOrKey: string };
    return decideSupportCasePriority(
      await getRequestActor(request),
      idOrKey,
      decideSupportPrioritySchema.parse(request.body)
    );
  });
}
