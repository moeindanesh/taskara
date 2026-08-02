import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { updateUserSchema } from '@taskara/shared';
import { readWorkspaceActivity, redactActivityDependencyPayloads } from '../services/activity-visibility';
import { logActivity } from '../services/audit';
import { getRequestActor, getWorkspaceRole } from '../services/actor';
import { requireSessionUser } from '../services/auth';
import { HttpError } from '../services/http';
import { taskInboxNotificationWhere } from '../services/notifications';
import { resolveWorkspaceAccess } from '../services/team-access';
import { assertPhoneAvailable } from '../services/users';

const meUserSelect = {
  id: true,
  email: true,
  name: true,
  aiModel: true,
  phone: true,
  mattermostUserId: true,
  mattermostUsername: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
  onboardingCompletedAt: true
};

const ACTIVITY_FEED_LIMIT = 50;

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true, service: 'taskara-api' }));

  app.get('/workspaces', async (request) => {
    const user = await requireSessionUser(request);
    // measured-people:allow — Which workspaces this user belongs to; not a people metric.
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
      where: taskInboxNotificationWhere(await resolveWorkspaceAccess(actor), { unreadOnly: true })
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
    await assertPhoneAvailable(input.phone, actor.user.id);

    const user = await prisma.user.update({
      where: { id: actor.user.id },
      data: input,
      select: meUserSelect
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      entityType: 'user',
      entityId: user.id,
      action: 'profile_updated',
      before: {
        id: actor.user.id,
        email: actor.user.email,
        name: actor.user.name,
        phone: actor.user.phone,
        mattermostUsername: actor.user.mattermostUsername,
        avatarUrl: actor.user.avatarUrl
      },
      after: user,
      source: actor.source
    });

    const role = await getWorkspaceRole(actor.workspace.id, actor.user.id);
    const notifications = await prisma.notification.count({
      where: taskInboxNotificationWhere(await resolveWorkspaceAccess(actor), { unreadOnly: true })
    });
    return { workspace: actor.workspace, user, role, unreadNotifications: notifications };
  });

  /**
   * The workspace feed, holding only rows this reader may be shown — see
   * `services/activity-visibility.ts` for why a row is dropped here and a dependency's far end is
   * blanked rather than dropped.
   */
  app.get('/activity', async (request) => {
    const actor = await getRequestActor(request);
    const access = await resolveWorkspaceAccess(actor);
    return redactActivityDependencyPayloads(access, await readWorkspaceActivity(access, ACTIVITY_FEED_LIMIT));
  });
}
