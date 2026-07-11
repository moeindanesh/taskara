import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerAgentRoutes } from './routes/agent';
import { registerAnnouncementRoutes } from './routes/announcements';
import { registerAiReportRoutes } from './routes/ai-reports';
import { registerAssignmentRoutes } from './routes/assignment';
import { registerAttentionRoutes } from './routes/attention';
import { registerAuthRoutes } from './routes/auth';
import { registerCheckInRoutes } from './routes/check-ins';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerMediaRoutes } from './routes/media';
import { registerMeetingRoutes } from './routes/meetings';
import { registerMilestoneRoutes } from './routes/milestones';
import { registerMattermostRoutes } from './routes/mattermost';
import { registerNotificationRoutes } from './routes/notifications';
import { registerProjectRoutes } from './routes/projects';
import { registerRaycastRoutes } from './routes/raycast';
import { registerSystemRoutes } from './routes/system';
import { registerSyncRoutes } from './routes/sync';
import { registerTaskReviewRoutes } from './routes/task-reviews';
import { registerTaskRoutes } from './routes/tasks';
import { registerTeamRoutes } from './routes/teams';
import { registerTriageRoutes } from './routes/triage';
import { registerUserRoutes } from './routes/users';
import { registerViewRoutes } from './routes/views';
import { registerWorkHealthRoutes } from './routes/work-health';
import { resolveCorsOrigin } from './services/cors';
import { errorMessage, statusCodeFromError } from './services/http';
import { startSyncEventPoller } from './services/sync';

export async function registerApp(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || resolveCorsOrigin(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true
  });
  await app.register(formbody);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        message: 'Validation failed',
        issues: error.issues
      });
    }

    const message = errorMessage(error);
    const status = statusCodeFromError(error, message);
    app.log.error(error);
    return reply.code(status).send({ message });
  });

  await app.register(registerAuthRoutes);
  await app.register(registerSystemRoutes);
  await app.register(registerAnnouncementRoutes);
  await app.register(registerAssignmentRoutes);
  await app.register(registerAttentionRoutes);
  await app.register(registerCheckInRoutes);
  await app.register(registerMeetingRoutes);
  await app.register(registerMilestoneRoutes);
  await app.register(registerKnowledgeRoutes);
  await app.register(registerNotificationRoutes);
  await app.register(registerMediaRoutes);
  await app.register(registerSyncRoutes);
  await app.register(registerTeamRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerProjectRoutes);
  await app.register(registerRaycastRoutes);
  await app.register(registerTaskReviewRoutes);
  await app.register(registerTaskRoutes);
  await app.register(registerTriageRoutes);
  await app.register(registerViewRoutes);
  await app.register(registerWorkHealthRoutes);
  await app.register(registerMattermostRoutes);
  await app.register(registerAgentRoutes);
  await app.register(registerAiReportRoutes);

  startSyncEventPoller();
}
