import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@taskara/db';
import { z } from 'zod';
import { config } from '../config';
import { getRequestActor } from '../services/actor';
import { getBearerToken } from '../services/auth';
import { HttpError } from '../services/http';
import { buildTaskaraCreateTaskRaycastScript, buildTaskaraOpenRaycastScript } from '../services/raycast-scripts';

const raycastTaskScriptQuerySchema = z.object({
  projectId: z.string().uuid()
});

export async function registerRaycastRoutes(app: FastifyInstance): Promise<void> {
  app.get('/raycast/scripts/taskara.bash', async (request, reply) => {
    const actor = await getRequestActor(request);
    const token = getBearerToken(request);
    if (!token) throw new HttpError(401, 'Authentication required');

    const query = raycastTaskScriptQuerySchema.parse(request.query);
    const project = await prisma.project.findFirst({
      where: {
        id: query.projectId,
        workspaceId: actor.workspace.id
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true
      }
    });
    if (!project) throw new HttpError(404, 'Project not found');

    const script = buildTaskaraCreateTaskRaycastScript({
      apiUrl: publicApiUrl(request),
      authToken: token,
      project,
      user: actor.user,
      workspace: actor.workspace
    });

    return sendScript(reply, script, 'taskara.bash');
  });

  app.get('/raycast/scripts/open-taskara.bash', async (request, reply) => {
    const actor = await getRequestActor(request);
    const appUrl = new URL(`/${encodeURIComponent(actor.workspace.slug)}/team/all/all`, config.WEB_ORIGIN).toString();
    return sendScript(reply, buildTaskaraOpenRaycastScript(appUrl), 'open-taskara.bash');
  });
}

function sendScript(reply: FastifyReply, script: string, filename: string) {
  return reply
    .header('content-type', 'text/x-shellscript; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(script);
}

function publicApiUrl(request: FastifyRequest): string {
  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const proto = forwardedProto || (request as FastifyRequest & { protocol?: string }).protocol || 'http';
  const host = forwardedHost || request.headers.host;
  if (!host) throw new HttpError(500, 'Cannot determine API host');
  return `${proto}://${host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || undefined;
}
