import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { updateUserSchema } from '@taskara/shared';
import { readWorkspaceActivity, redactActivityDependencyPayloads } from '../services/activity-visibility';
import { logActivity } from '../services/audit';
import { getRequestActor, getWorkspaceRole, type RequestActor } from '../services/actor';
import { requireSessionUser } from '../services/auth';
import { HttpError } from '../services/http';
import { inboxNotificationWhereForActor } from '../services/notifications';
import { resolveWorkspaceAccess } from '../services/team-access';
import { supportQueueCounts } from '../services/support-cases';
import { resolveSupportAccess, type SupportAccess } from '../services/support-access';
import { supportDataEncryptionAvailable } from '../services/support-crypto';
import { assertPhoneAvailable } from '../services/users';
import { workspaceCapabilities, workspacePermissions } from '../services/workspace-mode';

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
            description: true,
            mode: true
          }
        }
      }
    });

    return {
      items: memberships.map((membership) => {
        const capabilities = workspaceCapabilities(membership.workspace.mode);
        const permissions = workspacePermissions(membership.workspace.mode, membership.role);
        return {
          membershipId: membership.id,
          role: membership.role,
          joinedAt: membership.createdAt,
          workspace: { ...membership.workspace, capabilities },
          capabilities,
          permissions
        };
      }),
      total: memberships.length
    };
  });

  app.get('/me', async (request) => {
    const actor = await getRequestActor(request);
    const role = await getWorkspaceRole(actor.workspace.id, actor.user.id);
    const notifications = await prisma.notification.count({
      where: await inboxNotificationWhereForActor(actor, { unreadOnly: true })
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: actor.user.id },
      select: meUserSelect
    });
    const profile = await workspaceActorProfile(actor);
    return {
      workspace: { ...actor.workspace, capabilities: profile.capabilities },
      user,
      role,
      capabilities: profile.capabilities,
      permissions: profile.permissions,
      ...profile.supportFields,
      unreadNotifications: notifications
    };
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
      where: await inboxNotificationWhereForActor(actor, { unreadOnly: true })
    });
    const profile = await workspaceActorProfile(actor);
    return {
      workspace: { ...actor.workspace, capabilities: profile.capabilities },
      user,
      role,
      capabilities: profile.capabilities,
      permissions: profile.permissions,
      ...profile.supportFields,
      unreadNotifications: notifications
    };
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

async function workspaceActorProfile(actor: RequestActor) {
  const capabilities = workspaceCapabilities(actor.workspace.mode);
  if (actor.workspace.mode !== 'SUPPORT') {
    return {
      capabilities,
      permissions: workspacePermissions(actor.workspace.mode, actor.role),
      supportFields: {}
    };
  }

  const access = await resolveSupportAccess(actor);
  const [activeDepartmentCount, counts] = await Promise.all([
    prisma.department.count({ where: { workspaceId: actor.workspace.id, active: true } }),
    supportQueueCounts(access)
  ]);
  return {
    capabilities,
    permissions: supportPermissionsForActor(actor, access),
    supportFields: {
      supportAccessEpoch: access.epoch.toString(),
      support: {
        needsSetup: activeDepartmentCount === 0,
        interactionContentAvailable: supportDataEncryptionAvailable(),
        manualCallAvailable: supportDataEncryptionAvailable(),
        unassignedCount: counts.TRIAGE ?? 0,
        departmentInboxCount: counts.DEPARTMENT_INBOX ?? 0,
        myCaseCount: counts.MY_CASES ?? 0,
        needsAttentionCount: counts.NEEDS_ATTENTION ?? 0
      }
    }
  };
}

function supportPermissionsForActor(actor: RequestActor, access: SupportAccess): string[] {
  // An agent credential's WorkspaceRole authenticates membership only. It is never a shortcut to
  // human OWNER/ADMIN Support permissions.
  const permissions = new Set<string>(workspacePermissions(
    actor.workspace.mode,
    actor.credential ? 'MEMBER' : actor.role
  ));
  if (access.canConfigure) {
    permissions.add('support.setup');
    permissions.add('support.departments.manage');
  }
  if (access.canConfigure || access.supervisor || access.managedDepartmentIds.length) {
    permissions.add('support.reports.read');
  }
  if (access.canIntake) permissions.add('support.cases.create');
  if (access.triager) permissions.add('support.triage.read');
  if (access.workspaceWide || access.managedDepartmentIds.length) {
    permissions.add('support.department-inbox.read');
  }
  if (access.workspaceWide || access.memberMembershipIds.length) {
    permissions.add('support.cases.mine.read');
  }
  if (
    access.workspaceWide
    || access.triager
    || access.managedDepartmentIds.length
    || access.memberMembershipIds.length
  ) permissions.add('support.recovery.read');
  return [...permissions];
}
