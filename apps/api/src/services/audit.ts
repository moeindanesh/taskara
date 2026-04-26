import { prisma, type ActorType, type Prisma, type TaskSource } from '@taskara/db';

export function snapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function logActivity(input: {
  workspaceId: string;
  actorId?: string | null;
  actorType: ActorType;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  source?: TaskSource;
}): Promise<void> {
  await prisma.activityLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      actorType: input.actorType,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      before: input.before === undefined ? undefined : snapshot(input.before),
      after: input.after === undefined ? undefined : snapshot(input.after),
      source: input.source ?? 'API'
    }
  });
}
