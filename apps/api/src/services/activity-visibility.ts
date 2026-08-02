import { prisma, type Prisma } from '@taskara/db';
import type { ActivityEntityType } from './audit';
import { canReadProject, canReadTeam, type WorkspaceAccess } from './team-access';

/**
 * Who may read an activity row.
 *
 * Issue #59, fourth in the chain after #57 (notification delivery) and #58 (dependency far ends).
 * `GET /activity` returned the last 50 rows for the whole workspace to any member with no access
 * clause of any kind, and an activity row's `after` is a **snapshot of the entire entity**. So a
 * member on no team read task titles, bodies and assignees from every project in the workspace —
 * one request, every entity type at once.
 *
 * ## Omitted, not redacted — the opposite of #58, on purpose
 *
 * #58 kept an unreadable dependency edge and blanked its far end, because dropping the edge makes a
 * blocked task read as **takeable**: the list is load-bearing for a decision, so a shorter list is
 * a lie. A feed has no such invariant. Nobody decides anything from the absence of a row, because
 * an activity feed is already a window — the last 50 of an unbounded stream, arbitrarily truncated
 * by time. "Recent activity you can read" is a complete and honest answer to that question, where
 * fifty anonymous "somebody did something somewhere" placeholders would be worse than nothing: they
 * disclose the volume, the timing and the actor of work behind a wall, and they crowd out the rows
 * the reader is actually entitled to. So a row the reader cannot place is **dropped**.
 *
 * The one place the #58 argument does survive is *inside* a row — see
 * {@link redactActivityDependencyPayloads}.
 *
 * ## Default deny, because the pointer is polymorphic
 *
 * `ActivityLog.entityType` / `entityId` is a loose pointer with no relation behind it, so no Prisma
 * predicate can reach through it and there is no single query that answers this. The table below is
 * therefore an explicit **allowlist**: an entity type with no rule written for it is invisible to
 * everyone but a workspace admin. A new entity type added by some future ticket starts out
 * unreadable rather than starting out leaked, which is the only default that terminates this chain
 * for this surface.
 *
 * The table is a `Record<ActivityEntityType, …>` and {@link ActivityEntityType} is what `logActivity`
 * accepts, so the two cannot drift: a type nobody has placed here does not compile at the site that
 * writes it. That is the guard for this ticket — the compiler, not a fourth harness.
 *
 * ## It does not restate the access rule
 *
 * Every entry resolves the row's entity to the facts `canReadProject` or `canReadTeam` already ask
 * about, and then calls one of them. Same discipline as #57's `filterUsersWithTaskAccess` and #58's
 * `visibleRelatedTask`: the queries gather facts, `team-access.ts` makes the decision.
 */

/** What the classifier needs off a row to place it. Deliberately not the whole row. */
export interface ActivityEntityRef {
  entityType: string;
  entityId: string;
}

/** The project facts `canReadProject` asks about. */
type ProjectRef = { id: string; teamId: string | null; leadId: string | null };

const projectSelect = { id: true, teamId: true, leadId: true } as const;

/**
 * How a row's entity is placed for the reader.
 *
 * `project` and `team` resolve the entity and defer to `team-access.ts`. `admin` means "no rule
 * exists that this module can call, so only a reader who may read everything gets it" — a deny
 * whose reason is recorded per type below, not a shrug.
 */
type EntityScope =
  | { kind: 'admin' }
  | { kind: 'project'; projects: (workspaceId: string, ids: string[]) => Promise<Map<string, ProjectRef>> }
  | { kind: 'team'; teams: (workspaceId: string, ids: string[]) => Promise<Map<string, string>> };

function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function projectsOf(rows: Array<{ id: string; project: ProjectRef }>): Map<string, ProjectRef> {
  return new Map(rows.map((row) => [row.id, row.project]));
}

const throughOwnProject: EntityScope = {
  kind: 'project',
  projects: async (workspaceId, ids) =>
    byId(await prisma.project.findMany({ where: { id: { in: ids }, workspaceId }, select: projectSelect }))
};

/**
 * The allowlist. `Record<ActivityEntityType, …>` is load-bearing: it is a compile error to write an
 * entity type `logActivity` accepts and leave it unplaced here, and a compile error to place one
 * that cannot be written. A row whose type is not in the union at all — a legacy row, or one
 * written straight to the table — still falls through to deny at runtime.
 */
const ACTIVITY_ENTITY_SCOPE: Record<ActivityEntityType, EntityScope> = {
  // ── Work, placed by the project it lives in ──────────────────────────────────────────────────
  task: {
    kind: 'project',
    projects: async (workspaceId, ids) =>
      projectsOf(await prisma.task.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, project: { select: projectSelect } }
      }))
  },
  project: throughOwnProject,
  milestone: {
    kind: 'project',
    projects: async (workspaceId, ids) =>
      projectsOf(await prisma.milestone.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, project: { select: projectSelect } }
      }))
  },
  project_health_update: {
    kind: 'project',
    projects: async (workspaceId, ids) =>
      projectsOf(await prisma.projectHealthUpdate.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, project: { select: projectSelect } }
      }))
  },
  task_review: {
    kind: 'project',
    projects: async (workspaceId, ids) =>
      new Map((await prisma.taskReviewRequest.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, task: { select: { project: { select: projectSelect } } } }
      })).map((row) => [row.id, row.task.project]))
  },

  // ── Teams, placed by `canReadTeam` ───────────────────────────────────────────────────────────
  team: { kind: 'team', teams: async (_workspaceId, ids) => new Map(ids.map((id) => [id, id])) },
  team_member: {
    kind: 'team',
    teams: async (workspaceId, ids) =>
      new Map((await prisma.teamMember.findMany({
        where: { id: { in: ids }, team: { workspaceId } },
        select: { id: true, teamId: true }
      })).map((row) => [row.id, row.teamId]))
  },

  // ── Administrative: the snapshot is the workspace's own record-keeping ───────────────────────
  // These are not denied for want of a rule. A `user` row snapshots the email and phone either
  // side of a profile edit, `workspace_invite` carries the invited address, `agent_credential`
  // records who may act as an agent, and `workspace_member` is a role change. Every one of them is
  // written by an admin-only route and none is anybody else's business in a feed.
  user: { kind: 'admin' },
  workspace_member: { kind: 'admin' },
  workspace_invite: { kind: 'admin' },
  agent_credential: { kind: 'admin' },

  // ── Denied because the entity's own read rule is not callable from here ──────────────────────
  // Each of these has a real gate — an announcement has recipients, a knowledge page has a space,
  // a one-on-one has two participants, a check-in is somebody's daily report — and each of those
  // gates lives inside its own service as a query, not as a predicate this module can compose. A
  // second spelling here is exactly the drift #37 was filed about, so they are denied instead, and
  // widening one means exporting its real rule first. Recorded in
  // `.scratch/AUDIT-read-access-sites.md` as open, not closed.
  announcement: { kind: 'admin' },
  attention: { kind: 'admin' },
  check_in: { kind: 'admin' },
  knowledge_page: { kind: 'admin' },
  knowledge_space: { kind: 'admin' },
  meeting: { kind: 'admin' },
  meeting_action_item: { kind: 'admin' },
  one_on_one: { kind: 'admin' },
  one_on_one_agenda_item: { kind: 'admin' }
};

/** The types a non-admin can ever be shown, so the candidate scan can drop the rest in SQL. */
const READABLE_ENTITY_TYPES = (Object.keys(ACTIVITY_ENTITY_SCOPE) as ActivityEntityType[])
  .filter((entityType) => ACTIVITY_ENTITY_SCOPE[entityType].kind !== 'admin');

/**
 * A row's rule, read by the string that is actually on the row.
 *
 * `undefined` for a type nobody has placed — the runtime half of the compile-time guard above,
 * because a row already in the table was written before the union existed and answers to nothing.
 */
function scopeOf(entityType: string): EntityScope | undefined {
  return (ACTIVITY_ENTITY_SCOPE as Record<string, EntityScope | undefined>)[entityType];
}

/**
 * Of these rows, the ones this reader may be shown. Order is preserved.
 *
 * An entity that no longer exists resolves to nothing and is therefore **dropped**: a `deleted` row
 * outlives its subject by design, and there is no way left to prove the reader could have opened
 * it. Denying it costs an admin nothing (they short-circuit above) and is the safe direction for
 * everyone else.
 */
export async function filterActivityByEntityAccess<T extends ActivityEntityRef>(
  access: WorkspaceAccess,
  rows: T[]
): Promise<T[]> {
  if (access.workspaceWide) return rows;
  if (!rows.length) return [];

  const idsByType = new Map<string, Set<string>>();
  for (const row of rows) {
    const scope = scopeOf(row.entityType);
    if (!scope || scope.kind === 'admin') continue;
    const ids = idsByType.get(row.entityType) ?? new Set<string>();
    ids.add(row.entityId);
    idsByType.set(row.entityType, ids);
  }

  const resolved = new Map<string, Map<string, ProjectRef | string>>();
  await Promise.all([...idsByType].map(async ([entityType, ids]) => {
    const scope = scopeOf(entityType);
    if (!scope || scope.kind === 'admin') return;
    const found = scope.kind === 'project'
      ? await scope.projects(access.workspaceId, [...ids])
      : await scope.teams(access.workspaceId, [...ids]);
    resolved.set(entityType, found as Map<string, ProjectRef | string>);
  }));

  return rows.filter((row) => {
    const scope = scopeOf(row.entityType);
    if (!scope || scope.kind === 'admin') return false;
    const found = resolved.get(row.entityType)?.get(row.entityId);
    if (found === undefined) return false;
    return scope.kind === 'project'
      ? canReadProject(access, found as ProjectRef)
      : canReadTeam(access, found as string);
  });
}

/**
 * How far back the feed looks for rows this reader may see, before giving up.
 *
 * The access question cannot be pushed into SQL through a polymorphic pointer, so the rows are
 * scanned newest-first and filtered in memory. A reader whose visible work is quiet gets fewer than
 * `limit` rows rather than an older, more expensive scan — a feed is allowed to be short, and an
 * unbounded walk backwards through an append-only table is not a thing to put on a request path.
 */
const ACTIVITY_SCAN_LIMIT = 500;

const activityActorInclude = {
  actor: { select: { id: true, name: true, email: true, avatarUrl: true } }
} satisfies Prisma.ActivityLogInclude;

/** The workspace feed, newest first, holding only what this reader may be shown. */
export async function readWorkspaceActivity(access: WorkspaceAccess, limit: number) {
  if (access.workspaceWide) {
    return prisma.activityLog.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: activityActorInclude
    });
  }

  // Two passes rather than one: the candidate scan reads only the pointer, so the snapshots — the
  // whole point of the disclosure, and the expensive column — are never loaded for a row that is
  // about to be dropped.
  const candidates = await prisma.activityLog.findMany({
    where: { workspaceId: access.workspaceId, entityType: { in: READABLE_ENTITY_TYPES } },
    orderBy: { createdAt: 'desc' },
    take: ACTIVITY_SCAN_LIMIT,
    select: { id: true, entityType: true, entityId: true }
  });

  const visible = (await filterActivityByEntityAccess(access, candidates)).slice(0, limit);
  if (!visible.length) return [];

  return prisma.activityLog.findMany({
    where: { id: { in: visible.map((row) => row.id) } },
    orderBy: { createdAt: 'desc' },
    include: activityActorInclude
  });
}

/** A row as the feed and the task timeline both return it: the pointer, plus the two snapshots. */
export interface ActivitySnapshotRow extends ActivityEntityRef {
  action: string;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
}

const DEPENDENCY_ACTIONS = new Set(['dependency_added', 'dependency_removed']);

/**
 * The one place #58's argument survives into a feed: a snapshot that names a **second** entity.
 *
 * `logDependencyChange` writes the edge to the *blocked* task's timeline with the blocker's id, key
 * and title in the payload. Every gate on both activity routes is a question about the near task,
 * and a dependency is not constrained to one project — so #58 blanked those two fields on the task
 * detail, on the agent's daily plan and in the `task_blocked` notification, and they went on being
 * served here. That is the half of this ticket that would have been theatre on its own.
 *
 * **Redacted here, not omitted, and the difference from the row-level rule above is the point.**
 * Dropping the row would say the edge was never drawn, while `GET /tasks/:idOrKey` goes on showing
 * a redacted edge in the dependency list — the timeline would contradict the task. That is #58's
 * invariant exactly, arriving on a second surface. The handles go and the event stays.
 *
 * No `open` bit, unlike #58's placeholder. That bit exists because takeability is computed from the
 * live edge list; a historical row is not consulted for it, and the current status of a task nobody
 * may open is not something a log entry needs to keep fresh.
 */
export async function redactActivityDependencyPayloads<T extends ActivitySnapshotRow>(
  access: WorkspaceAccess,
  rows: T[]
): Promise<T[]> {
  if (access.workspaceWide) return rows;

  const blockerIds = new Set<string>();
  for (const row of rows) {
    if (!DEPENDENCY_ACTIONS.has(row.action)) continue;
    for (const id of [blockerIdOf(row.before), blockerIdOf(row.after)]) if (id) blockerIds.add(id);
  }
  if (!blockerIds.size) return rows;

  const blockers = projectsOf(await prisma.task.findMany({
    where: { id: { in: [...blockerIds] }, workspaceId: access.workspaceId },
    select: { id: true, project: { select: projectSelect } }
  }));

  const readable = (id: string | null): boolean => {
    if (!id) return true;
    const project = blockers.get(id);
    // A blocker that has been deleted leaves nothing to prove access against, and nothing to
    // disclose either — but its key and title are still sitting in the payload, so it is redacted
    // on the same default-deny footing as a missing entity above.
    return project ? canReadProject(access, project) : false;
  };

  return rows.map((row) => {
    if (!DEPENDENCY_ACTIONS.has(row.action)) return row;
    return {
      ...row,
      before: readable(blockerIdOf(row.before)) ? row.before : redactBlocker(row.before),
      after: readable(blockerIdOf(row.after)) ? row.after : redactBlocker(row.after)
    };
  });
}

function blockerIdOf(payload: Prisma.JsonValue | null): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const id = (payload as Record<string, unknown>).blockedByTaskId;
  return typeof id === 'string' ? id : null;
}

/**
 * The far end blanked, with the near end left alone.
 *
 * Every key stays so the payload's shape does not change by reader — the foreign key included,
 * nulled rather than deleted, on #58's reasoning that a redaction shipping the hidden task's
 * primary key is cosmetic. `blockedByTaskRedacted` says which of the two reasons a null is a null.
 */
function redactBlocker(payload: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return {
    ...(payload as Record<string, Prisma.JsonValue>),
    blockedByTaskId: null,
    blockedByTaskKey: null,
    blockedByTaskTitle: null,
    blockedByTaskRedacted: true
  };
}
