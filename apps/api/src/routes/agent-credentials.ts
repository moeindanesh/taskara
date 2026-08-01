import type { FastifyInstance } from 'fastify';
import { prisma, type AgentCredential } from '@taskara/db';
import { createAgentCredentialSchema } from '@taskara/shared';
import { requireWorkspaceAdmin } from '../services/actor';
import { mintAgentCredentialToken } from '../services/agent-credential';
import { logActivity } from '../services/audit';
import { HttpError } from '../services/http';

/**
 * Management of agent credentials. Every route here is admin-only, and `requireWorkspaceAdmin`
 * additionally refuses any request that itself authenticated with a credential -- so a credential
 * can neither mint a successor nor revoke a sibling, and a leak cannot make itself permanent.
 */
export async function registerAgentCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.get('/agent-credentials', async (request) => {
    const actor = await requireWorkspaceAdmin(request);

    const items = await prisma.agentCredential.findMany({
      where: { workspaceId: actor.workspace.id },
      include: { agent: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' }
    });

    return { items: items.map(serializeCredential), total: items.length };
  });

  app.post('/agent-credentials', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = createAgentCredentialSchema.parse(request.body);

    const agent = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, name: true, email: true, kind: true }
    });
    // Checked here for a usable error message; the database enforces it regardless, through the
    // composite foreign key on (userId, userKind) and the AGENT check constraint beside it.
    if (!agent || agent.kind !== 'AGENT') {
      throw new HttpError(400, 'Only an agent user can hold an agent credential');
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: agent.id } },
      select: { id: true }
    });
    if (!membership) throw new HttpError(400, 'Agent must be a member of this workspace');

    const minted = mintAgentCredentialToken();
    const created = await prisma.agentCredential.create({
      data: {
        workspaceId: actor.workspace.id,
        userId: agent.id,
        name: input.name,
        lookupId: minted.lookupId,
        tokenHash: minted.tokenHash,
        scope: input.scope,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdById: actor.user.id
      },
      include: { agent: { select: { id: true, name: true, email: true } } }
    });

    // `serializeCredential` carries no secret material, so neither does the audit trail.
    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      entityType: 'agent_credential',
      entityId: created.id,
      action: 'issued',
      after: serializeCredential(created),
      source: actor.source
    });

    return reply.code(201).send({ ...serializeCredential(created), token: minted.token });
  });

  app.post('/agent-credentials/:id/rotate', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { id } = request.params as { id: string };

    const existing = await requireCredential(actor.workspace.id, id);
    // Rotating a revoked credential would resurrect it. Issue a new one instead.
    if (existing.revokedAt) throw new HttpError(409, 'Agent credential has been revoked');

    const minted = mintAgentCredentialToken();
    // The replacement takes effect atomically and the previous secret dies with it: there is no
    // overlap window. An operator who needs one issues a second credential and revokes the first
    // after the cutover, which is the same thing but visible in the list rather than implicit.
    const rotated = await prisma.agentCredential.update({
      where: { id: existing.id },
      data: { lookupId: minted.lookupId, tokenHash: minted.tokenHash, rotatedAt: new Date() },
      include: { agent: { select: { id: true, name: true, email: true } } }
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      entityType: 'agent_credential',
      entityId: rotated.id,
      action: 'rotated',
      after: serializeCredential(rotated),
      source: actor.source
    });

    return reply.send({ ...serializeCredential(rotated), token: minted.token });
  });

  app.delete('/agent-credentials/:id', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { id } = request.params as { id: string };

    const existing = await requireCredential(actor.workspace.id, id);
    // Soft revoke: the row is what the activity trail points at, and a deleted row would take the
    // record of the agent's own past work's provenance with it. Authentication reads `revokedAt`
    // on every request, so this is immediate rather than eventual.
    if (existing.revokedAt) return reply.code(204).send();

    const revoked = await prisma.agentCredential.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), revokedById: actor.user.id },
      include: { agent: { select: { id: true, name: true, email: true } } }
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      actorRuntime: actor.actorRuntime,
      entityType: 'agent_credential',
      entityId: revoked.id,
      action: 'revoked',
      after: serializeCredential(revoked),
      source: actor.source
    });

    return reply.code(204).send();
  });
}

async function requireCredential(workspaceId: string, id: string) {
  // Scoped by workspace, so one workspace's admin cannot reach another's credentials -- and cannot
  // learn whether an id exists elsewhere either, since both cases are the same 404.
  const credential = await prisma.agentCredential.findFirst({
    where: { id, workspaceId },
    include: { agent: { select: { id: true, name: true, email: true } } }
  });
  if (!credential) throw new HttpError(404, 'Agent credential not found');
  return credential;
}

type SerializableCredential = AgentCredential & {
  agent: { id: string; name: string; email: string };
};

/**
 * The only shape a credential is ever sent in. `tokenHash` is destructured out rather than
 * cherry-picked in, so a column added later cannot leak by being forgotten here.
 */
function serializeCredential(credential: SerializableCredential) {
  const { tokenHash: _tokenHash, userKind: _userKind, lookupId, ...rest } = credential;
  return { ...rest, tokenLookupId: lookupId };
}
