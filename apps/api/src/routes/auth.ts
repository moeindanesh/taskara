import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { prisma, type User, type Workspace, type WorkspaceRole } from '@taskara/db';
import {
  acceptWorkspaceInviteSchema,
  authLoginSchema,
  authPasswordResetSmsCompleteSchema,
  authPasswordResetSmsLookupSchema,
  authPasswordResetSmsRequestSchema,
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
import { sendOTPSms } from '../services/sms';

const passwordResetCodeTtlMs = 10 * 60 * 1000;
const passwordResetCodeCooldownMs = 60 * 1000;
const passwordResetMaxAttempts = 5;

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
    return reply.code(201).send(await authResponse({ user, membership }, session));
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
    return reply.send(await authResponse({ user, membership }, session));
  });

  app.post('/auth/password-reset/sms/options', async (request) => {
    const input = authPasswordResetSmsLookupSchema.parse(request.body);
    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(input.email) },
      select: { phone: true }
    });

    return {
      smsAvailable: Boolean(user?.phone),
      phone: user?.phone ? maskPhone(user.phone) : null
    };
  });

  app.post('/auth/password-reset/sms/send', async (request, reply) => {
    const input = authPasswordResetSmsRequestSchema.parse(request.body);
    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(input.email) },
      select: { id: true, phone: true }
    });

    if (!user) throw new HttpError(404, 'Account not found');
    if (!user.phone) throw new HttpError(400, 'SMS password reset is disabled because this account has no phone number');

    const latestCode = await prisma.passwordResetCode.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true }
    });
    if (latestCode && latestCode.createdAt.getTime() > Date.now() - passwordResetCodeCooldownMs) {
      throw new HttpError(429, 'Please wait before requesting another reset SMS');
    }

    const code = createResetCode();
    const expiresAt = new Date(Date.now() + passwordResetCodeTtlMs);
    const codeHash = await hashPassword(code);

    await prisma.passwordResetCode.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() }
    });
    const resetCode = await prisma.passwordResetCode.create({
      data: {
        userId: user.id,
        codeHash,
        sentTo: user.phone,
        expiresAt
      }
    });

    try {
      await sendOTPSms(user.phone, Number(code));
    } catch (error) {
      await prisma.passwordResetCode.update({
        where: { id: resetCode.id },
        data: { usedAt: new Date() }
      }).catch(() => undefined);
      throw error;
    }

    return reply.code(201).send({
      sent: true,
      phone: maskPhone(user.phone),
      expiresAt
    });
  });

  app.post('/auth/password-reset/sms/complete', async (request, reply) => {
    const input = authPasswordResetSmsCompleteSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(input.email) } });
    if (!user) throw new HttpError(404, 'Account not found');

    const resetCode = await prisma.passwordResetCode.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });
    if (!resetCode) throw new HttpError(400, 'Reset code is invalid or expired');
    if (resetCode.attempts >= passwordResetMaxAttempts) {
      await prisma.passwordResetCode.update({
        where: { id: resetCode.id },
        data: { usedAt: new Date() }
      });
      throw new HttpError(429, 'Reset code attempt limit reached');
    }

    const codeMatches = await verifyPassword(input.code, resetCode.codeHash);
    if (!codeMatches) {
      await prisma.passwordResetCode.update({
        where: { id: resetCode.id },
        data: { attempts: { increment: 1 } }
      });
      throw new HttpError(400, 'Reset code is invalid or expired');
    }

    const passwordHash = await hashPassword(input.password);
    const result = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          onboardingCompletedAt: user.onboardingCompletedAt ?? new Date()
        }
      });
      await tx.passwordResetCode.update({
        where: { id: resetCode.id },
        data: { usedAt: new Date() }
      });
      await tx.passwordResetCode.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() }
      });
      await tx.authSession.deleteMany({ where: { userId: user.id } });
      const membership = await tx.workspaceMember.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
        include: { workspace: true }
      });
      return { user: updatedUser, membership };
    });

    const session = await createUserSession(result.user.id);
    return reply.send(await authResponse(result, session));
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
        return reply.send(await authResponse({ user, membership }, session));
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
    return reply.code(201).send(await authResponse({ user, membership }, session));
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
    return reply.code(201).send(await authResponse({ user, membership }, session));
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
    return reply.send(await authResponse(result, session));
  });
}

function createResetCode(): string {
  return String(randomInt(100000, 1000000));
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 4)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-3)}`;
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
    aiModel: user.aiModel,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    mattermostUsername: user.mattermostUsername
  };
}

async function authResponse(
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
