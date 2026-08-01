import type { FastifyRequest } from 'fastify';
import {
  prisma,
  type AgentCredentialScope,
  type AgentRuntime,
  type Prisma,
  type User,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole
} from '@taskara/db';
import { config } from '../config';
import { deriveActorProvenance } from './actor-provenance';
import { authenticateAgentCredential, isAgentCredentialToken } from './agent-credential';
import { displayNameFromEmail, getBearerToken, getSessionUser, normalizeEmail } from './auth';
import { HttpError } from './http';

export type ActorSource = 'WEB' | 'API' | 'MATTERMOST' | 'CODEX' | 'AGENT' | 'SYSTEM';
export type ActorType = 'USER' | 'SYSTEM' | 'AGENT' | 'MATTERMOST' | 'CODEX';

export interface RequestActor {
  workspace: Workspace;
  user: User;
  role: WorkspaceRole;
  /** Derived from user.kind, never from a header. See ./actor-provenance. */
  actorType: ActorType;
  /** Client-asserted, and only ever set for an agent actor. */
  actorRuntime: AgentRuntime | null;
  source: ActorSource;
  /** Present iff this request authenticated with an agent credential rather than as a person. */
  credential?: { id: string; scope: AgentCredentialScope };
}

export function isWorkspaceAdminRole(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
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

/**
 * The runtime a client says it is. Nothing authenticates this, which is why it can only ever
 * qualify an actor already proven to be an agent by its authenticated User.kind.
 *
 * `x-actor-type` is the legacy header that used to decide the actorType outright. It is demoted,
 * not honoured: at most it names a runtime, and only CODEX ever meant one.
 */
function declaredRuntime(request: FastifyRequest): string | undefined {
  const declared = headerValue(request, 'x-agent-runtime');
  if (normalizeOptionalText(declared)) return declared;
  return headerValue(request, 'x-actor-type') === 'CODEX' ? 'CODEX' : undefined;
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
    // measured-people:allow — Owner invariant. A workspace needs an owner whoever that is.
    const ownerCount = await prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    if (ownerCount === 0) {
      return prisma.workspaceMember.update({ where: { id: existing.id }, data: { role: 'OWNER' } });
    }
    return existing;
  }

  // measured-people:allow — First-member bootstrap check, not a measurement.
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

  // An agent credential is presented as a bearer token and identified by its prefix, so it costs no
  // database read to tell apart from a session token. It never falls through to another path: a
  // caller that presented a bad credential is rejected, not quietly downgraded to the email header.
  const bearer = getBearerToken(request);
  if (bearer && isAgentCredentialToken(bearer)) {
    const authenticated = await authenticateAgentCredential(bearer, workspace.id, request.method);
    return {
      workspace,
      user: authenticated.user,
      role: authenticated.role,
      // Through the same derivation as every other channel, never from `x-actor-type`. The kind is
      // read off the authenticated row rather than assumed from the credential: a composite foreign
      // key already guarantees it is AGENT, so passing it keeps one function the only place an
      // actorType is decided instead of two that must be kept agreeing.
      ...deriveActorProvenance({
        userKind: authenticated.user.kind,
        channel: 'AGENT',
        declaredRuntime: declaredRuntime(request)
      }),
      source: 'AGENT',
      credential: authenticated.credential
    };
  }

  const sessionUser = await getSessionUser(request);

  if (sessionUser) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: sessionUser.id } }
    });
    if (!membership) throw new HttpError(403, 'User is not a member of this workspace');
    return {
      workspace,
      user: sessionUser,
      role: membership.role,
      ...deriveActorProvenance({
        userKind: sessionUser.kind,
        channel: 'USER',
        declaredRuntime: declaredRuntime(request)
      }),
      source: 'WEB'
    };
  }

  const email = headerValue(request, 'x-user-email');
  if (!email) throw new HttpError(401, 'Authentication required');
  // The single switch that turns the legacy header path off for a deployment that has finished
  // migrating its consumers. It defaults on because shipped clients still depend on it; retiring
  // it fleet-wide is its own effort, and this flag is what that effort flips.
  if (!config.TASKARA_EMAIL_HEADER_AUTH) throw new HttpError(401, 'Authentication required');

  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  if (!user) throw new HttpError(401, 'User must sign up or be invited before API access');
  // Unconditional, and not covered by the flag above: an agent has a credential of its own now, so
  // there is no reason for the weaker path to be able to speak as one -- and every reason not to,
  // since agent provenance is only worth anything if it cannot be asserted by whoever knows a
  // string that appears in every activity feed.
  if (user.kind === 'AGENT') {
    throw new HttpError(401, 'Agent users must authenticate with an agent credential');
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }
  });
  if (!membership) throw new HttpError(403, 'User is not a member of this workspace');

  // `source` names the channel and stays client-influenced, exactly as it always was. It is not
  // the provenance discriminator and must not be read as one -- actorType is.
  const source = headerValue(request, 'x-actor-type') === 'CODEX' ? 'CODEX' : 'API';
  return {
    workspace,
    user,
    role: membership.role,
    ...deriveActorProvenance({ userKind: user.kind, channel: 'USER', declaredRuntime: declaredRuntime(request) }),
    source
  };
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
  // The scope ceiling, and the reason it is expressed here rather than as a list of forbidden URLs:
  // "administer the workspace" already has exactly one seam in this codebase, and it is this one.
  // A long-lived headless secret must never reach user creation, role changes, invites, or the
  // credential routes themselves -- otherwise one leaked token buys a permanent second account, or
  // renews itself. This is checked before the role check on purpose: it holds whatever role the
  // agent's membership carries, so an OWNER agent gains nothing.
  if (actor.credential) {
    throw new HttpError(403, 'An agent credential cannot administer this workspace');
  }
  if (!isWorkspaceAdminRole(actor.role)) {
    throw new HttpError(403, 'Workspace admin access required');
  }
  return actor;
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
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    select: { role: true }
  });
  if (!membership) throw new HttpError(403, 'User is not a member of this workspace');
  return {
    workspace,
    user,
    role: membership.role,
    // An agent reaching us over Mattermost is still an agent. The channel only names what a human
    // looks like here.
    ...deriveActorProvenance({ userKind: user.kind, channel: 'MATTERMOST' }),
    source: 'MATTERMOST'
  };
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
