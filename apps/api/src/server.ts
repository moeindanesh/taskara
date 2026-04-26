import Fastify from 'fastify';
import { config } from './config';
import { registerApp } from './app';

const app = Fastify({
  logger: true,
  bodyLimit: config.TASKARA_UPLOAD_MAX_BYTES
});

await registerApp(app);

await app.listen({ host: config.API_HOST, port: config.API_PORT });
