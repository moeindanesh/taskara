import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma, type WorkspaceRole } from '@taskara/db';
import {
  createUserSchema,
  createWorkspaceInviteSchema,
  setWorkspaceRoleSchema,
  updateUserSchema,
  userListQuerySchema
} from '@taskara/shared';
import { config } from '../config';
import { getRequestActor, requireWorkspaceAdmin } from '../services/actor';
import { logActivity } from '../services/audit';
import { buildInviteUrl, createRawToken, hashToken, normalizeEmail } from '../services/auth';
import { HttpError } from '../services/http';
import { assertPhoneAvailable } from '../services/users';

const userSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  mattermostUserId: true,
  mattermostUsername: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.UserSelect;

type WorkspaceInviteWithInviter = Prisma.WorkspaceInviteGetPayload<{
  include: { invitedBy: { select: typeof userSelect } };
}>;

function serializeWorkspaceInvite(invite: WorkspaceInviteWithInviter, token = invite.token) {
  return {
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    invitedBy: invite.invitedBy,
    inviteUrl: token ? buildInviteUrl(token) : null
  };
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', async (request) => {
    const actor = await getRequestActor(request);
    const query = userListQuerySchema.parse(request.query);
    const userFilter: Prisma.UserWhereInput | undefined = query.q
      ? {
          OR: [
            { email: { contains: query.q, mode: 'insensitive' } },
            { name: { contains: query.q, mode: 'insensitive' } },
            { phone: { contains: query.q, mode: 'insensitive' } },
            { mattermostUsername: { contains: query.q, mode: 'insensitive' } }
          ]
        }
      : undefined;

    const where: Prisma.WorkspaceMemberWhereInput = {
      workspaceId: actor.workspace.id,
      role: query.role,
      user: userFilter
    };

    const [members, total] = await Promise.all([
      prisma.workspaceMember.findMany({
        where,
        orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
        take: query.limit,
        skip: query.offset,
        include: {
          user: {
            select: {
              ...userSelect,
              _count: {
                select: {
                  assignedTasks: true,
                  reportedTasks: true,
                  comments: true
                }
              }
            }
          }
        }
      }),
      prisma.workspaceMember.count({ where })
    ]);

    return {
      items: members.map((member) => ({
        membershipId: member.id,
        role: member.role,
        joinedAt: member.createdAt,
        ...member.user
      })),
      total,
      limit: query.limit,
      offset: query.offset
    };
  });

  app.get('/users/invites', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const invites = await prisma.workspaceInvite.findMany({
      where: {
        workspaceId: actor.workspace.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' },
      include: {
        invitedBy: { select: userSelect }
      },
      take: 100
    });

    return {
      items: invites.map((invite) => serializeWorkspaceInvite(invite)),
      total: invites.length,
      limit: 100,
      offset: 0
    };
  });

  app.post('/users/invites', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = createWorkspaceInviteSchema.parse(request.body);
    assertOwnerRoleManageAllowed(actor.role, undefined, input.role);

    const token = createRawToken();
    const expiresAt = new Date(Date.now() + (input.expiresInDays || config.TASKARA_INVITE_TTL_DAYS) * 24 * 60 * 60 * 1000);
    const email = normalizeEmail(input.email);

    const invite = await prisma.$transaction(async (tx) => {
      await tx.workspaceInvite.updateMany({
        where: {
          workspaceId: actor.workspace.id,
          email,
          acceptedAt: null,
          revokedAt: null
        },
        data: { revokedAt: new Date() }
      });

      return tx.workspaceInvite.create({
        data: {
          workspaceId: actor.workspace.id,
          email,
          name: input.name,
          role: input.role,
          token,
          tokenHash: hashToken(token),
          invitedById: actor.user.id,
          expiresAt
        },
        include: { invitedBy: { select: userSelect } }
      });
    });

    const result = serializeWorkspaceInvite(invite, token);

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'workspace_invite',
      entityId: invite.id,
      action: 'created',
      after: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
      source: actor.source
    });

    return reply.code(201).send(result);
  });

  app.post('/users/invites/:id/link', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { id } = request.params as { id: string };
    const invite = await prisma.workspaceInvite.findFirst({
      where: {
        id,
        workspaceId: actor.workspace.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      include: { invitedBy: { select: userSelect } }
    });
    if (!invite) return reply.code(404).send({ message: 'Invite not found' });

    if (invite.token) return serializeWorkspaceInvite(invite);

    const token = createRawToken();
    const updated = await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: {
        token,
        tokenHash: hashToken(token)
      },
      include: { invitedBy: { select: userSelect } }
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'workspace_invite',
      entityId: updated.id,
      action: 'link_created',
      after: { email: updated.email, role: updated.role, expiresAt: updated.expiresAt },
      source: actor.source
    });

    return serializeWorkspaceInvite(updated, token);
  });

  app.delete('/users/invites/:id', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { id } = request.params as { id: string };
    const invite = await prisma.workspaceInvite.findFirst({
      where: { id, workspaceId: actor.workspace.id, acceptedAt: null, revokedAt: null }
    });
    if (!invite) return reply.code(404).send({ message: 'Invite not found' });

    await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date(), token: null }
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'workspace_invite',
      entityId: invite.id,
      action: 'revoked',
      before: { email: invite.email, role: invite.role },
      source: actor.source
    });

    return reply.code(204).send();
  });

  app.post('/users', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = createUserSchema.parse(request.body);

    const existingByMattermost = input.mattermostUsername
      ? await prisma.user.findUnique({ where: { mattermostUsername: input.mattermostUsername } })
      : null;
    if (existingByMattermost && existingByMattermost.email !== input.email) {
      throw new HttpError(409, 'Mattermost username is already linked to another user');
    }
    const existingByPhone = input.phone ? await prisma.user.findUnique({ where: { phone: input.phone } }) : null;
    if (existingByPhone && existingByPhone.email !== input.email) {
      throw new HttpError(409, 'Phone number is already linked to another user');
    }

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email: input.email },
        update: {
          name: input.name,
          phone: input.phone,
          mattermostUsername: input.mattermostUsername,
          avatarUrl: input.avatarUrl
        },
        create: {
          email: input.email,
          name: input.name,
          phone: input.phone,
          mattermostUsername: input.mattermostUsername,
          avatarUrl: input.avatarUrl
        },
        select: userSelect
      });

      const existingMembership = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: user.id } },
        select: { role: true }
      });
      assertOwnerRoleManageAllowed(actor.role, existingMembership?.role, input.role);
      if (existingMembership) {
        await assertOwnerChangeIsSafeWithClient(tx, actor.workspace.id, existingMembership.role, input.role);
      }

      const membership = await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: user.id } },
        update: { role: input.role },
        create: { workspaceId: actor.workspace.id, userId: user.id, role: input.role }
      });

      return { ...user, membershipId: membership.id, role: membership.role, joinedAt: membership.createdAt };
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'user',
      entityId: result.id,
      action: 'upserted',
      after: result,
      source: actor.source
    });

    return reply.code(201).send(result);
  });

  app.patch('/users/:id', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { id } = request.params as { id: string };
    const input = updateUserSchema.parse(request.body);

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: id } },
      include: { user: true }
    });
    if (!membership) return reply.code(404).send({ message: 'User not found in this workspace' });

    if (input.mattermostUsername) {
      const existing = await prisma.user.findUnique({ where: { mattermostUsername: input.mattermostUsername } });
      if (existing && existing.id !== id) throw new HttpError(409, 'Mattermost username is already linked to another user');
    }
    await assertPhoneAvailable(input.phone, id);

    const user = await prisma.user.update({
      where: { id },
      data: input,
      select: userSelect
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'user',
      entityId: user.id,
      action: 'updated',
      before: membership.user,
      after: user,
      source: actor.source
    });

    return { ...user, membershipId: membership.id, role: membership.role, joinedAt: membership.createdAt };
  });

  app.patch('/users/:id/role', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { id } = request.params as { id: string };
    const input = setWorkspaceRoleSchema.parse(request.body);

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: id } },
      include: { user: { select: userSelect } }
    });
    if (!membership) return reply.code(404).send({ message: 'User not found in this workspace' });

    assertOwnerRoleManageAllowed(actor.role, membership.role, input.role);
    await assertOwnerChangeIsSafe(actor.workspace.id, membership.role, input.role);

    const updated = await prisma.workspaceMember.update({
      where: { id: membership.id },
      data: { role: input.role },
      include: { user: { select: userSelect } }
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'workspace_member',
      entityId: updated.id,
      action: 'role_updated',
      before: { userId: id, role: membership.role },
      after: { userId: id, role: updated.role },
      source: actor.source
    });

    return { membershipId: updated.id, role: updated.role, joinedAt: updated.createdAt, ...updated.user };
  });

  app.delete('/users/:id/membership', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { id } = request.params as { id: string };
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: id } },
      include: { user: { select: userSelect } }
    });
    if (!membership) return reply.code(404).send({ message: 'User not found in this workspace' });

    assertOwnerRoleManageAllowed(actor.role, membership.role, 'MEMBER');
    if (membership.role === 'OWNER') await assertOwnerChangeIsSafe(actor.workspace.id, membership.role, 'MEMBER');

    const cleanup = await prisma.$transaction(async (tx) => {
      const teamMemberships = await tx.teamMember.deleteMany({
        where: { userId: id, team: { workspaceId: actor.workspace.id } }
      });
      const projectMemberships = await tx.projectMember.deleteMany({
        where: { userId: id, project: { workspaceId: actor.workspace.id } }
      });
      const ledProjects = await tx.project.updateMany({
        where: { workspaceId: actor.workspace.id, leadId: id },
        data: { leadId: null }
      });
      const assignedTasks = await tx.task.updateMany({
        where: { workspaceId: actor.workspace.id, assigneeId: id },
        data: { assigneeId: null }
      });
      const notifications = await tx.notification.deleteMany({
        where: { workspaceId: actor.workspace.id, userId: id }
      });
      await tx.workspaceMember.delete({ where: { id: membership.id } });

      return {
        teamMemberships: teamMemberships.count,
        projectMemberships: projectMemberships.count,
        ledProjects: ledProjects.count,
        assignedTasks: assignedTasks.count,
        notifications: notifications.count
      };
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'workspace_member',
      entityId: membership.id,
      action: 'removed',
      before: { userId: id, role: membership.role },
      after: cleanup,
      source: actor.source
    });

    return reply.code(204).send();
  });
}

function assertOwnerRoleManageAllowed(actorRole: WorkspaceRole, currentRole: WorkspaceRole | undefined, nextRole: WorkspaceRole): void {
  const touchesOwner = currentRole === 'OWNER' || nextRole === 'OWNER';
  if (!touchesOwner || actorRole === 'OWNER') return;
  throw new HttpError(403, 'Only workspace owners can grant, revoke, or remove owner access');
}

async function assertOwnerChangeIsSafe(workspaceId: string, currentRole: WorkspaceRole, nextRole: WorkspaceRole): Promise<void> {
  return assertOwnerChangeIsSafeWithClient(prisma, workspaceId, currentRole, nextRole);
}

async function assertOwnerChangeIsSafeWithClient(
  client: Pick<typeof prisma, 'workspaceMember'> | Prisma.TransactionClient,
  workspaceId: string,
  currentRole: WorkspaceRole,
  nextRole: WorkspaceRole
): Promise<void> {
  if (currentRole !== 'OWNER' || nextRole === 'OWNER') return;

  const ownerCount = await client.workspaceMember.count({
    where: { workspaceId, role: 'OWNER' }
  });
  if (ownerCount <= 1) {
    throw new HttpError(409, 'Cannot remove or demote the last workspace owner');
  }
}
