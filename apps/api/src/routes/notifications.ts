import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import { assignedInboxNotificationWhere } from '../services/notifications';

const notificationsQuerySchema = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', async (request) => {
    const actor = await getRequestActor(request);
    const query = notificationsQuerySchema.parse(request.query);

    const where = assignedInboxNotificationWhere(actor.workspace.id, actor.user.id, {
      unreadOnly: query.unread
    });

    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
        include: {
          task: {
            select: {
              id: true,
              key: true,
              title: true,
              status: true,
              priority: true
            }
          }
        }
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: assignedInboxNotificationWhere(actor.workspace.id, actor.user.id, { unreadOnly: true })
      })
    ]);

    return { items, total, unreadCount, limit: query.limit, offset: query.offset };
  });

  app.patch('/notifications/:id/read', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.notification.findFirst({
      where: {
        id,
        ...assignedInboxNotificationWhere(actor.workspace.id, actor.user.id)
      }
    });

    if (!existing) return reply.code(404).send({ message: 'Notification not found' });

    return prisma.notification.update({
      where: { id },
      data: { readAt: existing.readAt ?? new Date() }
    });
  });

  app.post('/notifications/read-all', async (request) => {
    const actor = await getRequestActor(request);
    const result = await prisma.notification.updateMany({
      where: assignedInboxNotificationWhere(actor.workspace.id, actor.user.id, { unreadOnly: true }),
      data: { readAt: new Date() }
    });

    return { updated: result.count };
  });
}
