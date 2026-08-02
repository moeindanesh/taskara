import { prisma, type ActorType, type AgentRuntime, type Prisma, type TaskSource } from '@taskara/db';

/**
 * Every kind of thing the activity log can be about.
 *
 * A closed union rather than `string`, because `ActivityLog.entityType`/`entityId` is a polymorphic
 * pointer with no relation behind it: nothing can join through it, so **who may read a row is a
 * question that has to be answered per type**. `services/activity-visibility.ts` answers it with a
 * `Record<ActivityEntityType, …>`, which the type checker will not let anybody leave incomplete.
 *
 * That pairing is the guard for issue #59, and it is a type rather than a test on purpose: a source
 * scan can be satisfied by a comment and a behavioural harness only covers the paths it drives,
 * whereas adding a member here without placing it over there does not compile. Widen this union and
 * the compiler tells you the one other file to visit.
 */
export type ActivityEntityType =
  | 'agent_credential'
  | 'announcement'
  | 'attention'
  | 'check_in'
  | 'knowledge_page'
  | 'knowledge_space'
  | 'meeting'
  | 'meeting_action_item'
  | 'milestone'
  | 'one_on_one'
  | 'one_on_one_agenda_item'
  | 'project'
  | 'project_health_update'
  | 'task'
  | 'task_review'
  | 'team'
  | 'team_member'
  | 'user'
  | 'workspace_invite'
  | 'workspace_member';

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
  entityType: ActivityEntityType;
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
