import { prisma, type Prisma, type SyncEvent, type Task, type TaskSource } from '@taskara/db';
import { isWorkspaceAdminRole, type RequestActor } from './actor';
import { attributedTo } from './actor-provenance';
import { logActivity, snapshot } from './audit';
import { openBlockerCountSelect } from './blockers';
import type { z } from 'zod';
import { maxTaskLabels, taskDescriptionMaxChars, type TaskKindValue } from '@taskara/shared';
import type { createTaskSchema, updateTaskSchema } from '@taskara/shared';
import { serializeTaskAttachment } from './task-attachments';
import { HttpError } from './http';
import { appendMilestoneProgressSyncEvents, lockMilestonesForUpdate } from './milestones';
import {
  TASK_ASSIGNED_NOTIFICATION_TYPE,
  TASK_COMMENTED_NOTIFICATION_TYPE,
  TASK_DESCRIPTION_CHANGED_NOTIFICATION_TYPE,
  TASK_STATUS_CHANGED_NOTIFICATION_TYPE,
  createTaskSubscriberNotifications,
  createTaskMentionNotifications,
  isNotifiable,
  subscribeTaskParticipants,
  subscribeUsersToTask,
  taskAssignedNotificationBody,
  taskCommentedNotificationBody,
  taskDescriptionChangedNotificationBody,
  taskStatusChangedNotificationBody
} from './notifications';
import { appendSyncEvent, publishSyncEvent, type SyncMutationMeta } from './sync';
import { subscribeToTask } from './task-subscriptions';
import { taskWhereForAccess, type WorkspaceAccess } from './team-access';

type CreateTaskInput = z.infer<typeof createTaskSchema>;
type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

const progressTaskStatuses = new Set(['IN_PROGRESS', 'IN_REVIEW']);

const taskReviewCancellationSelect = {
  id: true,
  workspaceId: true,
  taskId: true,
  requesterId: true,
  reviewerId: true,
  status: true,
  requestedAt: true,
  respondedAt: true,
  dueAt: true,
  comment: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.TaskReviewRequestSelect;

type TaskReviewForCancellation = Prisma.TaskReviewRequestGetPayload<{ select: typeof taskReviewCancellationSelect }>;

interface TaskReviewCancellationAudit {
  reviewId: string;
  before: ReturnType<typeof serializeTaskReviewLifecycle>;
  after: ReturnType<typeof serializeTaskReviewLifecycle>;
}

export const taskInclude = {
  project: {
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      parentId: true,
      team: { select: { id: true, name: true, slug: true } }
    }
  },
  milestone: {
    select: {
      id: true,
      name: true,
      kind: true,
      status: true,
      archivedAt: true,
      projectId: true
    }
  },
  // `kind` travels with the assignee because clients derive people lists from tasks when the roster
  // is unavailable, and a person-shaped object with no `kind` reads as HUMAN everywhere it lands.
  assignee: { select: { id: true, name: true, email: true, kind: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  reporter: { select: { id: true, name: true, email: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  attachments: { where: { commentId: null }, orderBy: { createdAt: 'asc' } },
  labels: { include: { label: true } },
  triageState: {
    select: {
      id: true,
      status: true,
      requestedInfo: true,
      snoozedUntil: true,
      reason: true,
      decidedById: true,
      createdAt: true,
      updatedAt: true
    }
  },
  // `blockingDependencies` counts only the blockers still in the way — see services/blockers.ts.
  // Every consumer of this number already read it as "is this task blocked", so filtering it here
  // is not a change of meaning, it is the number finally meaning what it is used for.
  _count: {
    select: {
      comments: true,
      subtasks: true,
      blockingDependencies: openBlockerCountSelect,
      attachments: true
    }
  }
} satisfies Prisma.TaskInclude;


export async function ensureDefaultProject(workspaceId: string): Promise<{ id: string; keyPrefix: string }> {
  return prisma.project.upsert({
    where: { workspaceId_keyPrefix: { workspaceId, keyPrefix: 'INBOX' } },
    update: {},
    create: {
      workspaceId,
      name: 'Inbox',
      keyPrefix: 'INBOX',
      description: 'Default project for quick capture and untriaged work'
    },
    select: { id: true, keyPrefix: true }
  });
}

export async function createTask(actor: RequestActor, input: CreateTaskInput, syncMutation?: SyncMutationMeta) {
  assertDescriptionFitsKind(input.description, input.kind);
  assertEffortShape(input);

  let syncEvents: SyncEvent[] = [];
  const task = await prisma.$transaction(async (tx) => {
    await assertActorCanAccessProject(tx, actor, input.projectId);
    await assertTaskRelations(tx, actor.workspace.id, input, input.projectId);

    const { key, sequence } = await reserveTaskKey(tx, input.projectId);

    const created = await tx.task.create({
      data: {
        workspaceId: actor.workspace.id,
        projectId: input.projectId,
        parentId: input.parentId,
        cycleId: input.cycleId,
        milestoneId: input.milestoneId,
        key,
        sequence,
        title: input.title,
        kind: input.kind,
        description: input.description,
        status: input.status,
        priority: input.priority,
        weight: input.weight ?? undefined,
        assigneeId: input.assigneeId,
        reporterId: actor.user.id,
        dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
        source: input.source
      },
      include: taskInclude
    });

    await syncTaskLabels(tx, actor.workspace.id, created.id, input.labels);
    const task = await tx.task.findUniqueOrThrow({ where: { id: created.id }, include: taskInclude });
    await subscribeTaskParticipants(tx, {
      workspaceId: actor.workspace.id,
      task,
      userIds: [actor.user.id]
    });
    await createTaskMentionNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      actorName: actor.user.name,
      attribution: attributedTo(actor),
      task,
      body: task.description
    });
    if (task.assigneeId && task.assigneeId !== actor.user.id) {
      await tx.notification.create({
        data: {
          workspaceId: actor.workspace.id,
          userId: task.assigneeId,
          ...attributedTo(actor),
          taskId: task.id,
          type: TASK_ASSIGNED_NOTIFICATION_TYPE,
          title: `${task.key}: ${task.title}`,
          body: taskAssignedNotificationBody(actor.user.name)
        }
      });
    }
    const taskEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: task.id,
      operation: 'created',
      entityVersion: task.version,
      actorId: actor.user.id,
      payload: {
        after: serializeTaskForResponse(task),
        changedFields: Object.keys(input)
      },
      mutation: syncMutation
    });
    syncEvents = [
      taskEvent,
      ...await appendMilestoneProgressSyncEvents(tx, {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        milestoneIds: [task.milestoneId]
      })
    ];
    return task;
  });

  for (const event of syncEvents) publishSyncEvent(event);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'task',
    entityId: task.id,
    action: 'created',
    after: task,
    source: input.source
  }).catch(() => undefined);

  return task;
}

async function reserveTaskKey(
  tx: Prisma.TransactionClient,
  projectId: string
): Promise<{ key: string; sequence: number }> {
  const incrementedProject = await tx.project.update({
    where: { id: projectId },
    data: { nextTaskNumber: { increment: 1 } },
    select: { keyPrefix: true, nextTaskNumber: true }
  });
  const reservedSequence = incrementedProject.nextTaskNumber - 1;

  // measured-people:allow — Reserves the next task key from the highest sequence in the project. Nothing about people.
  const highestTaskSequence = await tx.task.aggregate({
    where: { projectId },
    _max: { sequence: true }
  });
  const sequence = Math.max(reservedSequence, (highestTaskSequence._max.sequence ?? 0) + 1);

  if (sequence >= incrementedProject.nextTaskNumber) {
    await tx.project.update({
      where: { id: projectId },
      data: { nextTaskNumber: sequence + 1 },
      select: { id: true }
    });
  }

  return {
    key: `${incrementedProject.keyPrefix}-${sequence}`,
    sequence
  };
}

/**
 * The per-kind half of the description ceiling, applied here rather than in the schemas. On update
 * it has to be: a patch body carries no `kind`, because the kind belongs to the row being patched.
 * On create the kind *is* in the body, and this still does not live in `createTaskSchema` — a
 * `superRefine` would make that object a `ZodEffects` and `codexTaskCreateSchema` extends it, and
 * the message reaches further from here (see below). Either way the schema bounds the field at the
 * widest ceiling any task may hold and this narrows it to the ceiling that applies to *this* row.
 *
 * Refusing beats trimming, and not marginally: an Effort's description is a wayfinder map, and the
 * part a silent truncation would take is the tail of the Decisions-so-far index — the newest
 * entries, the ones a reader navigates by. That failure would arrive as a 200.
 *
 * The message carries the number because nothing else does. A `ZodError` is flattened to a bare
 * "Validation failed" on the `/sync/push` path the web app writes through, and the web client
 * reads only `message` and never `issues` on the REST path, so a limit named solely in a Zod issue
 * reaches no caller — human or agent — in either place. An `HttpError` message survives both.
 */
function assertDescriptionFitsKind(description: string | null | undefined, kind: TaskKindValue): void {
  if (typeof description !== 'string') return;

  const max = taskDescriptionMaxChars(kind);
  if (description.length <= max) return;

  throw new HttpError(
    400,
    `Description is ${description.length} characters; a ${kind} task allows ${max}.`
      + (kind === 'WORK' ? ' Only an EFFORT may hold a longer body.' : '')
  );
}

/**
 * The fields an effort may not carry, and the statuses it may not sit in — the two `CHECK`
 * constraints from #19, restated here as a refusal a caller can read.
 *
 * The constraints stay where they are and stay load-bearing: ten of the thirteen task write paths
 * never reach this function, so a service-layer assertion alone would be a sieve. What this adds is
 * the *diagnosis*. A caller that hands an effort an assignee currently gets Postgres' own words —
 * a constraint name and a dump of the failing row, as a 500 — and an agent that pasted a command
 * cannot act on that. It needs to be told which argument to drop.
 *
 * Every offending field is named in one message rather than the first one found, because the cost
 * of the alternative is a round trip per field for a caller assembling a command by trial.
 *
 * Status is the one that will be met most often, and not by mistake: `status` defaults to `TODO`
 * for every task and an effort may not be `TODO`, so anyone who omits it lands here. The message
 * therefore names the status to use rather than merely listing what is allowed. Defaulting an
 * effort to `IN_PROGRESS` instead was rejected — the schema default is applied before this code can
 * tell an omitted `status` from an explicit `TODO`, so it would silently overrule a caller that
 * asked for one thing and got another.
 */
const effortWorkFields = ['assigneeId', 'dueAt', 'weight', 'milestoneId', 'cycleId', 'parentId'] as const;
const effortStatuses = new Set(['IN_PROGRESS', 'DONE', 'CANCELED']);

function assertEffortShape(input: CreateTaskInput): void {
  if (input.kind !== 'EFFORT') return;

  const problems: string[] = [];

  const carried = effortWorkFields.filter((field) => input[field] !== undefined && input[field] !== null);
  if (carried.length > 0) {
    problems.push(
      `An effort cannot carry ${carried.join(', ')} — it is the root of a piece of work, not a unit of`
        + ' work, and every such field belongs to the tasks underneath it.'
    );
  }

  if (!effortStatuses.has(input.status)) {
    problems.push(
      `An effort cannot be created with status ${input.status} — a charted effort has already begun,`
        + ' so pass status IN_PROGRESS, or DONE or CANCELED for one that is over.'
    );
  }

  if (problems.length === 0) return;
  throw new HttpError(400, problems.join(' '));
}

export async function updateTask(
  actor: RequestActor,
  taskId: string,
  input: UpdateTaskInput,
  syncMutation?: SyncMutationMeta,
  baseVersion?: number
) {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: actor.workspace.id },
    include: taskInclude
  });
  if (!existing) throw new Error('Task not found in this workspace');
  assertDescriptionFitsKind(input.description, existing.kind);
  await assertNoConflictingTaskUpdate(actor.workspace.id, taskId, input, existing.version, baseVersion);

  let syncEvents: SyncEvent[] = [];
  let reviewCancellationAudits: TaskReviewCancellationAudit[] = [];
  const task = await prisma.$transaction(async (tx) => {
    const targetProjectId = input.projectId ?? existing.projectId;
    const isProjectChange = targetProjectId !== existing.projectId;
    const resolvedMilestoneId = input.milestoneId !== undefined
      ? input.milestoneId
      : isProjectChange
        ? null
        : undefined;

    if (isProjectChange) {
      await assertActorCanAccessProject(tx, actor, targetProjectId);
    }

    await assertTaskRelations(
      tx,
      actor.workspace.id,
      { ...input, milestoneId: resolvedMilestoneId },
      targetProjectId,
      taskId,
      [existing.milestoneId, resolvedMilestoneId === undefined ? existing.milestoneId : resolvedMilestoneId]
    );
    // `FOR UPDATE`, not a plain read. Without the lock this is a check-then-act: two transactions
    // both read version 1, both pass the comparison below, and the second `UPDATE` merely waits for
    // the first to commit before overwriting it — so two simultaneous body rewrites both answered
    // 200 and one line vanished, which is the bug this guard was supposed to catch. Ten concurrent
    // writers used to produce six winners. The lock makes the second transaction block here and
    // read the version the first one committed, so the comparison is against reality.
    //
    // Taken for every patch, including a label delta that will not compare versions: the row is
    // locked by the `UPDATE` a few statements later regardless, so this only moves the wait earlier,
    // and one code path is worth more than the microseconds.
    const [currentTaskState] = await tx.$queryRaw<Array<{
      version: number;
      milestoneId: string | null;
      projectId: string;
    }>>`
      SELECT "version", "milestoneId", "projectId" FROM "Task" WHERE "id" = ${taskId}::uuid FOR UPDATE
    `;
    if (!currentTaskState) {
      throw new HttpError(409, 'Task changed on another client');
    }
    // This guard protects a read-modify-write: everything above derives from `existing`, which was
    // read before the transaction, so a row that moved underneath us invalidates the derivation.
    //
    // A label delta derives nothing from it. `addLabels`/`removeLabels` are applied against the row
    // as it is now, after the update below has taken the row lock, so there is no stale read to
    // protect and the version having moved is not evidence of anything. Left in, this check would
    // hand a 409 to whichever of two concurrent relabels arrived second and undo the entire point
    // of moving the add server-side — the writes would no longer race, but one would still fail.
    //
    // Narrow on purpose: the moment a patch also carries a scalar field, it is a read-modify-write
    // again and gets the guard back.
    if (!isLabelDeltaOnly(input)) {
      if (
        currentTaskState.version !== existing.version
        || currentTaskState.milestoneId !== existing.milestoneId
        || currentTaskState.projectId !== existing.projectId
      ) {
        throw new HttpError(409, 'Task changed on another client');
      }
    }
    // A key is issued once and never again. Only the sequence moves with the task.
    //
    // Moving a task used to re-issue its key, so CORE-42 became PLAT-7 and every reference anybody
    // had written down -- in a commit message, a branch name, another task's body, a Mattermost
    // post, a bookmarked /issue/CORE-42 URL -- silently stopped resolving. Nothing announced it and
    // nothing redirected. An identifier that a move can revoke is not an identifier.
    //
    // Taskara had in fact already decided this, in the other direction, on the other path:
    // mergeProjects moves tasks between projects and deliberately keeps their keys, under a test
    // named for it. That shipped, and nothing broke, because uniqueness is [workspaceId, key] and
    // no code anywhere reads a project out of a prefix. This makes the two paths agree.
    //
    // An alias table was the alternative and it is worse rather than merely larger: it does not
    // stop the rename, so both names circulate forever and every reader has to know they are the
    // same task.
    //
    // The sequence still has to be re-reserved -- @@unique([projectId, sequence]) means a task
    // carrying 42 cannot enter a project that already has one. So after a move `key` is a name and
    // `sequence` is an ordinal in the current project, and the `prefix-sequence` equality that
    // holds at creation stops holding. Nothing reads sequence, so nothing observes it; merge has
    // behaved this way all along.
    const reservedSequence = isProjectChange ? (await reserveTaskKey(tx, targetProjectId)).sequence : null;

    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        projectId: isProjectChange ? targetProjectId : undefined,
        sequence: reservedSequence ?? undefined,
        title: input.title,
        description: input.description === undefined ? undefined : input.description,
        status: input.status,
        priority: input.priority,
        weight: input.weight === undefined ? undefined : input.weight,
        assigneeId: input.assigneeId === undefined ? undefined : input.assigneeId,
        parentId: input.parentId === undefined ? undefined : input.parentId,
        cycleId: input.cycleId === undefined ? undefined : input.cycleId,
        milestoneId: resolvedMilestoneId,
        dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
        completedAt: input.status === 'DONE' ? new Date() : input.status ? null : undefined,
        version: { increment: 1 }
      },
      include: taskInclude
    });

    if (input.labels) {
      await tx.taskLabel.deleteMany({ where: { taskId } });
      await syncTaskLabels(tx, actor.workspace.id, taskId, input.labels);
    } else if (input.addLabels || input.removeLabels) {
      await applyTaskLabelDelta(tx, actor.workspace.id, taskId, input.addLabels, input.removeLabels);
    }

    const task = await tx.task.findUniqueOrThrow({ where: { id: updated.id }, include: taskInclude });
    if (input.assigneeId) {
      await subscribeUsersToTask(tx, {
        workspaceId: actor.workspace.id,
        taskId: task.id,
        userIds: [input.assigneeId]
      });
    }

    if (input.description !== undefined) {
      await subscribeTaskParticipants(tx, {
        workspaceId: actor.workspace.id,
        task
      });
    }

    let mentionedUserIds: string[] = [];
    if (input.description !== undefined) {
      mentionedUserIds = await createTaskMentionNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorUserId: actor.user.id,
        actorName: actor.user.name,
        attribution: attributedTo(actor),
        task,
        body: task.description,
        previousBody: existing.description
      });
    }

    if (input.assigneeId && input.assigneeId !== existing.assigneeId && input.assigneeId !== actor.user.id) {
      await tx.notification.create({
        data: {
          workspaceId: actor.workspace.id,
          userId: input.assigneeId,
          ...attributedTo(actor),
          taskId: task.id,
          type: TASK_ASSIGNED_NOTIFICATION_TYPE,
          title: `${task.key}: ${task.title}`,
          body: taskAssignedNotificationBody(actor.user.name)
        }
      });
    }

    if (input.status && input.status !== existing.status) {
      await createTaskSubscriberNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorUserId: actor.user.id,
        attribution: attributedTo(actor),
        task,
        type: TASK_STATUS_CHANGED_NOTIFICATION_TYPE,
        body: taskStatusChangedNotificationBody(actor.user.name, existing.status, input.status)
      });
    }

    if (input.description !== undefined && (task.description ?? null) !== (existing.description ?? null)) {
      await createTaskSubscriberNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorUserId: actor.user.id,
        attribution: attributedTo(actor),
        task,
        type: TASK_DESCRIPTION_CHANGED_NOTIFICATION_TYPE,
        body: taskDescriptionChangedNotificationBody(actor.user.name),
        excludeUserIds: mentionedUserIds
      });
    }

    const changedFields = [...new Set([
      // A sync client diffs task fields, and the task field that moved is `labels` however the
      // caller spelled the request. `addLabels` is a verb on the wire, not a column, and a client
      // that has never heard of it would otherwise be told nothing changed.
      ...Object.keys(input).map((field) => (labelDeltaFields.has(field) ? 'labels' : field)),
      ...(isProjectChange && input.milestoneId === undefined && existing.milestoneId ? ['milestoneId'] : [])
    ])];
    const taskEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: task.id,
      operation: 'updated',
      entityVersion: task.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(existing),
        after: serializeTaskForResponse(task),
        changedFields
      },
      mutation: syncMutation
    });
    const reviewCancellation = await cancelActiveTaskReviewsForTaskStatusChange(tx, actor, task.id, input.status);
    reviewCancellationAudits = reviewCancellation.audits;
    const milestoneEvents = await appendMilestoneProgressSyncEvents(tx, {
      workspaceId: actor.workspace.id,
      actorId: actor.user.id,
      milestoneIds: [existing.milestoneId, task.milestoneId]
    });
    syncEvents = [taskEvent, ...reviewCancellation.events, ...milestoneEvents];
    return task;
  });

  for (const event of syncEvents) publishSyncEvent(event);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'task',
    entityId: task.id,
    action: 'updated',
    before: existing,
    after: task,
    source: actor.source
  }).catch(() => undefined);

  await Promise.all(
    reviewCancellationAudits.map((audit) =>
      logActivity({
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        actorType: actor.actorType,
        actorRuntime: actor.actorRuntime,
        entityType: 'task_review',
        entityId: audit.reviewId,
        action: 'canceled',
        before: audit.before,
        after: audit.after,
        source: actor.source
      }).catch(() => undefined)
    )
  );

  return task;
}

export interface ClaimTaskResult {
  claimed: boolean;
  task: Awaited<ReturnType<typeof findTaskWithInclude>>;
}

async function findTaskWithInclude(workspaceId: string, taskId: string) {
  return prisma.task.findFirstOrThrow({
    where: { id: taskId, workspaceId },
    include: taskInclude
  });
}

/**
 * Take an unassigned task, or fail and say who holds it.
 *
 * The mutual exclusion is the `where` clause, not a check the caller performs first: one
 * `updateMany` filtered on `assigneeId: null`, and the row count is the answer. Two agents racing
 * for the same ticket both issue this, Postgres serialises them on the row, and exactly one sees a
 * count of 1. Reading the assignee and then assigning — the convention that let #33 be built twice
 * — cannot be made safe from the client no matter how carefully it is done.
 *
 * Deliberately not idempotent for a caller that already holds the task: `claimed: false` means "you
 * did not take this now", which is the only question a caller racing for exclusive work is asking.
 * Answering "yes, you had it already" would let a re-run of an orchestrating script conclude it had
 * just won a race it never entered.
 */
export async function claimTask(actor: RequestActor, taskId: string): Promise<ClaimTaskResult> {
  const existing = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: actor.workspace.id },
    select: { id: true, kind: true }
  });
  if (!existing) throw new HttpError(404, 'Task not found');
  // An effort carries no assignee — a CHECK constraint says so — so a claim on one is not a race
  // that was lost, it is a category error. Caught here because the alternative is the constraint
  // rejecting the write and the caller receiving a 500 with Postgres in it.
  if (existing.kind === 'EFFORT') {
    throw new HttpError(400, 'An effort cannot be claimed: it is not a unit of work');
  }

  const { count } = await prisma.task.updateMany({
    where: { id: taskId, workspaceId: actor.workspace.id, assigneeId: null },
    data: { assigneeId: actor.user.id, version: { increment: 1 } }
  });

  const task = await findTaskWithInclude(actor.workspace.id, taskId);
  if (count === 0) return { claimed: false, task };

  // The deliberate path, not the automatic one, and the distinction is the whole of #54's stickiness
  // rule: a mute survives what *other people* do to a task, and yields to what its owner does. A
  // claim is the claimant's own act — holding a task while hearing nothing about it is not what
  // anybody who muted it meant — so this withdraws their mute exactly as an explicit subscribe does.
  // An agent claiming still gets no subscription: `subscribeToTask` writes one, but #39 keeps agents
  // out of every fan-out, so the row is inert. Left as it is rather than special-cased, because the
  // claim path already treats agents and people alike everywhere else.
  if (isNotifiable(actor.user)) await subscribeToTask(actor, taskId);

  const event = await appendSyncEvent(prisma, {
    workspaceId: actor.workspace.id,
    entityType: 'task',
    entityId: taskId,
    operation: 'updated',
    entityVersion: task.version,
    actorId: actor.user.id,
    payload: {
      before: serializeTaskForResponse({ ...task, assignee: null, assigneeId: null }),
      after: serializeTaskForResponse(task),
      changedFields: ['assigneeId']
    }
  });
  publishSyncEvent(event);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'task',
    entityId: taskId,
    action: 'claimed',
    after: task,
    source: actor.source
  }).catch(() => undefined);

  return { claimed: true, task };
}

export async function deleteTask(actor: RequestActor, taskId: string, syncMutation?: SyncMutationMeta) {
  let syncEvents: SyncEvent[] = [];
  const existing = await prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: { id: taskId, workspaceId: actor.workspace.id },
      include: taskInclude
    });
    if (!existing) throw new Error('Task not found in this workspace');

    await lockMilestonesForUpdate(tx, actor.workspace.id, [existing.milestoneId]);
    const currentTaskState = await tx.task.findUnique({
      where: { id: taskId },
      select: { version: true, milestoneId: true }
    });
    if (
      !currentTaskState
      || currentTaskState.version !== existing.version
      || currentTaskState.milestoneId !== existing.milestoneId
    ) {
      throw new HttpError(409, 'Task changed on another client');
    }
    await tx.task.delete({ where: { id: taskId } });
    const taskEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: existing.id,
      operation: 'deleted',
      entityVersion: existing.version,
      actorId: actor.user.id,
      payload: {
        before: serializeTaskForResponse(existing),
        changedFields: ['deleted']
      },
      mutation: syncMutation
    });
    syncEvents = [
      taskEvent,
      ...await appendMilestoneProgressSyncEvents(tx, {
        workspaceId: actor.workspace.id,
        actorId: actor.user.id,
        milestoneIds: [existing.milestoneId]
      })
    ];
    return existing;
  });

  for (const event of syncEvents) publishSyncEvent(event);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'task',
    entityId: existing.id,
    action: 'deleted',
    before: existing,
    source: actor.source
  }).catch(() => undefined);

  return existing;
}

export async function addTaskComment(
  actor: RequestActor,
  taskId: string,
  body: string,
  source: TaskSource,
  mattermostPostId?: string,
  syncMutation?: SyncMutationMeta
) {
  let syncEvent: SyncEvent | null = null;
  const { task, comment } = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, workspaceId: actor.workspace.id } });
    if (!task) throw new Error('Task not found in this workspace');

    const comment = await tx.taskComment.create({
      data: {
        taskId,
        authorId: actor.user.id,
        body,
        source,
        mattermostPostId
      },
      include: {
        author: { select: { id: true, name: true, email: true, avatarUrl: true } },
        attachments: { orderBy: { createdAt: 'asc' } }
      }
    });
    const updatedTask = await tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    // #55. The mention runs first because its recipients are then excluded from the fan-out: one
    // comment is one event, and somebody who was named should be told *that*, not that a comment
    // happened. Both rows would carry the same `createdAt` — Postgres `now()` is the transaction's
    // start — so leaving both would make the inbox thread show one label or the other at random.
    // The same ordering, and the same exclusion, that a description edit already uses.
    const mentionedUserIds = await createTaskMentionNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      actorName: actor.user.name,
      attribution: attributedTo(actor),
      task: updatedTask,
      body: comment.body
    });
    // Named in a comment, and therefore on the list — as on a description. A mention in a comment
    // is nearly always a question, and the answer to it is the next comment. Subscribed with the
    // ids that were actually notified rather than with everything the body named, so the two lists
    // cannot disagree; and through `subscribeUsersToTask`, which is where #54's mute is honoured,
    // so being spoken to does not quietly undo a decision not to watch.
    await subscribeUsersToTask(tx, {
      workspaceId: actor.workspace.id,
      taskId: task.id,
      userIds: mentionedUserIds
    });
    await createTaskSubscriberNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      attribution: attributedTo(actor),
      task: updatedTask,
      type: TASK_COMMENTED_NOTIFICATION_TYPE,
      body: taskCommentedNotificationBody(actor.user.name),
      excludeUserIds: mentionedUserIds
    });
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: task.id,
      operation: 'commented',
      entityVersion: updatedTask.version,
      actorId: actor.user.id,
      payload: {
        comment: serializeForJson(comment),
        after: serializeTaskForResponse(updatedTask),
        changedFields: ['comments']
      },
      mutation: syncMutation
    });
    return { task, comment };
  });

  if (syncEvent) publishSyncEvent(syncEvent);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    actorRuntime: actor.actorRuntime,
    entityType: 'task',
    entityId: task.id,
    action: 'commented',
    after: comment,
    source
  }).catch(() => undefined);

  return comment;
}

export function shouldCancelActiveTaskReviewsForStatusChange(nextStatus?: string): boolean {
  return Boolean(nextStatus && nextStatus !== 'IN_REVIEW');
}

async function cancelActiveTaskReviewsForTaskStatusChange(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  taskId: string,
  nextStatus?: string
): Promise<{ events: SyncEvent[]; audits: TaskReviewCancellationAudit[] }> {
  if (!shouldCancelActiveTaskReviewsForStatusChange(nextStatus)) {
    return { events: [], audits: [] };
  }

  const activeReviews = await tx.taskReviewRequest.findMany({
    where: {
      workspaceId: actor.workspace.id,
      taskId,
      status: 'REQUESTED'
    },
    select: taskReviewCancellationSelect
  });
  if (!activeReviews.length) return { events: [], audits: [] };

  const now = new Date();
  const events: SyncEvent[] = [];
  const audits: TaskReviewCancellationAudit[] = [];

  for (const review of activeReviews) {
    const before = serializeTaskReviewLifecycle(review);
    const updated = await tx.taskReviewRequest.update({
      where: { id: review.id },
      data: {
        status: 'CANCELED',
        respondedAt: now
      },
      select: taskReviewCancellationSelect
    });
    const after = serializeTaskReviewLifecycle(updated);
    const event = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'review',
      entityId: review.id,
      operation: 'canceled',
      actorId: actor.user.id,
      payload: {
        before,
        after,
        changedFields: ['status', 'respondedAt'],
        reason: 'task_status_changed',
        taskStatus: nextStatus
      }
    });
    events.push(event);
    audits.push({ reviewId: review.id, before, after });
  }

  return { events, audits };
}

function serializeTaskReviewLifecycle(review: TaskReviewForCancellation) {
  return {
    id: review.id,
    workspaceId: review.workspaceId,
    taskId: review.taskId,
    requesterId: review.requesterId,
    reviewerId: review.reviewerId,
    status: review.status,
    requestedAt: review.requestedAt.toISOString(),
    respondedAt: review.respondedAt?.toISOString() ?? null,
    dueAt: review.dueAt?.toISOString() ?? null,
    comment: review.comment,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString()
  };
}

export async function findTaskByIdOrKey(
  workspaceId: string,
  idOrKey: string,
  access: string[] | WorkspaceAccess | null = null
): Promise<Task | null> {
  const normalized = idOrKey.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);
  const accessWhere = taskLookupAccessWhere(workspaceId, access);

  return prisma.task.findFirst({
    where: {
      ...accessWhere,
      OR: [
        ...(isUuid ? [{ id: normalized }] : []),
        { key: normalized.toUpperCase() }
      ]
    }
  });
}

async function syncTaskLabels(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskId: string,
  rawLabels: string[]
): Promise<void> {
  const names = [...new Set(rawLabels.map((label) => label.trim()).filter(Boolean))];
  for (const name of names) {
    const label = await tx.label.upsert({
      where: { workspaceId_name: { workspaceId, name } },
      update: {},
      create: { workspaceId, name }
    });
    await tx.taskLabel.create({ data: { taskId, labelId: label.id } });
  }
}

/**
 * Add and remove labels against whatever the row holds right now, rather than against a set the
 * caller read a moment ago. That is the whole difference from `syncTaskLabels`: no caller state
 * takes part, so two concurrent deltas touching different labels both survive.
 *
 * Removals run first so `--remove-label x --add-label x` settles on present rather than on
 * whichever query the database happened to order last.
 */
async function applyTaskLabelDelta(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskId: string,
  addLabels: string[] | undefined,
  removeLabels: string[] | undefined
): Promise<void> {
  const remove = normalizeLabelNames(removeLabels ?? []);
  const add = normalizeLabelNames(addLabels ?? []);

  if (remove.length > 0) {
    await tx.taskLabel.deleteMany({
      where: { taskId, label: { workspaceId, name: { in: remove } } }
    });
  }

  for (const name of add) {
    const label = await tx.label.upsert({
      where: { workspaceId_name: { workspaceId, name } },
      update: {},
      create: { workspaceId, name }
    });
    // `TaskLabel` is keyed on the pair, so re-adding a label the task already carries is a no-op
    // rather than a unique violation. An add has to be idempotent: a retried request must not be
    // the difference between success and a 500.
    await tx.taskLabel.upsert({
      where: { taskId_labelId: { taskId, labelId: label.id } },
      update: {},
      create: { taskId, labelId: label.id }
    });
  }

  // The cap `labels` enforces per-request, enforced here on the result instead. Checking the input
  // array would let a task grow without bound twelve labels at a time, which is the one thing the
  // cap exists to stop.
  const total = await tx.taskLabel.count({ where: { taskId } });
  if (total > maxTaskLabels) {
    throw new HttpError(400, `A task cannot carry more than ${maxTaskLabels} labels`);
  }
}

function normalizeLabelNames(rawLabels: string[]): string[] {
  return [...new Set(rawLabels.map((label) => label.trim()).filter(Boolean))];
}

const labelDeltaFields = new Set(['addLabels', 'removeLabels']);

/**
 * Whether a patch changes nothing but labels, additively. Keyed off the actual request keys rather
 * than off the parsed defaults, because an absent field and a field set to undefined mean the same
 * thing here and neither is a change.
 */
function isLabelDeltaOnly(input: UpdateTaskInput): boolean {
  const present = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return present.length > 0 && present.every((key) => labelDeltaFields.has(key));
}

async function assertTaskRelations(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  input: {
    assigneeId?: string | null;
    parentId?: string | null;
    cycleId?: string | null;
    milestoneId?: string | null;
  },
  projectId: string,
  taskId?: string,
  milestoneLockIds: Array<string | null | undefined> = [input.milestoneId]
): Promise<void> {
  if (input.parentId && input.parentId === taskId) {
    throw new HttpError(400, 'Task cannot be its own parent');
  }
  if (input.parentId && taskId) {
    await assertParentIsNotDescendant(tx, workspaceId, taskId, input.parentId);
  }

  const lockedMilestones = await lockMilestonesForUpdate(tx, workspaceId, milestoneLockIds);
  const [project, assignee, parent, cycle] = await Promise.all([
    tx.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, teamId: true }
    }),
    input.assigneeId
      ? tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } },
          select: { id: true }
        })
      : Promise.resolve(null),
    input.parentId
      ? tx.task.findFirst({ where: { id: input.parentId, workspaceId, projectId }, select: { id: true } })
      : Promise.resolve(null),
    input.cycleId
      ? tx.cycle.findFirst({
          where: {
            id: input.cycleId,
            workspaceId,
            OR: [{ projectId }, { projectId: null }]
          },
          select: { id: true }
        })
      : Promise.resolve(null)
  ]);

  if (!project) throw new HttpError(400, 'Project not found in this workspace');
  if (input.assigneeId && !assignee) throw new HttpError(400, 'Assignee must belong to this workspace');
  if (input.assigneeId && project.teamId) {
    const assigneeTeamMembership = await tx.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId: input.assigneeId } },
      select: { id: true }
    });
    if (!assigneeTeamMembership) throw new HttpError(400, 'Assignee must belong to the project team');
  }
  if (input.parentId && !parent) throw new HttpError(400, 'Parent task not found in this project');
  if (input.cycleId && !cycle) throw new HttpError(400, 'Cycle not found for this project');
  const milestone = input.milestoneId ? lockedMilestones.get(input.milestoneId) : null;
  if (
    input.milestoneId
    && (
      !milestone
      || milestone.projectId !== projectId
      || milestone.archivedAt
      || !selectableMilestoneStatus(milestone.status)
    )
  ) {
    throw new HttpError(400, 'Milestone must be open and belong to the task project');
  }
}

function selectableMilestoneStatus(status: string): boolean {
  return status === 'PLANNED' || status === 'ACTIVE';
}

/**
 * How deep a subtask chain may go. Generous enough that no real breakdown reaches it, small enough
 * that the ancestor walk below is a handful of round trips rather than an unbounded one.
 */
const MAX_TASK_TREE_DEPTH = 50;

/**
 * `parentId` is the other edge that has to stay acyclic, and it had the same hole the blocking
 * edges did: only self-parenting was refused, so a task could be reparented under its own child and
 * the pair would then be its own ancestry. Nothing that walks the tree — breadcrumbs, subtask
 * rollups, a map's children — survives that.
 *
 * Walking up from the *proposed parent* answers both questions at once: reaching the task means the
 * task is an ancestor of its own parent-to-be, which is exactly a cycle. The visited set is there
 * because the ancestry may already be circular from before this check existed, and the walk must
 * refuse such a graph instead of spinning on it.
 */
async function assertParentIsNotDescendant(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskId: string,
  parentId: string
): Promise<void> {
  const visited = new Set<string>([parentId]);
  let cursor: string | null = parentId;

  for (let depth = 0; cursor; depth += 1) {
    if (depth >= MAX_TASK_TREE_DEPTH) {
      throw new HttpError(400, 'Task hierarchy is too deep');
    }
    const ancestor: { parentId: string | null } | null = await tx.task.findFirst({
      where: { id: cursor, workspaceId },
      select: { parentId: true }
    });
    const next: string | null = ancestor?.parentId ?? null;
    if (!next) return;
    if (next === taskId) {
      throw new HttpError(400, 'Task cannot become a descendant of itself');
    }
    if (visited.has(next)) {
      throw new HttpError(400, 'Task hierarchy already contains a cycle');
    }
    visited.add(next);
    cursor = next;
  }
}

async function assertActorCanAccessProject(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  projectId: string
): Promise<{ id: string; teamId: string | null }> {
  const project = await tx.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspace.id },
    select: { id: true, teamId: true, leadId: true }
  });
  if (!project) throw new HttpError(400, 'Project not found in this workspace');

  if (!project.teamId || isWorkspaceAdminRole(actor.role) || project.leadId === actor.user.id) return project;

  const projectMembership = await tx.projectMember.findUnique({
    where: {
      projectId_userId: {
        projectId: project.id,
        userId: actor.user.id
      }
    },
    select: { id: true }
  });

  if (projectMembership) return project;

  const membership = await tx.teamMember.findUnique({
    where: {
      teamId_userId: {
        teamId: project.teamId,
        userId: actor.user.id
      }
    },
    select: { id: true }
  });

  if (!membership) throw new HttpError(403, 'Project access denied');
  return project;
}

function taskLookupAccessWhere(
  workspaceId: string,
  access: string[] | WorkspaceAccess | null
): Prisma.TaskWhereInput {
  if (!access) return { workspaceId };
  if (Array.isArray(access)) {
    return {
      workspaceId,
      project: { OR: [{ teamId: null }, { teamId: { in: access } }] }
    };
  }

  return taskWhereForAccess(access);
}

async function assertNoConflictingTaskUpdate(
  workspaceId: string,
  taskId: string,
  input: UpdateTaskInput,
  currentVersion: number,
  baseVersion?: number
): Promise<void> {
  if (baseVersion === undefined || baseVersion >= currentVersion) return;

  // Raw keys, deliberately unmapped — the mirror image of the sync event above, which rewrites
  // `addLabels` to `labels`. There it is being announced, and a listener needs the column name.
  // Here it is being tested for conflict, and an additive delta conflicts with nothing: it does not
  // depend on the set it is applied to. Mapping it would resurrect exactly the false conflict this
  // idiom exists to remove.
  const changedFields = new Set(Object.keys(input));
  if (changedFields.size === 0) return;

  const remoteEvents = await prisma.syncEvent.findMany({
    where: {
      workspaceId,
      entityType: 'task',
      entityId: taskId,
      entityVersion: { gt: baseVersion },
      operation: { in: ['updated', 'deleted'] }
    },
    select: { operation: true, payload: true }
  });

  if (hasTaskFieldConflict([...changedFields], remoteEvents)) {
    throw new HttpError(409, 'Task changed on another client');
  }
}

export function hasTaskFieldConflict(
  localChangedFields: string[],
  remoteEvents: Array<{ operation: string; payload: unknown }>
): boolean {
  const changedFields = new Set(localChangedFields);
  for (const event of remoteEvents) {
    if (event.operation === 'deleted') {
      return true;
    }

    const remoteChangedFields = syncEventChangedFields(event.payload);
    if (remoteChangedFields.some((field) => changedFields.has(field))) {
      return true;
    }
  }
  return false;
}

function syncEventChangedFields(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || !('changedFields' in payload)) return [];
  const changedFields = (payload as { changedFields?: unknown }).changedFields;
  return Array.isArray(changedFields) ? changedFields.filter((field): field is string => typeof field === 'string') : [];
}

export function serializeForJson<T>(value: T): T {
  return snapshot(value) as T;
}

export function serializeTaskForResponse<T extends Record<string, unknown>>(task: T): T {
  const taskRecord = task as Record<string, unknown>;
  const serialized: Record<string, unknown> = { ...taskRecord };

  if (Array.isArray(taskRecord.attachments)) {
    serialized.attachments = taskRecord.attachments.map((attachment) =>
      serializeTaskAttachment(attachment as Parameters<typeof serializeTaskAttachment>[0])
    );
  }
  if (Array.isArray(taskRecord.comments)) {
    serialized.comments = taskRecord.comments.map((comment) => {
      if (!comment || typeof comment !== 'object' || !('attachments' in comment)) return comment;
      const typedComment = comment as Record<string, unknown>;
      if (!Array.isArray(typedComment.attachments)) return comment;
      return {
        ...typedComment,
        attachments: typedComment.attachments.map((attachment) =>
          serializeTaskAttachment(attachment as Parameters<typeof serializeTaskAttachment>[0])
        )
      };
    });
  }
  return serialized as T;
}

type TaskWithProgressTimestamp = Record<string, unknown> & {
  id: string;
  status?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  progressStartedAt?: string | null;
};

export async function addTaskProgressStartedAt<T extends TaskWithProgressTimestamp>(
  workspaceId: string,
  tasks: T[]
): Promise<T[]> {
  const progressTasks = tasks.filter((task) => task.id && isProgressTaskStatus(task.status));
  if (progressTasks.length === 0) {
    return tasks.map((task) => ({ ...task, progressStartedAt: null }));
  }

  const taskIds = progressTasks.map((task) => task.id);
  const startedAtByTaskId = await progressStartedAtByTaskId(workspaceId, taskIds);

  return tasks.map((task) => {
    if (!isProgressTaskStatus(task.status)) return { ...task, progressStartedAt: null };
    return {
      ...task,
      progressStartedAt:
        startedAtByTaskId.get(task.id) ||
        isoString(task.updatedAt) ||
        isoString(task.createdAt) ||
        null
    };
  });
}

async function progressStartedAtByTaskId(workspaceId: string, taskIds: string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();

  const events = await prisma.syncEvent.findMany({
    where: {
      workspaceId,
      entityType: 'task',
      entityId: { in: taskIds },
      operation: { in: ['created', 'updated'] }
    },
    orderBy: { workspaceSeq: 'asc' },
    select: {
      entityId: true,
      operation: true,
      payload: true,
      createdAt: true
    }
  });
  const startedAtByTaskId = new Map<string, string>();

  for (const event of events) {
    const payload = recordValue(event.payload);
    const beforeStatus = taskStatusFromPayload(payload?.before);
    const afterStatus = taskStatusFromPayload(payload?.after);

    if (!afterStatus) continue;

    if (isProgressTaskStatus(afterStatus)) {
      if (event.operation === 'created' || !isProgressTaskStatus(beforeStatus)) {
        startedAtByTaskId.set(event.entityId, event.createdAt.toISOString());
      }
      continue;
    }

    startedAtByTaskId.delete(event.entityId);
  }

  return startedAtByTaskId;
}

function taskStatusFromPayload(value: unknown): string | null {
  const record = recordValue(value);
  const status = record?.status;
  return typeof status === 'string' ? status : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function isProgressTaskStatus(status: unknown): boolean {
  return typeof status === 'string' && progressTaskStatuses.has(status);
}

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
