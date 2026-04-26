import type { FastifyRequest } from 'fastify';
import { prisma, type Prisma, type User, type Workspace, type WorkspaceMember, type WorkspaceRole } from '@taskara/db';
import { config } from '../config';
import { displayNameFromEmail, getSessionUser, normalizeEmail } from './auth';
import { HttpError } from './http';

export type ActorSource = 'WEB' | 'API' | 'MATTERMOST' | 'CODEX' | 'AGENT' | 'SYSTEM';
export type ActorType = 'USER' | 'SYSTEM' | 'AGENT' | 'MATTERMOST' | 'CODEX';

export interface RequestActor {
  workspace: Workspace;
  user: User;
  actorType: ActorType;
  source: ActorSource;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeOptionalText(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function requireWorkspaceBySlug(slug: string): Promise<Workspace> {
  const normalizedSlug = normalizeWorkspaceSlug(slug);
  const workspace = await prisma.workspace.findUnique({ where: { slug: normalizedSlug } });
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  return workspace;
}

export async function ensureWorkspaceMember(workspaceId: string, userId: string): Promise<WorkspaceMember> {
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } }
  });
  if (existing) {
    const ownerCount = await prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    if (ownerCount === 0) {
      return prisma.workspaceMember.update({ where: { id: existing.id }, data: { role: 'OWNER' } });
    }
    return existing;
  }

  const memberCount = await prisma.workspaceMember.count({ where: { workspaceId } });
  if (memberCount > 0) {
    throw new HttpError(403, 'User is not a member of this workspace');
  }

  try {
    return await prisma.workspaceMember.create({
      data: { workspaceId, userId, role: 'OWNER' }
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } }
    });
    if (member) return member;
    throw error;
  }
}

export async function upsertUserByEmail(email: string, name?: string): Promise<User> {
  const normalizedEmail = normalizeEmail(email);
  const explicitName = normalizeOptionalText(name);
  const displayName = explicitName || displayNameFromEmail(normalizedEmail);
  const update: Prisma.UserUpdateInput = explicitName ? { name: explicitName } : {};

  try {
    return await prisma.user.upsert({
      where: { email: normalizedEmail },
      update,
      create: { email: normalizedEmail, name: displayName }
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    if (explicitName) {
      return prisma.user.update({
        where: { email: normalizedEmail },
        data: { name: explicitName }
      });
    }
    return prisma.user.findUniqueOrThrow({ where: { email: normalizedEmail } });
  }
}

export async function getRequestActor(request: FastifyRequest): Promise<RequestActor> {
  const workspaceSlug = headerValue(request, 'x-workspace-slug');
  if (!workspaceSlug) throw new HttpError(400, 'Workspace slug is required');

  const workspace = await requireWorkspaceBySlug(workspaceSlug);
  const sessionUser = await getSessionUser(request);

  if (sessionUser) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: sessionUser.id } }
    });
    if (!membership) throw new HttpError(403, 'User is not a member of this workspace');
    return { workspace, user: sessionUser, actorType: 'USER', source: 'WEB' };
  }

  const email = headerValue(request, 'x-user-email');
  if (!email) throw new HttpError(401, 'Authentication required');

  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  if (!user) throw new HttpError(401, 'User must sign up or be invited before API access');

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }
  });
  if (!membership) throw new HttpError(403, 'User is not a member of this workspace');

  const actorType = headerValue(request, 'x-actor-type') === 'CODEX' ? 'CODEX' : 'USER';
  const source = actorType === 'CODEX' ? 'CODEX' : 'API';
  return { workspace, user, actorType, source };
}

export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true }
  });
  return member?.role ?? null;
}

export async function requireWorkspaceAdmin(request: FastifyRequest): Promise<RequestActor & { role: WorkspaceRole }> {
  const actor = await getRequestActor(request);
  const role = await getWorkspaceRole(actor.workspace.id, actor.user.id);
  if (role !== 'OWNER' && role !== 'ADMIN') {
    throw new HttpError(403, 'Workspace admin access required');
  }
  return { ...actor, role };
}

export interface MattermostActorPayload {
  user_id?: string;
  user_name?: string;
  username?: string;
  team_domain?: string;
  team_id?: string;
  workspace_slug?: string;
  channel_id?: string;
  channel_name?: string;
}

export async function getMattermostActor(payload: MattermostActorPayload): Promise<RequestActor> {
  const workspace = await requireWorkspaceBySlug(mattermostWorkspaceSlug(payload));
  const username = (payload.user_name || payload.username || payload.user_id || 'mattermost-user').trim().toLowerCase();
  const email = `${username}@${config.MATTERMOST_SYNTHETIC_EMAIL_DOMAIN}`;

  const orConditions: Prisma.UserWhereInput[] = [{ email }];
  if (payload.user_id) orConditions.push({ mattermostUserId: payload.user_id });
  if (username) orConditions.push({ mattermostUsername: username });

  const existing = await prisma.user.findFirst({ where: { OR: orConditions } });

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          name: username,
          mattermostUserId: payload.user_id || existing.mattermostUserId,
          mattermostUsername: username
        }
      })
    : await prisma.user.create({
        data: {
          email,
          name: username,
          mattermostUserId: payload.user_id,
          mattermostUsername: username
        }
      });

  await ensureWorkspaceMember(workspace.id, user.id);
  return { workspace, user, actorType: 'MATTERMOST', source: 'MATTERMOST' };
}

function mattermostWorkspaceSlug(payload: MattermostActorPayload): string {
  const slug = config.MATTERMOST_WORKSPACE_SLUG || payload.workspace_slug || payload.team_domain || payload.team_id;
  if (!slug) throw new HttpError(400, 'Mattermost workspace slug is required');
  return slug;
}

function normalizeWorkspaceSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{2,48}$/.test(normalized)) throw new HttpError(400, 'Workspace slug is invalid');
  return normalized;
}
