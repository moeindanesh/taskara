import { prisma } from '@taskara/db';
import type { RequestActor } from './actor';
import { HttpError } from './http';

export async function listAccessibleTeamIds(actor: RequestActor): Promise<string[] | null> {
  const memberships = await prisma.teamMember.findMany({
    where: {
      userId: actor.user.id,
      team: { workspaceId: actor.workspace.id }
    },
    select: { teamId: true }
  });

  return memberships.map((membership) => membership.teamId);
}

export async function assertActorCanAccessTeamId(actor: RequestActor, teamId: string): Promise<void> {
  const membership = await prisma.teamMember.findFirst({
    where: {
      teamId,
      userId: actor.user.id,
      team: { workspaceId: actor.workspace.id }
    },
    select: { id: true }
  });

  if (!membership) throw new HttpError(403, 'Team access denied');
}

export async function assertActorCanAccessTeamSlug(actor: RequestActor, teamSlug: string): Promise<string> {
  const team = await prisma.team.findFirst({
    where: {
      workspaceId: actor.workspace.id,
      slug: teamSlug
    },
    select: { id: true }
  });

  if (!team) throw new HttpError(404, 'Team not found in this workspace');
  await assertActorCanAccessTeamId(actor, team.id);
  return team.id;
}
