import { prisma, type ActorType, type AgentRuntime, type Prisma, type TaskSource } from '@taskara/db';

export function snapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * `actorRuntime` is required rather than optional on purpose. It is the one field a new call site
 * would otherwise forget, and a silently absent runtime is indistinguishable from an honestly
 * undeclared one. Required means the type checker asks the question; `actor.actorRuntime` is the
 * answer at every request-scoped site, and `null` is the answer everywhere else.
 */
export async function logActivity(input: {
  workspaceId: string;
  actorId?: string | null;
  actorType: ActorType;
  actorRuntime: AgentRuntime | null;
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
      actorRuntime: input.actorRuntime,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      before: input.before === undefined ? undefined : snapshot(input.before),
      after: input.after === undefined ? undefined : snapshot(input.after),
      source: input.source ?? 'API'
    }
  });
}
