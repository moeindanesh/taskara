import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@taskara/db';
import {
  assignmentRecommendationSchema,
  updateUserCapacitySchema,
  upsertWorkingAgreementSchema
} from '@taskara/shared';
import { getRequestActor, requireWorkspaceAdmin } from '../services/actor';
import { HttpError } from '../services/http';
import { recommendAssignment } from '../services/assignment';

const capacityUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  mattermostUsername: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

export async function registerAssignmentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/assignment/recommend', async (request) => {
    const actor = await getRequestActor(request);
    const input = assignmentRecommendationSchema.parse(request.body);
    return recommendAssignment(actor, input);
  });

  app.get('/capacity/users', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: {
          select: {
            ...capacityUserSelect,
            capacities: {
              where: { workspaceId: actor.workspace.id },
              take: 1
            }
          }
        }
      }
    });

    return {
      items: members.map((member) => {
        const [capacity] = member.user.capacities;
        const { capacities: _capacities, ...user } = member.user;
        return {
          membershipId: member.id,
          role: member.role,
          joinedAt: member.createdAt.toISOString(),
          user,
          capacity: capacity
            ? serializeCapacity(capacity)
            : {
                workspaceId: actor.workspace.id,
                userId: member.userId,
                dailyWeightLimit: 8,
                weeklyWeightLimit: null,
                active: true,
                note: null
              }
        };
      }),
      total: members.length
    };
  });

  app.put('/capacity/users/:userId', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const { userId } = request.params as { userId: string };
    const input = updateUserCapacitySchema.parse(request.body);
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId } },
      select: { userId: true }
    });
    if (!membership) throw new HttpError(404, 'Workspace member not found');

    const capacity = await prisma.userCapacity.upsert({
      where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId } },
      create: {
        workspaceId: actor.workspace.id,
        userId,
        dailyWeightLimit: input.dailyWeightLimit,
        weeklyWeightLimit: input.weeklyWeightLimit === undefined ? undefined : input.weeklyWeightLimit,
        active: input.active,
        note: input.note === undefined ? undefined : input.note
      },
      update: {
        dailyWeightLimit: input.dailyWeightLimit,
        weeklyWeightLimit: input.weeklyWeightLimit === undefined ? undefined : input.weeklyWeightLimit,
        active: input.active,
        note: input.note === undefined ? undefined : input.note
      }
    });

    return serializeCapacity(capacity);
  });

  app.get('/capacity/agreements', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const agreements = await prisma.teamWorkingAgreement.findMany({
      where: { workspaceId: actor.workspace.id },
      orderBy: [{ scopeKey: 'asc' }],
      include: {
        team: { select: { id: true, name: true, slug: true } }
      }
    });
    return {
      items: agreements.map(serializeAgreement),
      total: agreements.length
    };
  });

  app.post('/capacity/agreements', async (request) => {
    const actor = await requireWorkspaceAdmin(request);
    const input = upsertWorkingAgreementSchema.parse(request.body);
    if (input.teamId) {
      const team = await prisma.team.findFirst({
        where: { id: input.teamId, workspaceId: actor.workspace.id },
        select: { id: true }
      });
      if (!team) throw new HttpError(404, 'Team not found');
    }

    const scopeKey = input.teamId ? `team:${input.teamId}` : 'workspace';
    const agreement = await prisma.teamWorkingAgreement.upsert({
      where: { workspaceId_scopeKey: { workspaceId: actor.workspace.id, scopeKey } },
      create: {
        workspaceId: actor.workspace.id,
        teamId: input.teamId ?? null,
        scopeKey,
        activeWipLimit: input.activeWipLimit === undefined ? undefined : input.activeWipLimit,
        reviewWipLimit: input.reviewWipLimit === undefined ? undefined : input.reviewWipLimit,
        reviewSlaHours: input.reviewSlaHours,
        blockedSlaHours: input.blockedSlaHours,
        staleAfterHours: input.staleAfterHours
      },
      update: {
        teamId: input.teamId ?? null,
        activeWipLimit: input.activeWipLimit === undefined ? undefined : input.activeWipLimit,
        reviewWipLimit: input.reviewWipLimit === undefined ? undefined : input.reviewWipLimit,
        reviewSlaHours: input.reviewSlaHours,
        blockedSlaHours: input.blockedSlaHours,
        staleAfterHours: input.staleAfterHours
      },
      include: {
        team: { select: { id: true, name: true, slug: true } }
      }
    });

    return serializeAgreement(agreement);
  });
}

function serializeCapacity(capacity: {
  id?: string;
  workspaceId: string;
  userId: string;
  dailyWeightLimit: number;
  weeklyWeightLimit?: number | null;
  active: boolean;
  note?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: capacity.id,
    workspaceId: capacity.workspaceId,
    userId: capacity.userId,
    dailyWeightLimit: capacity.dailyWeightLimit,
    weeklyWeightLimit: capacity.weeklyWeightLimit ?? null,
    active: capacity.active,
    note: capacity.note ?? null,
    createdAt: capacity.createdAt?.toISOString(),
    updatedAt: capacity.updatedAt?.toISOString()
  };
}

function serializeAgreement(agreement: {
  id: string;
  workspaceId: string;
  teamId: string | null;
  scopeKey: string;
  activeWipLimit: number | null;
  reviewWipLimit: number | null;
  reviewSlaHours: number;
  blockedSlaHours: number;
  staleAfterHours: number;
  createdAt: Date;
  updatedAt: Date;
  team?: { id: string; name: string; slug: string } | null;
}) {
  return {
    id: agreement.id,
    workspaceId: agreement.workspaceId,
    teamId: agreement.teamId,
    scopeKey: agreement.scopeKey,
    activeWipLimit: agreement.activeWipLimit,
    reviewWipLimit: agreement.reviewWipLimit,
    reviewSlaHours: agreement.reviewSlaHours,
    blockedSlaHours: agreement.blockedSlaHours,
    staleAfterHours: agreement.staleAfterHours,
    createdAt: agreement.createdAt.toISOString(),
    updatedAt: agreement.updatedAt.toISOString(),
    team: agreement.team ?? null
  };
}
