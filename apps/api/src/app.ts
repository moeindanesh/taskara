import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config';
import { registerAgentRoutes } from './routes/agent';
import { registerAuthRoutes } from './routes/auth';
import { registerMediaRoutes } from './routes/media';
import { registerMattermostRoutes } from './routes/mattermost';
import { registerNotificationRoutes } from './routes/notifications';
import { registerProjectRoutes } from './routes/projects';
import { registerSystemRoutes } from './routes/system';
import { registerTaskRoutes } from './routes/tasks';
import { registerTeamRoutes } from './routes/teams';
import { registerUserRoutes } from './routes/users';
import { registerViewRoutes } from './routes/views';
import { HttpError } from './services/http';

export async function registerApp(app: FastifyInstance): Promise<void> {
  const allowedOrigins = new Set([
    config.WEB_ORIGIN,
    ...config.TASKARA_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  ]);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true
  });
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: config.TASKARA_UPLOAD_MAX_BYTES,
      files: 1
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        message: 'Validation failed',
        issues: error.issues
      });
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    const status = error instanceof HttpError ? error.statusCode : message.includes('not found') ? 404 : 500;
    app.log.error(error);
    return reply.code(status).send({ message });
  });

  await app.register(registerAuthRoutes);
  await app.register(registerSystemRoutes);
  await app.register(registerNotificationRoutes);
  await app.register(registerMediaRoutes);
  await app.register(registerTeamRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerProjectRoutes);
  await app.register(registerTaskRoutes);
  await app.register(registerViewRoutes);
  await app.register(registerMattermostRoutes);
  await app.register(registerAgentRoutes);
}
