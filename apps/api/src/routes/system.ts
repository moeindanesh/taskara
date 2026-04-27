import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { updateUserSchema } from '@taskara/shared';
import { logActivity } from '../services/audit';
import { getRequestActor, getWorkspaceRole } from '../services/actor';
import { requireSessionUser } from '../services/auth';
import { HttpError } from '../services/http';
import { assignedInboxNotificationWhere } from '../services/notifications';

const meUserSelect = {
  id: true,
  email: true,
  name: true,
  mattermostUserId: true,
  mattermostUsername: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
  onboardingCompletedAt: true
};

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true, service: 'taskara-api' }));

  app.get('/workspaces', async (request) => {
    const user = await requireSessionUser(request);
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true
          }
        }
      }
    });

    return {
      items: memberships.map((membership) => ({
        membershipId: membership.id,
        role: membership.role,
        joinedAt: membership.createdAt,
        workspace: membership.workspace
      })),
      total: memberships.length
    };
  });

  app.get('/me', async (request) => {
    const actor = await getRequestActor(request);
    const role = await getWorkspaceRole(actor.workspace.id, actor.user.id);
    const notifications = await prisma.notification.count({
      where: assignedInboxNotificationWhere(actor.workspace.id, actor.user.id, { unreadOnly: true })
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: actor.user.id },
      select: meUserSelect
    });
    return { workspace: actor.workspace, user, role, unreadNotifications: notifications };
  });

  app.patch('/me', async (request) => {
    const actor = await getRequestActor(request);
    const input = updateUserSchema.parse(request.body);

    if (input.mattermostUsername) {
      const existing = await prisma.user.findUnique({ where: { mattermostUsername: input.mattermostUsername } });
      if (existing && existing.id !== actor.user.id) {
        throw new HttpError(409, 'Mattermost username is already linked to another user');
      }
    }

    const user = await prisma.user.update({
      where: { id: actor.user.id },
      data: input,
      select: meUserSelect
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'user',
      entityId: user.id,
      action: 'profile_updated',
      before: {
        id: actor.user.id,
        email: actor.user.email,
        name: actor.user.name,
        mattermostUsername: actor.user.mattermostUsername,
        avatarUrl: actor.user.avatarUrl
      },
      after: user,
      source: actor.source
    });

    const role = await getWorkspaceRole(actor.workspace.id, actor.user.id);
    const notifications = await prisma.notification.count({
      where: assignedInboxNotificationWhere(actor.workspace.id, actor.user.id, { unreadOnly: true })
    });

    return { workspace: actor.workspace, user, role, unreadNotifications: notifications };
  });

  app.get('/activity', async (request) => {
    const actor = await getRequestActor(request);
    return prisma.activityLog.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { actor: { select: { id: true, name: true, email: true, avatarUrl: true } } }
    });
  });
}
