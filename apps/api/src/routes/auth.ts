import type { FastifyInstance } from 'fastify';
import { prisma, type User, type Workspace, type WorkspaceRole } from '@taskara/db';
import {
  acceptWorkspaceInviteSchema,
  authLoginSchema,
  authRegisterSchema,
  createAuthWorkspaceSchema
} from '@taskara/shared';
import {
  buildInviteUrl,
  createUserSession,
  displayNameFromEmail,
  getBearerToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  requireSessionUser,
  verifyPassword
} from '../services/auth';
import { HttpError } from '../services/http';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/onboarding', async (request) => {
    const user = await requireSessionUser(request).catch(() => null);
    if (!user) return { needsOnboarding: false, workspace: null, workspaces: [] };

    const memberships = await listUserWorkspaceMemberships(user.id);
    return {
      needsOnboarding: memberships.length === 0,
      workspace: memberships[0]?.workspace ?? null,
      workspaces: memberships
    };
  });

  app.post('/auth/register', async (request, reply) => {
    const input = authRegisterSchema.parse(request.body);
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing?.passwordHash) throw new HttpError(409, 'An account with this email already exists');

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            passwordHash,
            onboardingCompletedAt: new Date()
          }
        })
      : await prisma.user.create({
          data: {
            email,
            name: input.name,
            passwordHash,
            onboardingCompletedAt: new Date()
          }
        });

    const membership = await firstUserWorkspaceMembership(user.id);
    const session = await createUserSession(user.id);
    return reply.code(201).send(authResponse({ user, membership }, session));
  });

  app.post('/auth/login', async (request, reply) => {
    const input = authLoginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(input.email) } });

    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new HttpError(401, 'Invalid email or password');
    }

    const membership = input.workspaceSlug
      ? await userWorkspaceMembershipForSlug(user.id, input.workspaceSlug)
      : await firstUserWorkspaceMembership(user.id);

    if (input.workspaceSlug && !membership) throw new HttpError(403, 'User is not a member of this workspace');

    const session = await createUserSession(user.id);
    return reply.send(authResponse({ user, membership }, session));
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = getBearerToken(request);
    if (token) {
      await prisma.authSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    return reply.code(204).send();
  });

  app.get('/auth/workspaces', async (request) => {
    const user = await requireSessionUser(request);
    const memberships = await listUserWorkspaceMemberships(user.id);
    return {
      items: memberships,
      total: memberships.length,
      user: pickPublicUser(user)
    };
  });

  app.post('/auth/workspaces', async (request, reply) => {
    const user = await requireSessionUser(request);
    const input = createAuthWorkspaceSchema.parse(request.body);

    const existing = await prisma.workspace.findUnique({ where: { slug: input.slug } });
    if (existing) {
      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: existing.id, userId: user.id } },
        include: { workspace: true }
      });
      if (membership) {
        const session = await createUserSession(user.id);
        return reply.send(authResponse({ user, membership }, session));
      }
      throw new HttpError(409, 'Workspace slug is already taken');
    }

    const membership = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description
        }
      });

      return tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: 'OWNER'
        },
        include: { workspace: true }
      });
    });

    const session = await createUserSession(user.id);
    return reply.code(201).send(authResponse({ user, membership }, session));
  });

  app.post('/auth/onboarding', async (request, reply) => {
    const user = await requireSessionUser(request);
    const input = createAuthWorkspaceSchema.parse(request.body);
    const existing = await prisma.workspace.findUnique({ where: { slug: input.slug } });
    if (existing) throw new HttpError(409, 'Workspace slug is already taken');

    const membership = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description
        }
      });

      return tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: 'OWNER'
        },
        include: { workspace: true }
      });
    });

    const session = await createUserSession(user.id);
    return reply.code(201).send(authResponse({ user, membership }, session));
  });

  app.get('/auth/invites/:token', async (request) => {
    const { token } = request.params as { token: string };
    const invite = await getUsableInvite(token);

    return {
      id: invite.id,
      email: invite.email,
      name: invite.name,
      role: invite.role,
      expiresAt: invite.expiresAt,
      inviteUrl: buildInviteUrl(token),
      workspace: {
        id: invite.workspace.id,
        name: invite.workspace.name,
        slug: invite.workspace.slug
      }
    };
  });

  app.post('/auth/invites/:token/accept', async (request, reply) => {
    const { token } = request.params as { token: string };
    const input = acceptWorkspaceInviteSchema.parse(request.body);
    const passwordHash = await hashPassword(input.password);
    const tokenHash = hashToken(token);

    const result = await prisma.$transaction(async (tx) => {
      const invite = await tx.workspaceInvite.findUnique({
        where: { tokenHash },
        include: { workspace: true }
      });

      assertInviteUsable(invite);

      const email = normalizeEmail(invite.email);
      const user = await tx.user.upsert({
        where: { email },
        update: {
          name: input.name,
          passwordHash,
          onboardingCompletedAt: new Date()
        },
        create: {
          email,
          name: input.name || invite.name || displayNameFromEmail(email),
          passwordHash,
          onboardingCompletedAt: new Date()
        }
      });

      const membership = await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
        update: { role: invite.role },
        create: {
          workspaceId: invite.workspaceId,
          userId: user.id,
          role: invite.role
        },
        include: { workspace: true }
      });

      await tx.workspaceInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          acceptedById: user.id,
          token: null
        }
      });

      return { user, membership };
    });

    const session = await createUserSession(result.user.id);
    return reply.send(authResponse(result, session));
  });
}

async function firstUserWorkspaceMembership(userId: string) {
  return prisma.workspaceMember.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    include: { workspace: true }
  });
}

async function userWorkspaceMembershipForSlug(userId: string, workspaceSlug: string) {
  return prisma.workspaceMember.findFirst({
    where: {
      userId,
      workspace: { slug: workspaceSlug }
    },
    include: { workspace: true }
  });
}

async function listUserWorkspaceMemberships(userId: string) {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
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

  return memberships.map((membership) => ({
    membershipId: membership.id,
    role: membership.role,
    joinedAt: membership.createdAt,
    workspace: membership.workspace
  }));
}

async function getUsableInvite(token: string) {
  const invite = await prisma.workspaceInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { workspace: true }
  });
  assertInviteUsable(invite);
  return invite;
}

function assertInviteUsable(
  invite:
    | ({
        acceptedAt: Date | null;
        revokedAt: Date | null;
        expiresAt: Date;
      } & Record<string, unknown>)
    | null
): asserts invite is NonNullable<typeof invite> {
  if (!invite) throw new HttpError(404, 'Invite not found');
  if (invite.acceptedAt) throw new HttpError(410, 'Invite has already been accepted');
  if (invite.revokedAt) throw new HttpError(410, 'Invite has been revoked');
  if (invite.expiresAt <= new Date()) throw new HttpError(410, 'Invite has expired');
}

function pickPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    mattermostUsername: user.mattermostUsername
  };
}

function authResponse(
  result: {
    user: User;
    membership: {
      role: WorkspaceRole;
      workspace: Workspace;
    } | null;
  },
  session: Awaited<ReturnType<typeof createUserSession>>
) {
  const workspace = result.membership?.workspace ?? null;
  return {
    token: session.token,
    expiresAt: session.session.expiresAt,
    workspace: workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          description: workspace.description
        }
      : null,
    user: pickPublicUser(result.user),
    role: result.membership?.role ?? null
  };
}
