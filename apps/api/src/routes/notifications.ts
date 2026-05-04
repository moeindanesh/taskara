import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@taskara/db';
import { prisma } from '@taskara/db';
import { z } from 'zod';
import { getRequestActor } from '../services/actor';
import {
  encodeNotificationCursor,
  parseNotificationCursor,
  taskInboxNotificationWhere
} from '../services/notifications';

const notificationsQuerySchema = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const notificationsSyncQuerySchema = z.object({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const notificationDeliveredBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200)
});

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', async (request) => {
    const actor = await getRequestActor(request);
    const query = notificationsQuerySchema.parse(request.query);

    const where = taskInboxNotificationWhere(actor.workspace.id, actor.user.id, {
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
          },
          announcement: {
            select: {
              id: true,
              title: true,
              status: true,
              publishedAt: true
            }
          },
          meeting: {
            select: {
              id: true,
              title: true,
              status: true,
              scheduledAt: true,
              heldAt: true
            }
          }
        }
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: taskInboxNotificationWhere(actor.workspace.id, actor.user.id, { unreadOnly: true })
      })
    ]);

    return { items, total, unreadCount, limit: query.limit, offset: query.offset };
  });

  app.get('/notifications/sync', async (request) => {
    const actor = await getRequestActor(request);
    const query = notificationsSyncQuerySchema.parse(request.query);
    const after = parseNotificationCursor(query.after);
    const baseWhere = taskInboxNotificationWhere(actor.workspace.id, actor.user.id);

    const where: Prisma.NotificationWhereInput = after
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } }
              ]
            }
          ]
        }
      : baseWhere;

    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: query.limit,
        include: {
          task: {
            select: {
              id: true,
              key: true,
              title: true,
              status: true,
              priority: true
            }
          },
          announcement: {
            select: {
              id: true,
              title: true,
              status: true,
              publishedAt: true
            }
          },
          meeting: {
            select: {
              id: true,
              title: true,
              status: true,
              scheduledAt: true,
              heldAt: true
            }
          }
        }
      }),
      prisma.notification.count({
        where: taskInboxNotificationWhere(actor.workspace.id, actor.user.id, { unreadOnly: true })
      })
    ]);

    const last = items.at(-1);
    return {
      items,
      unreadCount,
      nextCursor: last ? encodeNotificationCursor({ createdAt: last.createdAt, id: last.id }) : query.after || null
    };
  });

  app.patch('/notifications/:id/read', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };

    const existing = await prisma.notification.findFirst({
      where: {
        id,
        ...taskInboxNotificationWhere(actor.workspace.id, actor.user.id)
      }
    });

    if (!existing) return reply.code(404).send({ message: 'Notification not found' });

    const readAt = existing.readAt ?? new Date();
    const updated = await prisma.notification.update({
      where: { id },
      data: { readAt }
    });

    if (existing.announcementId) {
      await prisma.announcementRecipient.updateMany({
        where: {
          workspaceId: actor.workspace.id,
          announcementId: existing.announcementId,
          userId: actor.user.id,
          readAt: null
        },
        data: { readAt }
      });
    }

    return updated;
  });

  app.post('/notifications/read-all', async (request) => {
    const actor = await getRequestActor(request);
    const where = taskInboxNotificationWhere(actor.workspace.id, actor.user.id, { unreadOnly: true });
    const readAt = new Date();
    const [unreadAnnouncements, result] = await prisma.$transaction(async (tx) => {
      const unreadAnnouncements = await tx.notification.findMany({
        where: { ...where, announcementId: { not: null } },
        select: { announcementId: true }
      });
      const result = await tx.notification.updateMany({
        where,
        data: { readAt }
      });
      return [unreadAnnouncements, result] as const;
    });

    const announcementIds = [
      ...new Set(unreadAnnouncements.map((item) => item.announcementId).filter((id): id is string => Boolean(id)))
    ];
    if (announcementIds.length) {
      await prisma.announcementRecipient.updateMany({
        where: {
          workspaceId: actor.workspace.id,
          userId: actor.user.id,
          announcementId: { in: announcementIds },
          readAt: null
        },
        data: { readAt }
      });
    }

    return { updated: result.count };
  });

  app.post('/notifications/delivered', async (request) => {
    const actor = await getRequestActor(request);
    const body = notificationDeliveredBodySchema.parse(request.body);

    const result = await prisma.notification.updateMany({
      where: {
        id: { in: body.ids },
        deliveredAt: null,
        ...taskInboxNotificationWhere(actor.workspace.id, actor.user.id)
      },
      data: { deliveredAt: new Date() }
    });

    return { updated: result.count };
  });
}
