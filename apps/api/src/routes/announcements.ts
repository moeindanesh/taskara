import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@taskara/db';
import { announcementListQuerySchema, createAnnouncementSchema, updateAnnouncementSchema } from '@taskara/shared';
import { getRequestActor, isWorkspaceAdminRole, requireWorkspaceAdmin } from '../services/actor';
import {
  announcementInclude,
  canManageAnnouncement,
  createAnnouncement,
  markAnnouncementRead,
  publishAnnouncement,
  sendAnnouncementSms,
  updateAnnouncement
} from '../services/announcements';

export async function registerAnnouncementRoutes(app: FastifyInstance): Promise<void> {
  app.get('/announcements', async (request) => {
    const actor = await getRequestActor(request);
    const query = announcementListQuerySchema.parse(request.query);
    const isAdmin = isWorkspaceAdminRole(actor.role);

    const where: Prisma.AnnouncementWhereInput = {
      workspaceId: actor.workspace.id,
      status: query.status || (isAdmin ? undefined : 'PUBLISHED')
    };

    if (!isAdmin) {
      where.recipients = { some: { userId: actor.user.id } };
    }

    if (query.unread) {
      where.recipients = { some: { userId: actor.user.id, readAt: null } };
      where.status = 'PUBLISHED';
    }

    if (query.q) {
      where.OR = [
        { title: { contains: query.q, mode: 'insensitive' } },
        { body: { contains: query.q, mode: 'insensitive' } }
      ];
    }

    const [items, total, unreadCount] = await Promise.all([
      prisma.announcement.findMany({
        where,
        include: announcementInclude,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: query.limit,
        skip: query.offset
      }),
      prisma.announcement.count({ where }),
      prisma.announcementRecipient.count({
        where: {
          workspaceId: actor.workspace.id,
          userId: actor.user.id,
          readAt: null,
          announcement: { status: 'PUBLISHED' }
        }
      })
    ]);

    return { items, total, unreadCount, limit: query.limit, offset: query.offset };
  });

  app.post('/announcements', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = createAnnouncementSchema.parse(request.body);
    const announcement = await createAnnouncement(actor, input);
    return reply.code(201).send(announcement);
  });

  app.get('/announcements/:id', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const announcement = await prisma.announcement.findFirst({
      where: { id, workspaceId: actor.workspace.id },
      include: announcementInclude
    });
    if (!announcement) return reply.code(404).send({ message: 'Announcement not found' });

    const isRecipient = announcement.recipients.some((recipient) => recipient.userId === actor.user.id);
    if (!isRecipient && !canManageAnnouncement(actor, announcement.creatorId)) {
      return reply.code(403).send({ message: 'Announcement access denied' });
    }

    return announcement;
  });

  app.patch('/announcements/:id', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    const input = updateAnnouncementSchema.parse(request.body);
    return updateAnnouncement(actor, id, input);
  });

  app.post('/announcements/:id/publish', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return publishAnnouncement(actor, id);
  });

  app.patch('/announcements/:id/read', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return markAnnouncementRead(actor, id);
  });

  app.post('/announcements/:id/sms', async (request) => {
    const actor = await getRequestActor(request);
    const { id } = request.params as { id: string };
    return sendAnnouncementSms(actor, id);
  });
}
