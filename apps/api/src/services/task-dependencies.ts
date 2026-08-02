import { prisma, Prisma, type SyncEvent } from '@taskara/db';
import type { RequestActor } from './actor';
import { attributedTo } from './actor-provenance';
import { logActivity } from './audit';
import { HttpError } from './http';
import {
  TASK_BLOCKED_NOTIFICATION_TYPE,
  createTaskSubscriberNotifications,
  taskBlockedByHiddenNotificationBody,
  taskBlockedNotificationBody
} from './notifications';
import { appendSyncEvent, publishSyncEvent, type SyncMutationMeta } from './sync';
import { serializeTaskForResponse, taskInclude } from './tasks';

/**
 * How far the cycle walk will follow blocking edges before giving up.
 *
 * This is a safety stop, not a product rule: the walk already terminates on any graph because it
 * keeps a visited set, and a chain this long is not a dependency chain anyone is reading. Its real
 * job is to bound the number of round trips when the graph is pathological.
 */
const MAX_DEPENDENCY_WALK_NODES = 5000;

/** One advisory-lock namespace for dependency writes, so the key space cannot collide. */
const DEPENDENCY_LOCK_NAMESPACE = 24_001;

interface TaskEndpoint {
  id: string;
  key: string;
  title: string;
}

/**
 * Add "task is blocked by blocker".
 *
 * The edge is directed and it means ordering: the blocker has to finish first. So the graph of
 * blocking edges must stay acyclic — a cycle is a set of tasks each waiting for the next, which no
 * amount of work can resolve and which makes the frontier of that subgraph permanently empty.
 */
export async function addTaskDependency(
  actor: RequestActor,
  task: TaskEndpoint,
  blocker: TaskEndpoint,
  syncMutation?: SyncMutationMeta
): Promise<{ dependency: { id: string; taskId: string; blockedByTaskId: string; createdAt: Date }; created: boolean }> {
  if (task.id === blocker.id) throw new HttpError(400, 'Task cannot block itself');

  let syncEvents: SyncEvent[] = [];
  const result = await prisma.$transaction(async (tx) => {
    // Two edges that are each acyclic on their own can close a cycle together, and they need not
    // share a task — `A→B` and `C→D` complete the cycle `A→B→C→D→A` between them. Row locks on the
    // endpoints therefore cannot serialize this; the check has to be serialized per workspace.
    // Dependency writes are rare and this transaction is short, so the contention is not real.
    await lockWorkspaceDependencies(tx, actor.workspace.id);

    await assertBothAreWork(tx, task, blocker);

    const existing = await tx.taskDependency.findUnique({
      where: { taskId_blockedByTaskId: { taskId: task.id, blockedByTaskId: blocker.id } }
    });
    if (existing) return { dependency: existing, created: false, event: null };

    await assertNoBlockingCycle(tx, task.id, blocker.id);

    const before = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    const dependency = await tx.taskDependency.create({
      data: { taskId: task.id, blockedByTaskId: blocker.id }
    });

    const after = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    await createTaskSubscriberNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      attribution: attributedTo(actor),
      task: after,
      type: TASK_BLOCKED_NOTIFICATION_TYPE,
      body: taskBlockedNotificationBody(actor.user.name, blocker.key, blocker.title),
      // The one body that names a second task. Watching the blocked task is what earns the row;
      // reading the blocker is a separate question, and #58 is what made it one.
      namedTask: { taskId: blocker.id, bodyWithout: taskBlockedByHiddenNotificationBody(actor.user.name) }
    });

    const event = await appendDependencySyncEvent(tx, actor, before, after, syncMutation);
    return { dependency, created: true, event };
  });

  syncEvents = result.event ? [result.event] : [];
  for (const event of syncEvents) publishSyncEvent(event);

  if (result.created) {
    await logDependencyChange(actor, task, blocker, 'dependency_added');
  }

  return { dependency: result.dependency, created: result.created };
}

/**
 * Remove "task is blocked by blocker".
 *
 * This route is the whole reason a wrong edge is now a mistake rather than a fact. Before it, the
 * only way to undo one was to delete a task, which took its comments, its history and its key with
 * it — and once two tasks blocked each other, no HTTP call could recover the subgraph at all.
 */
export async function removeTaskDependency(
  actor: RequestActor,
  task: TaskEndpoint,
  blocker: TaskEndpoint,
  syncMutation?: SyncMutationMeta
): Promise<void> {
  const event = await prisma.$transaction(async (tx) => {
    const before = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    const deleted = await tx.taskDependency.deleteMany({
      where: { taskId: task.id, blockedByTaskId: blocker.id }
    });
    // The edge is directed. Naming the pair backwards describes an edge that does not exist, and
    // saying so is more useful than a 204 that quietly did nothing.
    if (!deleted.count) throw new HttpError(404, 'Dependency not found');

    const after = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    return appendDependencySyncEvent(tx, actor, before, after, syncMutation);
  });

  publishSyncEvent(event);
  await logDependencyChange(actor, task, blocker, 'dependency_removed');
}

type TaskWithInclude = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

/**
 * The one event a dependency write emits, on the blocked task.
 *
 * Only the blocked task's serialized row actually changes — its `_count.blockingDependencies` moves
 * — so the blocker gets no event. A poke carrying a byte-identical row teaches a client nothing,
 * and `taskInclude` has no `blockedTasks` for it to carry anyway.
 *
 * `before` is not decoration. `mapSyncEventForScope` derives `progressStartedAt` from the status
 * *transition*, and reads a missing `before` as "this task has only just started" — so omitting it
 * would stamp a fresh progress-start on every in-progress task that gained or lost a blocker, in
 * every client cache. The row is read twice, either side of the edge write, to say plainly that
 * nothing about the task itself moved.
 */
async function appendDependencySyncEvent(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  before: TaskWithInclude,
  after: TaskWithInclude,
  syncMutation?: SyncMutationMeta
): Promise<SyncEvent> {
  return appendSyncEvent(tx, {
    workspaceId: actor.workspace.id,
    entityType: 'task',
    entityId: after.id,
    operation: 'updated',
    entityVersion: after.version,
    actorId: actor.user.id,
    payload: {
      before: serializeTaskForResponse(before),
      after: serializeTaskForResponse(after),
      changedFields: ['blockingDependencies']
    },
    mutation: syncMutation
  });
}

/**
 * Refuse `task` ← `blocker` if the blocker is already waiting, directly or transitively, on the
 * task. Walk upstream from the blocker through its own blockers: if the task is reachable that
 * way, the new edge closes a loop.
 *
 * The visited set is not an optimisation. Cycles already exist in databases written before this
 * check, because the route accepted them for as long as it has existed — so the walk has to
 * terminate on a graph that is *already* cyclic, not merely avoid creating one.
 */
/**
 * Neither end of a blocking edge may be an Effort.
 *
 * An Effort is a map, not a unit of work: nobody is assigned it and nothing waits on it. An edge
 * touching one would put it in the dependencies section of a real task and count it toward that
 * task's open-blocker total — an Effort appearing to a human as work standing in their way, which is
 * the whole failure `kind` exists to prevent.
 *
 * Refused at the write rather than filtered at the read, because filtering leaves a row in the
 * database that means something nobody can see, and the next reader of those edges would have to
 * remember to filter too. The reads are filtered as well, for edges predating this.
 *
 * `kind` is read here rather than taken from the caller: the endpoints arrive as {id, key, title},
 * and a guard that trusts its caller to have looked is a guard the next caller forgets.
 */
async function assertBothAreWork(
  tx: Prisma.TransactionClient,
  task: { id: string; key: string },
  blocker: { id: string; key: string }
): Promise<void> {
  const rows = await tx.task.findMany({
    where: { id: { in: [task.id, blocker.id] }, kind: 'EFFORT' },
    select: { id: true }
  });
  if (!rows.length) return;

  const efforts = new Set(rows.map((row) => row.id));
  const named = [
    efforts.has(task.id) ? task.key : null,
    efforts.has(blocker.id) ? blocker.key : null
  ].filter(Boolean);
  throw new HttpError(
    400,
    `A blocking edge cannot touch an effort: ${named.join(' and ')} ${named.length > 1 ? 'are efforts' : 'is an effort'}. An effort holds tickets through parentId; it does not block work and is not blocked by it.`
  );
}

async function assertNoBlockingCycle(
  tx: Prisma.TransactionClient,
  taskId: string,
  blockerId: string
): Promise<void> {
  const visited = new Set<string>([blockerId]);
  let frontier = [blockerId];

  while (frontier.length) {
    const edges = await tx.taskDependency.findMany({
      where: { taskId: { in: frontier } },
      select: { blockedByTaskId: true }
    });

    const next: string[] = [];
    for (const edge of edges) {
      if (edge.blockedByTaskId === taskId) {
        throw new HttpError(400, 'Dependency would create a cycle');
      }
      if (visited.has(edge.blockedByTaskId)) continue;
      visited.add(edge.blockedByTaskId);
      next.push(edge.blockedByTaskId);
    }

    if (visited.size > MAX_DEPENDENCY_WALK_NODES) {
      throw new HttpError(400, 'Dependency chain is too large to verify');
    }
    frontier = next;
  }
}

/**
 * Serialize cycle checks within a workspace. `pg_advisory_xact_lock` is released when the
 * transaction ends, including on rollback, so a refused edge cannot leave the lock held.
 */
async function lockWorkspaceDependencies(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${DEPENDENCY_LOCK_NAMESPACE}::int, hashtext(${workspaceId}))`
  );
}

/**
 * Both endpoints are recorded on the blocked task's timeline, because that is the task whose
 * takeability changed. The blocker's own row is unchanged by the edge — its `_count` does not
 * carry `blockedTasks` — so it gets no entry and no sync event that would deliver an identical row.
 */
async function logDependencyChange(
  actor: RequestActor,
  task: TaskEndpoint,
  blocker: TaskEndpoint,
  action: 'dependency_added' | 'dependency_removed'
): Promise<void> {
  const edge = {
    taskId: task.id,
    taskKey: task.key,
    blockedByTaskId: blocker.id,
    blockedByTaskKey: blocker.key,
    blockedByTaskTitle: blocker.title
  };
  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'task',
    entityId: task.id,
    action,
    before: action === 'dependency_removed' ? edge : undefined,
    after: action === 'dependency_added' ? edge : undefined,
    source: actor.source
  }).catch(() => undefined);
}
