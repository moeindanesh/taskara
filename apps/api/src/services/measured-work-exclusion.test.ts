import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type SyncEvent } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { mapSyncEventForScope } from '../routes/sync';
import { createUserSession } from './auth';
import { isWorkTask, workTaskWhere } from './measured-work';
import { readWorkPredicate, watchTaskQueries, type TaskQueryWatch } from './measured-work-harness';
import { serializeTaskForResponse } from './tasks';

/**
 * An EFFORT is kept out of what a manager counts, and stays reachable everywhere a human reads.
 *
 * This test never opens a source file. It seeds a workspace holding real work AND efforts that are
 * genuinely eligible for each leak, drives the actual endpoints, and looks at the numbers that come
 * back — so how a query is spelled, which client it is issued through, and what its comments claim
 * are all irrelevant to whether it passes. The people-side twin of this property was first guarded
 * by scanning source text, and every widening of that scan produced a new way to evade it.
 *
 * THE FIXTURE IS THE ARGUMENT. Two CHECK constraints already forbid an EFFORT from holding an
 * assignee, a due date, a weight, a milestone, a cycle or a parent, and restrict it to
 * IN_PROGRESS / DONE / CANCELED. That closes most of the API for free — Today Load, the
 * leaderboard, assignment, every milestone rollup, every due-date queue, the whole backlog-triage
 * family. Asserting on any of those would pass against a completely unguarded predicate, because
 * no fixture can produce a subject for them. The list of assertions deliberately NOT written is at
 * the bottom of this file, with the reason for each.
 *
 * What is left is narrow and specific, and every effort below is built to be eligible for it:
 *   - ABSENCE-triggered predicates. `EFF1` is IN_PROGRESS, unassigned by construction and untouched
 *     for five days, so before the fix it lands in the unassigned queue, the stale queue, the
 *     status distribution, the active total, its project's unassignedCount and a persisted
 *     stale_task attention row. Its REPORTER, `mapper`, holds no other work at all, so before the
 *     fix a scoped viewer sees a person pulled into the people panel purely by an effort.
 *   - UNFILTERED RELATION COUNTS, which no runtime interception can see (the filter lives in
 *     `args.select`, not `args.where`), and which are therefore provable ONLY by the number
 *     assertions here.
 *   - `EFF2` sits alone in a project with no work in it, which makes the project rollup leak
 *     visible on its own rather than as an off-by-one inside a healthy project.
 *   - `EFF3` is DONE with a real completedAt, which the constraints permit, so the archive is a
 *     live leak rather than a latent one.
 */

let app: FastifyInstance;
let fixture: Fixture;
let watch: TaskQueryWatch;
let surfaces: Surfaces;

type Person = 'admin' | 'worker' | 'mapper' | 'lead';
type TaskName = 'W1' | 'W2' | 'C1' | 'W3' | 'SW' | 'EFF1' | 'EFF2' | 'EFF3' | 'SE';

interface Fixture {
  workspace: { id: string; slug: string };
  projects: { P: SeededProject; E: SeededProject; S: SeededProject };
  users: Record<Person, { id: string; name: string }>;
  tasks: Record<TaskName, { id: string; key: string }>;
  adminToken: string;
  leadToken: string;
}

interface SeededProject {
  id: string;
  keyPrefix: string;
}

interface WorkHealthBody {
  overview: {
    activeTasks: number;
    staleTasks: number;
    unassignedActiveTasks: number;
    statusCounts: Record<string, number>;
  };
  people: Array<{ user: { id: string } }>;
  attention: Array<{ reason: string; entityType: string; task?: { id: string; key: string }; user?: { id: string } }>;
  queues: {
    stale: Array<{ id: string; key: string }>;
    unassigned: Array<{ id: string; key: string }>;
  };
  projects: Array<{ project: { id: string }; activeCount: number; unassignedCount: number }>;
}

interface TaskListBody {
  items: Array<{ id: string; key: string; kind: string }>;
  total: number;
}

interface TaskDetailBody {
  id: string;
  key: string;
  kind: string;
  description: string | null;
  subtasks: Array<{ id: string; key: string }>;
}

interface ProjectCount {
  id: string;
  _count: { tasks: number };
}

interface ProjectDetailBody extends ProjectCount {
  tasks: Array<{ id: string; key: string }>;
  subprojects: ProjectCount[];
}

interface DirectoryBody {
  items: Array<{ id: string; _count: { reportedTasks: number; assignedTasks: number } }>;
}

interface AttentionBody {
  items: Array<{ entityType: string; entityId: string; reason: string }>;
}

interface BootstrapBody {
  tasks: Array<{ id: string; key: string }>;
  totalHotTasks: number;
  projects: ProjectCount[];
  users: Array<{ id: string; _count: { reportedTasks: number } }>;
}

interface InboxBody {
  items: Array<{ id: string; taskId: string | null }>;
  total: number;
  unreadCount: number;
}

interface MeBody {
  unreadNotifications: number;
}

interface Surfaces {
  workHealth: WorkHealthBody;
  scopedWorkHealth: WorkHealthBody;
  attention: AttentionBody;
  inbox: InboxBody;
  me: MeBody;
  projectTasks: TaskListBody;
  effortTasks: TaskListBody;
  effortDetail: TaskDetailBody;
  archive: TaskListBody;
  projects: ProjectCount[];
  projectDetail: ProjectDetailBody;
  effortOnlyProject: ProjectDetailBody;
  directory: DirectoryBody;
  bootstrap: BootstrapBody;
}

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await registerApp(app);
  await app.ready();
  fixture = await seedWorkspace();
  // Started around the drive, not around the assertions: the harness reports what the surfaces
  // under test actually asked the database for.
  watch = watchTaskQueries();
  try {
    surfaces = await driveSurfaces();
  } finally {
    watch.stop();
  }
});

afterAll(async () => {
  watch?.stop();
  await app?.close();
  if (fixture) {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(fixture.users).map((user) => user.id) } } });
  }
});

describe('an effort is not work, and no work list or number counts one', () => {
  test('work health measures the work and never the map', () => {
    const { workHealth } = surfaces;

    // Stated as equalities over the whole queue, not as `not.toContain`. Over a one-item list
    // `not.toContain` also passes when the list is EMPTY, so it keeps passing if the queue stops
    // being populated at all — a bug the people-side test shipped once. W2 is the control: real
    // work, unassigned and untouched for five days, sitting in the same buckets as EFF1.
    expect(keysOf(workHealth.queues.unassigned)).toEqual([fixture.tasks.W2.key]);
    expect(workHealth.overview.unassignedActiveTasks).toBe(1);
    expect(keysOf(workHealth.queues.stale)).toEqual([fixture.tasks.W2.key]);
    expect(workHealth.overview.staleTasks).toBe(1);

    // W1 alone. EFF1, EFF2 and SE are all IN_PROGRESS, so an unguarded distribution reports 4.
    expect(workHealth.overview.statusCounts.IN_PROGRESS).toBe(1);
    expect(workHealth.overview.statusCounts.TODO).toBe(3);
    // W1, W2, C1, SW.
    expect(workHealth.overview.activeTasks).toBe(4);
  });

  test('a project holding nothing but an effort is not a project needing attention', () => {
    const { workHealth } = surfaces;

    // The cleanest single signal in this file. EFFORT_ONLY contains one IN_PROGRESS effort and no
    // work at all; unguarded it appears with activeCount 1, unassignedCount 1 and health
    // 'needs_attention' — an entire project invented out of an agent's notebook.
    expect(workHealth.projects.map((entry) => entry.project.id)).not.toContain(fixture.projects.E.id);
    // …and the projects that do hold work are still reported, so the assertion above is not just
    // an empty list.
    const p = workHealth.projects.find((entry) => entry.project.id === fixture.projects.P.id);
    expect(p?.activeCount).toBe(3);
    expect(p?.unassignedCount).toBe(1);
    expect(workHealth.projects.map((entry) => entry.project.id)).toContain(fixture.projects.S.id);
  });

  test('the attention cards a manager is shown are about work', () => {
    const { workHealth } = surfaces;

    const stale = workHealth.attention.filter((item) => item.reason === 'stale_task');
    expect(stale.map((item) => item.task?.key)).toEqual([fixture.tasks.W2.key]);

    const effortIds = new Set(effortTaskIds());
    for (const item of workHealth.attention) {
      expect(effortIds.has(item.task?.id ?? '')).toBe(false);
    }
  });

  test('the persisted attention roster writes no row about an effort', () => {
    const { attention } = surfaces;

    // The half of the property that outlives the request. Everything above is a number a manager
    // reads once; these are ROWS that get assigned, snoozed and nudged about, so an effort that
    // reaches this list becomes a standing task for a human.
    const stale = attention.items.filter((item) => item.reason === 'stale_task');
    expect(stale.map((item) => item.entityId)).toEqual([fixture.tasks.W2.id]);

    const effortIds = new Set(effortTaskIds());
    const aboutTasks = attention.items.filter((item) => item.entityType === 'task');
    expect(aboutTasks.filter((item) => effortIds.has(item.entityId))).toEqual([]);
    // Non-vacuity: the roster did write task rows.
    expect(aboutTasks.length).toBeGreaterThan(0);
  });

  test("an effort does not drag its reporter into a scoped manager's people panel", () => {
    // Driven as the project LEAD on purpose. `filterMembersForAccess` short-circuits for a
    // workspace-wide actor and returns every measured member, so as an OWNER `mapper` is in the
    // panel regardless and this assertion would be VACUOUS. Only for a scoped viewer is a person
    // admitted purely because they are `task.reporter` of an active task — which, before the fix,
    // is exactly what an effort does to whoever filed it.
    const people = surfaces.scopedWorkHealth.people.map((person) => person.user.id);

    expect(people).toContain(fixture.users.worker.id);
    expect(people).not.toContain(fixture.users.mapper.id);

    const flagged = surfaces.scopedWorkHealth.attention
      .filter((item) => item.reason === 'person_without_active_work')
      .map((item) => item.user?.id);
    expect(flagged).not.toContain(fixture.users.mapper.id);
    // Non-vacuity again: the scoped panel really is populated and really does flag idle people.
    expect(flagged.length).toBeGreaterThan(0);
  });

  test('the issue list is the work list', () => {
    expect(keysOf(surfaces.projectTasks.items).sort()).toEqual(
      [fixture.tasks.W1.key, fixture.tasks.W2.key, fixture.tasks.C1.key, fixture.tasks.W3.key].sort()
    );
    expect(surfaces.projectTasks.total).toBe(4);
  });

  test('the archive is finished work, not a finished map', () => {
    // A DONE effort is legal and carries a real completedAt, so this is a live leak rather than a
    // latent one. W3 is the control, closed on the same day as EFF3.
    expect(keysOf(surfaces.archive.items)).toEqual([fixture.tasks.W3.key]);
  });

  test('project counts and previews say how much WORK a project holds', () => {
    // Invisible to the runtime harness: a filtered relation count lives in `args.select`, and the
    // query is issued against `project`, not `task`. These numbers are the only proof those six
    // sites were fixed, which is why they are asserted three ways rather than dropped as "just
    // numbers".
    expect(countFor(surfaces.projects, fixture.projects.P.id)).toBe(4);
    expect(countFor(surfaces.projects, fixture.projects.E.id)).toBe(0);
    expect(countFor(surfaces.projects, fixture.projects.S.id)).toBe(1);

    expect(surfaces.projectDetail._count.tasks).toBe(4);
    expect(surfaces.effortOnlyProject._count.tasks).toBe(0);
    // The nested subproject count, a level deeper than the project's own and on another line.
    expect(surfaces.projectDetail.subprojects.map((item) => item._count.tasks)).toEqual([1]);

    // The relation LIST, which unlike the counts around it takes an ordinary `where`.
    expect(keysOf(surfaces.projectDetail.tasks).sort()).toEqual(
      [fixture.tasks.W1.key, fixture.tasks.W2.key, fixture.tasks.C1.key, fixture.tasks.W3.key].sort()
    );
  });

  test('nobody is credited with reporting an effort', () => {
    // `mapper` files three efforts and no work; `admin` files five pieces of work and one effort.
    // One number catches a missing filter and an inverted one at the same time: unguarded, admin
    // reads 6; filtered the wrong way round, admin reads 1.
    expect(reportedBy(surfaces.directory, fixture.users.mapper.id)).toBe(0);
    expect(reportedBy(surfaces.directory, fixture.users.admin.id)).toBe(5);
  });

  test('the offline bootstrap ships the same work list and the same numbers', () => {
    const { bootstrap } = surfaces;

    // W3 and EFF3 were both closed a month ago and fall outside the hot window, so this is the
    // four live rows.
    expect(keysOf(bootstrap.tasks).sort()).toEqual(
      [fixture.tasks.W1.key, fixture.tasks.W2.key, fixture.tasks.C1.key, fixture.tasks.SW.key].sort()
    );
    expect(bootstrap.totalHotTasks).toBe(4);
    expect(countFor(bootstrap.projects, fixture.projects.E.id)).toBe(0);
    expect(countFor(bootstrap.projects, fixture.projects.P.id)).toBe(4);
    expect(
      bootstrap.users.find((user) => user.id === fixture.users.mapper.id)?._count.reportedTasks
    ).toBe(0);
    expect(
      bootstrap.users.find((user) => user.id === fixture.users.admin.id)?._count.reportedTasks
    ).toBe(5);
  });

  test('the live stream applies the same rule the bootstrap did', () => {
    // The two halves of the sync scope are a query and an in-memory twin. If only the query moved,
    // the bootstrap would omit the effort and the very next edit to it would upsert it straight
    // back into every client cache — an exclusion that silently undoes itself is worse than none.
    // Called directly because there is no other way to reach the in-memory half.
    expect(mapTaskEvent('EFF1')).toBeNull();
    expect(mapTaskEvent('W1')).toMatchObject({ type: 'upsert' });
  });

  test('closing an effort is not something to report as a day_s work', async () => {
    // The one exclusion filtered in memory rather than at the query: ActivityLog has no `kind`
    // column, so `taskFromActivitySnapshot` reads it off the snapshot instead. That makes it the
    // easiest of these to delete by accident, and it was the single site no test covered.
    //
    // The WORK task is a positive control, and it is the whole point of this test: without it a
    // draft that returned no chips at all — a broken endpoint, a wrong dateKey, an activity query
    // that matched nothing — would satisfy the effort assertion and prove nothing.
    const closable = await seedClosablePair();

    for (const key of [closable.work.key, closable.effort.key]) {
      await as(fixture.adminToken, {
        method: 'PATCH',
        url: `/tasks/${key}`,
        payload: { status: 'DONE' }
      });
    }

    const draft = await as<{ completedCandidates: Array<{ key: string }> }>(fixture.adminToken, {
      method: 'GET',
      url: '/check-ins/draft'
    });
    const chips = draft.completedCandidates.map((candidate) => candidate.key);

    expect(chips).toContain(closable.work.key);
    expect(chips).not.toContain(closable.effort.key);

    await prisma.task.deleteMany({ where: { id: { in: [closable.work.id, closable.effort.id] } } });
  });

  test('an effort never turns up in a human_s inbox', () => {
    // The one leak here that is not a Task query at all, which is why no Task-level mechanism
    // reaches it and why it survived the first pass: the gate is a Notification where, and the
    // predicate has to ride in on the nested `task` relation filter.
    //
    // It is a LIVE leak, not a latent one. Nothing about an effort's shape keeps it out — its
    // reporter is subscribed at creation, everyone named in its body is subscribed permanently
    // (the API has no unsubscribe path), and its body is the document, so every revision fans out.
    // The WORK row is the positive control: an empty inbox would otherwise satisfy this.
    expect(surfaces.inbox.items.map((item) => item.taskId)).toEqual([fixture.tasks.W1.id]);
    expect(surfaces.inbox.total).toBe(1);

    // The two counters read through the same gate and are rendered in different places — the inbox
    // badge and the settings tile — so they can disagree with each other and with the list.
    expect(surfaces.inbox.unreadCount).toBe(1);
    expect(surfaces.me.unreadNotifications).toBe(1);
  });
});

describe('an effort is still reachable, because the effort IS the map', () => {
  test('it can be listed on purpose', () => {
    // THE ASSERTION THAT KEEPS "excluded" FROM MEANING "deleted". Without a way to list efforts,
    // the next refactor cannot tell the two apart and will pick whichever is easier.
    expect(keysOf(surfaces.effortTasks.items).sort()).toEqual(
      [fixture.tasks.EFF1.key, fixture.tasks.EFF3.key].sort()
    );
    expect(surfaces.effortTasks.items.every((item) => item.kind === 'EFFORT')).toBe(true);
  });

  test('its own row, its body and its children are all readable', () => {
    const detail = surfaces.effortDetail;

    expect(detail.kind).toBe('EFFORT');
    expect(detail.key).toBe(fixture.tasks.EFF1.key);
    // The prose IS the deliverable. A read path that returns the row but drops the body would be
    // the same regression wearing a smaller hat.
    expect(detail.description).toBe(effortDescription);
    // A WORK task may hang off an effort; only the EFFORT's own parentId is forbidden.
    expect(detail.subtasks.map((task) => task.id)).toContain(fixture.tasks.C1.id);
  });
});

/**
 * The runtime guard, over the same drive.
 *
 * The assertions above prove the surfaces they exercise. This one covers the rest: every multi-row
 * task query those surfaces issued is inspected AS AN OBJECT, and any that ran without the
 * predicate has to be one somebody reviewed and named. A new unguarded task list in a measurement
 * path fails here even if no number above happens to move.
 */
describe('every task list the surfaces ran is accounted for', () => {
  test('nothing listed tasks without the predicate except the reviewed reads', () => {
    expect(watch.unreviewed(reviewedTaskReads)).toEqual([]);
  });

  test('the measured surfaces really did compose the predicate', () => {
    // The complement of the assertion above, which would also pass if the surfaces had issued no
    // task queries at all — because a refactor moved them behind a cache, say.
    const composed = watch
      .observations()
      .filter((observation) => observation.verdict === 'composed')
      .map((observation) => observation.identity);

    expect(composed).toContain('services/work-health.ts#getWorkHealthSummary task.count');
    expect(composed).toContain('services/work-health.ts#getWorkHealthSummary task.findMany');
    expect(composed).toContain('services/work-health.ts#getWorkHealthSummary task.groupBy');
    expect(composed).toContain('routes/sync.ts#listTasksForScope task.findMany');
    expect(composed).toContain('routes/sync.ts#listTasksForScope task.count');
    // Unreachable today — an effort can hold no assignee — but named here so the clause cannot be
    // quietly dropped later on the grounds that it changes no row. It is the load slice behind
    // every assignment candidate's score.
    expect(composed).toContain('services/assignment.ts#recommendAssignment task.findMany');
    expect(composed).toContain('routes/agent.ts#anonymous task.findMany');
  });

  test('the deliberate effort read is recognised as one, not reported as a miss', () => {
    // `GET /tasks?kind=EFFORT` is the read path. A reader that called it `absent` would make the
    // reachability test above fail this guard forever, and the cheapest way out of that would be
    // deleting the reachability test.
    const scoped = watch
      .observations()
      .filter((observation) => observation.verdict === 'effort-scoped')
      .map((observation) => observation.identity);

    expect(scoped.length).toBeGreaterThan(0);
    expect(watch.unreviewed({})).not.toContain(scoped[0]);
  });

  test('no query slipped the predicate in under a negation', () => {
    expect(watch.observations().filter((observation) => observation.verdict === 'negated')).toEqual([]);
  });

  test('a reviewed exception cannot excuse an inverted predicate', async () => {
    // A reviewed exception is the claim "this query lists no work". An inverted predicate is the
    // opposite claim — a search for exactly the efforts — so writing one line in the map below must
    // not turn the guard off. Proven with a real query rather than by reading the code.
    const probe = watchTaskQueries();
    try {
      await prisma.task.findMany({
        where: { workspaceId: fixture.workspace.id, NOT: { ...workTaskWhere } },
        select: { id: true }
      });
    } finally {
      probe.stop();
    }

    const [observation] = probe.observations();
    expect(observation.verdict).toBe('negated');
    expect(probe.unreviewed({ [observation.identity]: 'Reviewed, and beside the point.' })).toEqual([
      `${observation.identity} — predicate negated — where ${JSON.stringify(observation.where)}`
    ]);
  });

  test('stopping the watch hands the singleton back exactly as it was', () => {
    // The watch replaces `prisma.$transaction` while it runs. Putting a BOUND COPY back afterwards
    // looks like a restore and is not one: the shared client would spend the rest of the process
    // holding a wrapper instead of the function Prisma installed, for every test file that follows.
    // Identity is the assertion, because identity is what was lost.
    const original = prisma.$transaction;

    const probe = watchTaskQueries();
    expect(prisma.$transaction).not.toBe(original);
    probe.stop();

    expect(prisma.$transaction).toBe(original);
  });
});

/**
 * Reviewed exceptions: multi-row task queries that legitimately see efforts too.
 *
 * EMPTY TODAY, and that is the assertion. Every task list these surfaces run either composes the
 * predicate or asks for efforts on purpose, so nothing needs excusing. Leaving speculative entries
 * here would be worse than useless: an entry that exempts nothing is a reason nobody re-read, and
 * it would silently start exempting a real query the moment one appeared at that call site.
 *
 * When an entry is needed, key it on `<file>#<enclosing function> <model>.<operation>`, read off
 * the call stack at query time. That identity survives edits above the query — unlike a line
 * number, which rots on every unrelated change until the guard gets deleted — and cannot be
 * produced by writing a comment, unlike a marker in the source. Renaming the function or moving the
 * query to another module does invalidate it, which is the point: both are edits worth a second
 * look. The value is the reason, and a `negated` verdict is never excusable by one — proven above
 * with a real query rather than by reading the code.
 */
const reviewedTaskReads: Record<string, string> = {};

describe('the predicate reader, which is what makes the runtime guard sound', () => {
  test('the predicate is one clause, and it is the positive one', () => {
    // Frozen on purpose. The tempting "simplification" is to write the complement instead —
    // `{ NOT: { kind: 'EFFORT' } }` — which reads the same and behaves the same today, and stops
    // behaving the same the moment a third TaskKind exists: a new kind would be silently admitted
    // to every work list and every count in the API.
    expect(workTaskWhere).toEqual({ kind: 'WORK' });
    expect(isWorkTask({ kind: 'WORK' })).toBe(true);
    expect(isWorkTask({ kind: 'EFFORT' })).toBe(false);
  });

  test('reads the predicate wherever it is conjunctively composed', () => {
    expect(readWorkPredicate({ workspaceId: 'ws-1', ...workTaskWhere })).toBe('composed');
    expect(readWorkPredicate({ AND: [{ workspaceId: 'ws-1' }, workTaskWhere] })).toBe('composed');
    expect(readWorkPredicate({ AND: [{ AND: [{ kind: { equals: 'WORK' } }] }] })).toBe('composed');
    // Over a two-value enum this really does constrain the rows to WORK, unlike `NOT: { kind }`.
    expect(readWorkPredicate({ kind: { not: 'EFFORT' } })).toBe('composed');
  });

  test('a predicate under NOT is the opposite of the predicate', () => {
    // The false-safe a text scan cannot see: this where-clause selects exactly the rows the
    // predicate exists to exclude.
    expect(readWorkPredicate({ workspaceId: 'ws-1', NOT: { ...workTaskWhere } })).toBe('negated');
    expect(readWorkPredicate({ parent: { isNot: { kind: 'WORK' } } })).toBe('negated');
  });

  test('asking for efforts on purpose is its own verdict', () => {
    // Not `absent`, or the read path could never pass the guard; not `composed`, or an effort list
    // could masquerade as a work list.
    expect(readWorkPredicate({ workspaceId: 'ws-1', kind: 'EFFORT' })).toBe('effort-scoped');
    expect(readWorkPredicate({ kind: { in: ['WORK', 'EFFORT'] } })).toBe('effort-scoped');
    expect(readWorkPredicate({ kind: { not: 'WORK' } })).toBe('effort-scoped');
  });

  test('a branch of an OR constrains nothing', () => {
    // The other branch is free to re-admit everything, so this is not a work list.
    expect(readWorkPredicate({ OR: [workTaskWhere, { status: 'DONE' }] })).toBe('absent');
    expect(readWorkPredicate({ workspaceId: 'ws-1' })).toBe('absent');
    expect(readWorkPredicate(undefined)).toBe('absent');
  });

  test('a kind clause about a RELATED row says nothing about this row', () => {
    // Found by planting it. `{ parent: { is: { kind: 'WORK' } } }` constrains the row's PARENT, and
    // a reader that descended into relation keys called that `composed` while the query returned
    // every effort in the workspace — a false-safe of exactly the kind this harness replaced a text
    // scan to avoid, reached from the other direction.
    expect(readWorkPredicate({ parent: { is: { kind: 'WORK' } } })).toBe('absent');
    expect(readWorkPredicate({ subtasks: { some: { kind: 'WORK' } } })).toBe('absent');
    expect(readWorkPredicate({ project: { tasks: { some: { kind: 'WORK' } } } })).toBe('absent');
    // Asking for efforts through a relation is not the read path either — the read path asks about
    // the rows it is selecting.
    expect(readWorkPredicate({ parent: { is: { kind: 'EFFORT' } } })).toBe('absent');
    // Inversion is still reported from anywhere, because `negated` can never be excused away.
    expect(readWorkPredicate({ parent: { isNot: { kind: 'WORK' } } })).toBe('negated');
    expect(readWorkPredicate({ NOT: { AND: [workTaskWhere] } })).toBe('negated');
  });
});

/**
 * ASSERTIONS DELIBERATELY NOT WRITTEN, and why. Each of these is closed by a CHECK constraint, so
 * the fixture cannot produce a subject for it and the assertion would pass against a completely
 * unguarded predicate. A test that cannot fail is worse than no test: it is a claim of coverage.
 *
 *   Today Load, activeWeight, loadRatio, overloadedPeople — `weight`, `dueAt` and `assigneeId` are
 *     all forbidden on an EFFORT, and the workload list is filtered by all three.
 *   The leaderboard, POST /assignment/recommend — `assigneeId: { not: null }` throughout.
 *   Every milestone rollup — keyed on `milestoneId`, which an EFFORT cannot hold.
 *   The overdue queue and the unassigned_due_soon card — `dueAt`-gated.
 *   The backlog queue, isBacklogTriageActionable, the backlog_triage attention row, all of
 *     triage.ts — every one requires `status: 'BACKLOG'`, which `Task_effort_status` forbids. The
 *     brief for this change named backlog triage as a live leak path; post-migration it is not one,
 *     and a fixture proving it cannot be created at all.
 *   `_count.subtasks` and `_count.assignedTasks` — an EFFORT can hold neither a parentId nor an
 *     assigneeId.
 *   The `_max: { sequence: true }` key allocators — those MUST stay unfiltered: they guard
 *     `@@unique([projectId, sequence])`, and filtering them would mint duplicate task keys. This is
 *     the one place where adding the predicate would itself be the bug.
 *
 * TWO HONEST GAPS, written down rather than left to be discovered:
 *   (a) The four ai-reports.ts sites are not driven here. Both `POST /reports/tasks/analyze` and
 *       the assistant 400 without a stored AI credential and then make a network call, so neither
 *       this test nor the runtime harness (which only sees queries that actually run) reaches them.
 *       They are covered by review and by the shared predicate being the only spelling in use.
 *   (b) The six filtered `_count` sites are invisible to the harness — the query goes to
 *       `project`/`user` and the filter lives in `args.select`. They are proven only by the three
 *       number assertions above, which is why those must not be deleted as redundant.
 */

const effortDescription = 'نقشهٔ کار عامل: مرحله‌به‌مرحله چه چیزی را دنبال می‌کند.';

async function seedWorkspace(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Measured Work ${suffix}`,
      slug: `measured-work-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true, slug: true }
  });

  const users = {
    admin: await createUser(`mw-admin-${suffix}`, 'Admin'),
    worker: await createUser(`mw-worker-${suffix}`, 'Worker'),
    // Files efforts and nothing else. That is what makes the reporter-pull observable: before the
    // fix a scoped viewer sees this person in the people panel purely because of an effort.
    mapper: await createUser(`mw-mapper-${suffix}`, 'Mapper'),
    lead: await createUser(`mw-lead-${suffix}`, 'Lead')
  };

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: users.admin.id, role: 'OWNER' as const },
      { workspaceId: workspace.id, userId: users.worker.id, role: 'MEMBER' as const },
      { workspaceId: workspace.id, userId: users.mapper.id, role: 'MEMBER' as const },
      // Non-admin on purpose: `resolveWorkspaceAccess` only returns a SCOPED access for someone who
      // is not a workspace admin, and the reporter-pull is invisible to a workspace-wide viewer.
      { workspaceId: workspace.id, userId: users.lead.id, role: 'MEMBER' as const }
    ]
  });

  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: `Team ${suffix}`, slug: `mw-team-${suffix}`.slice(0, 60) },
    select: { id: true }
  });

  const stamp = Math.floor(Math.random() * 9000 + 1000);
  const P = await createProject(workspace.id, team.id, `MWP${stamp}`, 'Work Project', { leadId: users.lead.id });
  const E = await createProject(workspace.id, team.id, `MWE${stamp}`, 'Effort Only', {});
  const S = await createProject(workspace.id, team.id, `MWS${stamp}`, 'Subproject', { parentId: P.id });

  const now = Date.now();
  const fresh = new Date(now - 60 * 1000);
  const staleAt = new Date(now - 5 * DAY);
  const longAgo = new Date(now - 30 * DAY);

  // Written through `prisma.task.create` rather than through the API: `createTaskSchema` has no
  // `kind` field, so the API cannot mint an effort at all yet. The row has to exist for the
  // property to be testable, and the write-side guard is a separate change.
  const EFF1 = await createTask({
    name: 'EFF1',
    workspaceId: workspace.id,
    project: P,
    sequence: 1,
    title: 'نقشهٔ عامل',
    kind: 'EFFORT',
    status: 'IN_PROGRESS',
    reporterId: users.mapper.id,
    description: effortDescription,
    // Older than the 72-hour staleness threshold, IN_PROGRESS, and unassigned by construction: this
    // is what makes it eligible for the stale queue, the unassigned queue, the status distribution
    // and a persisted stale_task attention row all at once.
    updatedAt: staleAt
  });
  const W1 = await createTask({
    name: 'W1',
    workspaceId: workspace.id,
    project: P,
    sequence: 2,
    title: 'کار جاری',
    status: 'IN_PROGRESS',
    assigneeId: users.worker.id,
    reporterId: users.admin.id,
    dueAt: new Date(now - DAY),
    weight: 3,
    updatedAt: fresh
  });
  const W2 = await createTask({
    name: 'W2',
    workspaceId: workspace.id,
    project: P,
    sequence: 3,
    title: 'کار بی‌صاحب',
    status: 'TODO',
    reporterId: users.admin.id,
    // The control. Real work in exactly the same buckets as EFF1, so every equality below fails if
    // the queue empties rather than merely losing the effort.
    updatedAt: staleAt
  });
  const C1 = await createTask({
    name: 'C1',
    workspaceId: workspace.id,
    project: P,
    sequence: 4,
    title: 'زیرکار نقشه',
    status: 'TODO',
    assigneeId: users.worker.id,
    reporterId: users.admin.id,
    // A WORK task hanging off an effort. Only the EFFORT's own parentId is forbidden.
    parentId: EFF1.id,
    updatedAt: fresh
  });
  const W3 = await createTask({
    name: 'W3',
    workspaceId: workspace.id,
    project: P,
    sequence: 5,
    title: 'کار تمام‌شده',
    status: 'DONE',
    assigneeId: users.worker.id,
    reporterId: users.admin.id,
    completedAt: longAgo,
    updatedAt: longAgo
  });
  const EFF3 = await createTask({
    name: 'EFF3',
    workspaceId: workspace.id,
    project: P,
    sequence: 6,
    title: 'نقشهٔ بسته‌شده',
    kind: 'EFFORT',
    status: 'DONE',
    reporterId: users.mapper.id,
    // `completedAt` is writable on an effort, so the archive is a live leak, not a latent one.
    completedAt: longAgo,
    updatedAt: longAgo
  });
  const EFF2 = await createTask({
    name: 'EFF2',
    workspaceId: workspace.id,
    project: E,
    sequence: 1,
    title: 'نقشهٔ تنها',
    kind: 'EFFORT',
    status: 'IN_PROGRESS',
    reporterId: users.admin.id,
    updatedAt: fresh
  });
  const SW = await createTask({
    name: 'SW',
    workspaceId: workspace.id,
    project: S,
    sequence: 1,
    title: 'کار زیرپروژه',
    status: 'TODO',
    assigneeId: users.worker.id,
    reporterId: users.admin.id,
    updatedAt: fresh
  });
  const SE = await createTask({
    name: 'SE',
    workspaceId: workspace.id,
    project: S,
    sequence: 2,
    title: 'نقشهٔ زیرپروژه',
    kind: 'EFFORT',
    status: 'IN_PROGRESS',
    reporterId: users.mapper.id,
    updatedAt: fresh
  });

  // Inbox rows of each kind, for the admin. Written straight to the table because the fan-out that
  // produces them is a write path and the leak is on the read: `subscribeTaskParticipants` puts the
  // reporter and everyone named in a body on a task permanently, and an effort's body is the living
  // document, so every revision of a map produces one of these for every subscriber.
  await prisma.notification.createMany({
    data: [
      {
        workspaceId: workspace.id,
        userId: users.admin.id,
        taskId: EFF1.id,
        type: 'task_description_changed',
        title: `${EFF1.key}: نقشه`,
        body: 'متن نقشه تغییر کرد'
      },
      {
        workspaceId: workspace.id,
        userId: users.admin.id,
        taskId: W1.id,
        type: 'task_description_changed',
        title: `${W1.key}: کار`,
        body: 'شرح کار تغییر کرد'
      }
    ]
  });

  const [adminSession, leadSession] = await Promise.all([
    createUserSession(users.admin.id),
    createUserSession(users.lead.id)
  ]);

  return {
    workspace,
    projects: { P, E, S },
    users,
    tasks: { W1, W2, C1, W3, SW, EFF1, EFF2, EFF3, SE },
    adminToken: adminSession.token,
    leadToken: leadSession.token
  };
}

async function driveSurfaces(): Promise<Surfaces> {
  const [workHealth, scopedWorkHealth, projectTasks, effortTasks, effortDetail, archive] = await Promise.all([
    as<WorkHealthBody>(fixture.adminToken, { method: 'GET', url: '/work-health/summary' }),
    as<WorkHealthBody>(fixture.leadToken, { method: 'GET', url: '/work-health/summary' }),
    as<TaskListBody>(fixture.adminToken, { method: 'GET', url: `/tasks?projectId=${fixture.projects.P.id}&limit=100` }),
    as<TaskListBody>(fixture.adminToken, {
      method: 'GET',
      url: `/tasks?projectId=${fixture.projects.P.id}&kind=EFFORT&limit=100`
    }),
    as<TaskDetailBody>(fixture.adminToken, { method: 'GET', url: `/tasks/${fixture.tasks.EFF1.key}` }),
    as<TaskListBody>(fixture.adminToken, { method: 'GET', url: '/tasks/archive?limit=100' })
  ]);

  const [projects, projectDetail, effortOnlyProject, directory, bootstrap] = await Promise.all([
    as<ProjectCount[]>(fixture.adminToken, { method: 'GET', url: '/projects' }),
    as<ProjectDetailBody>(fixture.adminToken, { method: 'GET', url: `/projects/${fixture.projects.P.id}` }),
    as<ProjectDetailBody>(fixture.adminToken, { method: 'GET', url: `/projects/${fixture.projects.E.id}` }),
    as<DirectoryBody>(fixture.adminToken, { method: 'GET', url: '/users' }),
    as<BootstrapBody>(fixture.adminToken, { method: 'GET', url: '/sync/bootstrap' })
  ]);

  // Generates and then lists: the attention roster is the one surface here that WRITES its verdict
  // down, so reading the rows back is the only way to see what it judged. Run last and alone
  // because it regenerates from the same work-health summary the first call produced.
  const attention = await as<AttentionBody>(fixture.adminToken, {
    method: 'GET',
    url: '/attention?status=ALL&limit=100'
  });

  const [inbox, me] = await Promise.all([
    as<InboxBody>(fixture.adminToken, { method: 'GET', url: '/notifications?limit=100' }),
    as<MeBody>(fixture.adminToken, { method: 'GET', url: '/me' })
  ]);

  // Not asserted on — it recommends people, not tasks. Driven so the harness sees the task slice
  // behind every candidate's load, which is a measurement whether or not a number here moves.
  await as(fixture.adminToken, {
    method: 'POST',
    url: '/assignment/recommend',
    payload: { projectId: fixture.projects.P.id, weight: 2 }
  });

  // Same reason: the agent daily plan runs its own task list, and a surface no test drives is a
  // surface the harness cannot see.
  await as(fixture.adminToken, { method: 'POST', url: '/agent/daily-plan' });

  return {
    workHealth,
    scopedWorkHealth,
    attention,
    inbox,
    me,
    projectTasks,
    effortTasks,
    effortDetail,
    archive,
    projects,
    projectDetail,
    effortOnlyProject,
    directory,
    bootstrap
  };
}

/** The in-memory half of the sync scope, called directly because no route exposes it. */
function mapTaskEvent(name: TaskName) {
  const row = seededRows.get(name);
  if (!row) throw new Error(`No seeded row for ${name}`);
  const event = {
    id: 'sync-event-probe',
    workspaceId: fixture.workspace.id,
    workspaceSeq: BigInt(1),
    entityType: 'task',
    entityId: row.id,
    operation: 'updated',
    entityVersion: 1,
    actorId: fixture.users.admin.id,
    clientId: null,
    mutationId: null,
    payload: { after: serializeTaskForResponse(row as unknown as Record<string, unknown>) },
    createdAt: new Date()
  } as unknown as SyncEvent;

  return mapSyncEventForScope(
    event,
    { scope: 'tasks', teamId: 'all', cursor: '0', limit: 200, completedWindowDays: 5 } as Parameters<
      typeof mapSyncEventForScope
    >[1],
    { user: { id: fixture.users.admin.id } } as Parameters<typeof mapSyncEventForScope>[2],
    null
  );
}

const seededRows = new Map<TaskName, Record<string, unknown>>();

/**
 * One WORK task and one EFFORT, both IN_PROGRESS and both closable, created outside the main
 * fixture so that driving them to DONE cannot disturb the snapshot every other test reads.
 *
 * Sequences start high for the same reason: the fixture owns the low ones in this project, and
 * `@@unique([projectId, sequence])` would reject a collision.
 */
async function seedClosablePair(): Promise<{
  work: { id: string; key: string };
  effort: { id: string; key: string };
}> {
  const project = fixture.projects.P;
  const make = async (sequence: number, kind: 'WORK' | 'EFFORT', title: string) =>
    prisma.task.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        sequence,
        key: `${project.keyPrefix}-${sequence}`,
        title,
        kind,
        status: 'IN_PROGRESS',
        reporterId: fixture.users.admin.id,
        // Only the WORK row may carry an assignee — CHECK Task_effort_has_no_work_fields.
        assigneeId: kind === 'WORK' ? fixture.users.admin.id : null
      },
      select: { id: true, key: true }
    });

  return {
    work: await make(900, 'WORK', 'کار قابل بستن'),
    effort: await make(901, 'EFFORT', 'تلاش قابل بستن')
  };
}

async function createTask(input: {
  name: TaskName;
  workspaceId: string;
  project: SeededProject;
  sequence: number;
  title: string;
  kind?: 'WORK' | 'EFFORT';
  status: 'TODO' | 'IN_PROGRESS' | 'DONE';
  assigneeId?: string;
  reporterId: string;
  parentId?: string;
  description?: string;
  dueAt?: Date;
  weight?: number;
  completedAt?: Date;
  updatedAt: Date;
}) {
  const row = await prisma.task.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.project.id,
      sequence: input.sequence,
      key: `${input.project.keyPrefix}-${input.sequence}`,
      title: input.title,
      description: input.description,
      kind: input.kind ?? 'WORK',
      status: input.status,
      priority: 'MEDIUM',
      assigneeId: input.assigneeId,
      reporterId: input.reporterId,
      parentId: input.parentId,
      dueAt: input.dueAt,
      weight: input.weight,
      completedAt: input.completedAt,
      updatedAt: input.updatedAt
    }
  });
  // Kept whole so the live-stream probe can hand a real serialized row to `mapSyncEventForScope`
  // instead of a hand-written payload that could quietly disagree with what the API emits.
  seededRows.set(input.name, row as unknown as Record<string, unknown>);
  return row;
}

async function createProject(
  workspaceId: string,
  teamId: string,
  keyPrefix: string,
  name: string,
  extra: { leadId?: string; parentId?: string }
): Promise<SeededProject> {
  return prisma.project.create({
    data: { workspaceId, teamId, keyPrefix, name, ...extra },
    select: { id: true, keyPrefix: true }
  });
}

async function createUser(key: string, name: string) {
  return prisma.user.create({
    data: { email: `${key}@measured-work.test`.toLowerCase(), name },
    select: { id: true, name: true }
  });
}

async function as<T>(token: string, options: InjectOptions): Promise<T> {
  const response = await app.inject({
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-slug': fixture.workspace.slug,
      ...(options.headers || {})
    }
  });
  if (response.statusCode >= 400) {
    throw new Error(`${options.method} ${options.url} → ${response.statusCode} ${response.body}`);
  }
  return response.json() as T;
}

function keysOf(rows: Array<{ key: string }>): string[] {
  return rows.map((row) => row.key);
}

function countFor(projects: ProjectCount[], id: string): number | undefined {
  return projects.find((project) => project.id === id)?._count.tasks;
}

function reportedBy(directory: DirectoryBody, userId: string): number | undefined {
  return directory.items.find((user) => user.id === userId)?._count.reportedTasks;
}

function effortTaskIds(): string[] {
  return [fixture.tasks.EFF1.id, fixture.tasks.EFF2.id, fixture.tasks.EFF3.id, fixture.tasks.SE.id];
}
