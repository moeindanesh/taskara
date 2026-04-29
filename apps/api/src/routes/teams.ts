import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma, type Team } from '@taskara/db';
import { addTeamMemberSchema, createTeamSchema, setTeamMemberRoleSchema } from '@taskara/shared';
import { getRequestActor, requireWorkspaceAdmin } from '../services/actor';
import { logActivity } from '../services/audit';
import { HttpError } from '../services/http';

const teamMemberUserSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  mattermostUsername: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

const teamMemberInclude = {
  user: { select: teamMemberUserSelect }
} satisfies Prisma.TeamMemberInclude;

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'team';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function registerTeamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/teams', async (request) => {
    const actor = await getRequestActor(request);
    return prisma.team.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true, projects: true } } }
    });
  });

  app.post('/teams', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = createTeamSchema.parse(request.body);
    let team: Team;

    try {
      team = await prisma.team.create({
        data: {
          workspaceId: actor.workspace.id,
          name: input.name,
          slug: input.slug || slugify(input.name),
          description: input.description,
          members: { create: { userId: actor.user.id, role: 'OWNER' } }
        }
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new HttpError(409, 'Team slug already exists in this workspace');
      }
      throw error;
    }

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'team',
      entityId: team.id,
      action: 'created',
      after: team,
      source: actor.source
    });

    return reply.code(201).send(team);
  });

  app.get('/teams/:idOrSlug/members', async (request, reply) => {
    const actor = await getRequestActor(request);
    const { idOrSlug } = request.params as { idOrSlug: string };
    const team = await findTeamInWorkspace(actor.workspace.id, idOrSlug);
    if (!team) return reply.code(404).send({ message: 'Team not found in this workspace' });

    const members = await prisma.teamMember.findMany({
      where: { teamId: team.id },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: teamMemberInclude
    });

    return {
      items: members.map(serializeTeamMember),
      total: members.length,
      limit: members.length,
      offset: 0
    };
  });

  app.post('/teams/:idOrSlug/members', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { idOrSlug } = request.params as { idOrSlug: string };
    const input = addTeamMemberSchema.parse(request.body);
    const team = await findTeamInWorkspace(actor.workspace.id, idOrSlug);
    if (!team) return reply.code(404).send({ message: 'Team not found in this workspace' });

    await assertWorkspaceUser(actor.workspace.id, input.userId);

    const member = await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: team.id, userId: input.userId } },
      update: { role: input.role },
      create: { teamId: team.id, userId: input.userId, role: input.role },
      include: teamMemberInclude
    });

    const result = serializeTeamMember(member);
    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'team_member',
      entityId: member.id,
      action: 'upserted',
      after: result,
      source: actor.source
    });

    return reply.code(201).send(result);
  });

  app.patch('/teams/:idOrSlug/members/:userId/role', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { idOrSlug, userId } = request.params as { idOrSlug: string; userId: string };
    const input = setTeamMemberRoleSchema.parse(request.body);
    const team = await findTeamInWorkspace(actor.workspace.id, idOrSlug);
    if (!team) return reply.code(404).send({ message: 'Team not found in this workspace' });

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team.id, userId } },
      include: teamMemberInclude
    });
    if (!existing) return reply.code(404).send({ message: 'Team member not found' });

    const updated = await prisma.teamMember.update({
      where: { id: existing.id },
      data: { role: input.role },
      include: teamMemberInclude
    });

    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'team_member',
      entityId: updated.id,
      action: 'role_updated',
      before: serializeTeamMember(existing),
      after: serializeTeamMember(updated),
      source: actor.source
    });

    return serializeTeamMember(updated);
  });

  app.delete('/teams/:idOrSlug/members/:userId', async (request, reply) => {
    const actor = await requireWorkspaceAdmin(request);
    const { idOrSlug, userId } = request.params as { idOrSlug: string; userId: string };
    const team = await findTeamInWorkspace(actor.workspace.id, idOrSlug);
    if (!team) return reply.code(404).send({ message: 'Team not found in this workspace' });

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team.id, userId } },
      include: teamMemberInclude
    });
    if (!existing) return reply.code(404).send({ message: 'Team member not found' });

    await prisma.teamMember.delete({ where: { id: existing.id } });
    await logActivity({
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      actorType: actor.actorType,
      entityType: 'team_member',
      entityId: existing.id,
      action: 'removed',
      before: serializeTeamMember(existing),
      source: actor.source
    });

    return reply.code(204).send();
  });
}

async function findTeamInWorkspace(workspaceId: string, idOrSlug: string) {
  return prisma.team.findFirst({
    where: {
      workspaceId,
      OR: [
        { slug: idOrSlug },
        ...(isUuid(idOrSlug) ? [{ id: idOrSlug }] : [])
      ]
    }
  });
}

async function assertWorkspaceUser(workspaceId: string, userId: string): Promise<void> {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true }
  });
  if (!membership) {
    throw new HttpError(400, 'User must belong to this workspace before they can be added to a team');
  }
}

function serializeTeamMember(member: Prisma.TeamMemberGetPayload<{ include: typeof teamMemberInclude }>) {
  return {
    membershipId: member.id,
    teamId: member.teamId,
    userId: member.userId,
    role: member.role,
    joinedAt: member.createdAt,
    user: member.user
  };
}
