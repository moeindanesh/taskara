import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type UserKind, type WorkspaceRole } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { createUserSession } from './auth';
import { measuredMemberWhere } from './measured-people';
import { readPredicate, watchPeopleQueries, type PeopleQueryWatch } from './measured-people-harness';
import { DAILY_REPORT_REMINDER_NOTIFICATION_TYPE } from './notifications';
import { sendDailyReportReminders } from './scheduled-jobs';
import { isWorkdayKey, shiftDateKey, workspaceDateKey } from './workspace-time';

/**
 * The property from issue #20, asserted end to end against the real measurement code.
 *
 * This test never reads a source file. It seeds a workspace with people of every kind, drives the
 * actual endpoints, and looks at the numbers that come back — so how a query is spelled, which
 * client it is issued through, and what its comments claim are all irrelevant to whether it passes.
 * That is the whole reason it exists: the predicate used to be guarded by scanning source text, and
 * every widening of that scan produced a new way to evade it.
 *
 * The seeded population is the point. `agentAsMember` is an agent User holding an ORDINARY
 * WorkspaceRole.MEMBER — the case a role-only check misses, and the reason `UserKind` exists at all.
 * Every exclusion asserted below has to hold for it, not just for the agent that happens to wear
 * WorkspaceRole.AGENT. The GUEST human is the mirror case: a real person nobody scores, who must
 * stay visible while entering no rate.
 */

let app: FastifyInstance;
let fixture: Fixture;
let watch: PeopleQueryWatch;
let surfaces: Surfaces;

type Persona = 'owner' | 'member' | 'guest' | 'agentAsAgent' | 'agentAsMember';

interface Fixture {
  workspace: { id: string; slug: string };
  project: { id: string; keyPrefix: string };
  users: Record<Persona, { id: string; name: string }>;
  ownerToken: string;
  workday: string;
  /**
   * A second workday nobody filed on, used to drive the evening nudge.
   *
   * The nudge subtracts everyone who already filed for the day it is given. Driving it on `workday`
   * therefore removes both agents by way of their own check-in rows, and the exclusion assertions
   * pass no matter how wide the roster is — the test cannot fail. On a day nobody filed, every
   * measured member is pending, so a leaked agent is nudged and the assertion becomes load-bearing.
   */
  quietDay: string;
}

interface DigestBody {
  reports: Array<{ userId: string }>;
  blockersFirst: Array<{ userId: string }>;
  unplanned: Array<{ userId: string }>;
  missing: Array<{ id: string }>;
  stats: {
    expected: number;
    submitted: number;
    missing: number;
    participationRate: number;
    blockerCount: number;
    unplannedShare: number;
  };
}

interface TrendsBody {
  workdays: number;
  byDay: Array<{ dateKey: string; workday: boolean; submitted: number; counted: number; expected: number }>;
  byPerson: Array<{ user: { id: string }; submitted: number; possible: number }>;
  totals: { submitted: number; possible: number };
}

interface WorkHealthBody {
  overview: { overloadedPeople: number; peopleWithoutActiveWork: number };
  people: Array<{ user: { id: string }; activeWeight: number; status: string }>;
  attention: Array<{ reason: string; entityType: string; user?: { id: string }; task?: { assignee?: { id: string } | null } }>;
  queues: { overdue: Array<{ assignee?: { id: string } | null }> };
}

interface LeaderboardBody {
  items: Array<{ userId: string; assignedCount: number; doneCount: number }>;
  total: number;
}

interface AssignmentBody {
  recommendations: Array<{ user: { id: string } }>;
  excluded: { inactive: number; unsupportedRole: number; outsideProjectMembership: number };
}

interface DirectoryBody {
  items: Array<{ id: string; kind: UserKind }>;
  total: number;
}

interface TaskListBody {
  items: Array<{ id: string; assignee: { id: string; kind: UserKind } | null }>;
}

/** Persisted AttentionItem rows, read back through the list endpoint that serialises them. */
interface AttentionBody {
  items: Array<{
    id: string;
    entityType: string;
    entityId: string;
    reason: string;
    assigneeId: string | null;
  }>;
  total: number;
}

/** What the cross-workspace evening nudge actually wrote, narrowed to this fixture's workspace. */
interface ReminderOutcome {
  nudged: string[];
  stats: Record<string, number>;
}

interface Surfaces {
  digest: DigestBody;
  trends: TrendsBody;
  workHealth: WorkHealthBody;
  leaderboard: LeaderboardBody;
  assignment: AssignmentBody;
  directory: DirectoryBody;
  tasks: TaskListBody;
  attention: AttentionBody;
  reminders: ReminderOutcome;
}

/**
 * Notification rows the nudge wrote OUTSIDE the fixture workspace, collected during the drive.
 *
 * `sendDailyReportReminders` is cross-workspace on purpose, so driving it touches every workspace in
 * the database. Only rows created by this drive land here, matched by id against a snapshot taken
 * immediately before the call, so nothing that already existed is ever removed.
 */
const strayReminderIds: string[] = [];

beforeAll(async () => {
  app = Fastify({ logger: false });
  await registerApp(app);
  await app.ready();
  fixture = await seedWorkspace();
  // Started around the drive, not around the assertions: the harness reports what the measurement
  // surfaces actually asked the database for.
  watch = watchPeopleQueries();
  try {
    surfaces = await driveMeasurementSurfaces();
  } finally {
    watch.stop();
  }
});

afterAll(async () => {
  watch?.stop();
  await app?.close();
  if (strayReminderIds.length) {
    await prisma.notification.deleteMany({ where: { id: { in: strayReminderIds } } });
  }
  if (fixture) {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(fixture.users).map((user) => user.id) } } });
  }
});

describe('agents are teammates, and no metric counts them', () => {
  test('the daily-report digest asks nobody but the humans it scores', () => {
    const { digest } = surfaces;

    // owner + member. The guest is not asked, and neither agent is — including the one wearing an
    // ordinary MEMBER role, which is what a role-only check would have counted.
    expect(digest.stats.expected).toBe(2);
    expect(digest.stats.submitted).toBe(1);
    expect(digest.stats.submitted).toBeLessThanOrEqual(digest.stats.expected);
    expect(digest.stats.participationRate).toBe(50);
    expect(digest.stats.missing).toBe(1);
    expect(digest.missing.map((user) => user.id)).toEqual([fixture.users.owner.id]);

    // Both agents and the guest filed a report carrying a blocker and unexpected work. Only the
    // member's blocker is counted, and the share divides two counted quantities.
    expect(digest.stats.blockerCount).toBe(1);
    expect(digest.stats.unplannedShare).toBe(0);
  });

  test('the digest still shows every report that was filed', () => {
    const { digest } = surfaces;

    // VISIBILITY is the other half of the property: a manager cannot act on a blocker they cannot
    // see, and an agent's report is a real event.
    expect(digest.reports.map((report) => report.userId).sort()).toEqual(
      [
        fixture.users.member.id,
        fixture.users.guest.id,
        fixture.users.agentAsAgent.id,
        fixture.users.agentAsMember.id
      ].sort()
    );
    expect(digest.blockersFirst.map((item) => item.userId)).toContain(fixture.users.agentAsMember.id);
    expect(digest.unplanned.map((item) => item.userId)).toContain(fixture.users.guest.id);
  });

  test('trends count one human and display everyone', () => {
    const { trends } = surfaces;
    const day = trends.byDay.find((entry) => entry.dateKey === fixture.workday);

    expect(day?.workday).toBe(true);
    // Four reports were filed that day and one of them has a slot in the denominator.
    expect(day?.submitted).toBe(4);
    expect(day?.counted).toBe(1);
    expect(day?.expected).toBe(2);

    expect(trends.totals.submitted).toBe(1);
    expect(trends.totals.possible).toBe(2 * trends.workdays);
    expect(trends.totals.submitted).toBeLessThanOrEqual(trends.totals.possible);
    for (const entry of trends.byDay) expect(entry.counted).toBeLessThanOrEqual(entry.expected);

    // byPerson is the roster the rates are drawn over, so it is exactly the measured population.
    expect(trends.byPerson.map((entry) => entry.user.id).sort()).toEqual(
      [fixture.users.owner.id, fixture.users.member.id].sort()
    );
  });

  test('work health measures the humans and still surfaces agent work', () => {
    const { workHealth } = surfaces;

    expect(workHealth.people.map((person) => person.user.id).sort()).toEqual(
      [fixture.users.owner.id, fixture.users.member.id].sort()
    );
    // Both agents carry more weight than any capacity allows. Counting either would report an
    // overloaded person nobody can help.
    expect(workHealth.overview.overloadedPeople).toBe(0);
    // Only the owner has no active work; the agents' idleness is not a management problem.
    expect(workHealth.overview.peopleWithoutActiveWork).toBe(1);

    // Stated as an equality, not as three absences: over a one-entry list `not.toContain` also
    // passes when the list is empty, so it would keep passing if people stopped being flagged at
    // all. The owner is idle and measured, so the owner is the whole list.
    const flagged = workHealth.attention
      .filter((item) => item.entityType === 'user')
      .map((item) => item.user?.id);
    expect(flagged).toEqual([fixture.users.owner.id]);

    // …and the work itself is not hidden. An agent's overdue task is still an overdue task.
    const overdueAssignees = workHealth.queues.overdue.map((task) => task.assignee?.id);
    expect(overdueAssignees).toContain(fixture.users.agentAsMember.id);
  });

  test('the attention roster writes rows about humans and about everyone_s work', () => {
    const { attention } = surfaces;
    const aboutPeople = attention.items.filter((item) => item.entityType === 'user');

    // The persisted half of the property. Every other surface here returns a number a manager reads
    // once; these are ROWS that outlive the request, get assigned, snoozed and nudged about. An
    // agent that reaches this list becomes a standing task for a human.
    expect([...new Set(aboutPeople.map((item) => item.entityId))]).toEqual([fixture.users.owner.id]);
    expect(aboutPeople.map((item) => item.reason).sort()).toEqual(
      ['missing_check_in', 'person_without_active_work'].sort()
    );

    // Both agents and the guest are silent on the missing-check-in roster despite never having
    // filed a report in this workspace on the day the roster looks at.
    const chased = attention.items
      .filter((item) => item.reason === 'missing_check_in')
      .map((item) => item.entityId);
    expect(chased).toEqual([fixture.users.owner.id]);

    // …and their WORK is still on the list. Nothing here hides an agent's overdue task.
    const taskItemAssignees = attention.items
      .filter((item) => item.entityType === 'task')
      .map((item) => item.assigneeId);
    expect(taskItemAssignees).toContain(fixture.users.agentAsMember.id);
    expect(taskItemAssignees).toContain(fixture.users.agentAsAgent.id);
  });

  test('the evening nudge reaches one human and no agent_s inbox', () => {
    const { reminders } = surfaces;

    // Driven on `quietDay`, which nobody filed for, so every measured member of this workspace is
    // pending and the roster is the only thing deciding who gets chased. Both humans are nudged;
    // the guest was never asked for a report, and neither agent is a person to chase.
    //
    // Driving `workday` instead is what makes this test vacuous: the agents' own check-in rows
    // would subtract them before the roster mattered, and it passed with `where: {}`.
    expect(reminders.nudged.sort()).toEqual([fixture.users.owner.id, fixture.users.member.id].sort());
    expect(reminders.nudged).not.toContain(fixture.users.guest.id);
    expect(reminders.nudged).not.toContain(fixture.users.agentAsAgent.id);
    expect(reminders.nudged).not.toContain(fixture.users.agentAsMember.id);
    expect(reminders.stats.reminded).toBeGreaterThanOrEqual(2);
  });

  test('the leaderboard ranks only the people it is fair to rank', () => {
    const { leaderboard } = surfaces;

    expect(leaderboard.items.map((item) => item.userId).sort()).toEqual(
      [fixture.users.owner.id, fixture.users.member.id].sort()
    );
    // The agents each closed three tasks — more than any human here — and neither appears.
    const member = leaderboard.items.find((item) => item.userId === fixture.users.member.id);
    expect(member?.doneCount).toBe(1);
    expect(member?.assignedCount).toBe(2);
  });

  test('assignment never recommends an agent, and says why it did not', () => {
    const { assignment } = surfaces;

    expect(assignment.recommendations.map((item) => item.user.id).sort()).toEqual(
      [fixture.users.owner.id, fixture.users.member.id].sort()
    );
    // Two agents and one guest, excluded in memory so the reason survives to the user.
    expect(assignment.excluded.unsupportedRole).toBe(3);
  });

  test('an agent holding an ordinary MEMBER role is excluded exactly like the rest', () => {
    // Stated on its own because this is the case the whole `UserKind` column exists for. Every
    // exclusion above would still pass with a role-only check if this user were not seeded.
    const agent = fixture.users.agentAsMember.id;

    expect(surfaces.digest.missing.map((user) => user.id)).not.toContain(agent);
    expect(surfaces.trends.byPerson.map((entry) => entry.user.id)).not.toContain(agent);
    expect(surfaces.workHealth.people.map((person) => person.user.id)).not.toContain(agent);
    expect(surfaces.leaderboard.items.map((item) => item.userId)).not.toContain(agent);
    expect(surfaces.assignment.recommendations.map((item) => item.user.id)).not.toContain(agent);
  });

  test('agents were not deleted from the product', () => {
    const directory = surfaces.directory.items.map((user) => user.id);
    expect(directory).toContain(fixture.users.agentAsAgent.id);
    expect(directory).toContain(fixture.users.agentAsMember.id);
    expect(directory).toContain(fixture.users.guest.id);
    expect(surfaces.directory.total).toBe(5);
    // `kind` travels with the person, so a client can tell a teammate from a process.
    const agent = surfaces.directory.items.find((user) => user.id === fixture.users.agentAsMember.id);
    expect(agent?.kind).toBe('AGENT');

    const assignees = surfaces.tasks.items.map((task) => task.assignee?.id);
    expect(assignees).toContain(fixture.users.agentAsAgent.id);
    expect(assignees).toContain(fixture.users.agentAsMember.id);
    expect(assignees).toContain(fixture.users.guest.id);
  });

  // Pinned by a test rather than by memory: the counted-vs-displayed split treats a GUEST human
  // exactly like an agent on the measurement side, and exactly like a member on the display side.
  test('the guest human is displayed everywhere and counted nowhere', () => {
    const guest = fixture.users.guest.id;

    expect(surfaces.digest.reports.map((report) => report.userId)).toContain(guest);
    expect(surfaces.digest.blockersFirst.map((item) => item.userId)).toContain(guest);
    expect(surfaces.digest.missing.map((user) => user.id)).not.toContain(guest);
    expect(surfaces.trends.byPerson.map((entry) => entry.user.id)).not.toContain(guest);
    expect(surfaces.workHealth.people.map((person) => person.user.id)).not.toContain(guest);
    expect(surfaces.leaderboard.items.map((item) => item.userId)).not.toContain(guest);
    expect(surfaces.assignment.recommendations.map((item) => item.user.id)).not.toContain(guest);
  });
});

/**
 * The runtime guard, over the same drive.
 *
 * The behavioural assertions above prove the surfaces they exercise. This one covers the rest: every
 * people query those surfaces issued is inspected as an object, and any that ran without the
 * predicate has to be a query someone reviewed and named. A new unmeasured query in a measurement
 * path fails here even if no number above happens to move.
 */
describe('every people query the measurement surfaces ran is accounted for', () => {
  test('nothing queried people without the predicate except the reviewed visibility reads', () => {
    expect(watch.unreviewed(reviewedVisibilityQueries)).toEqual([]);
  });

  test('the measured surfaces really did compose the predicate', () => {
    // The complement of the assertion above: it would also pass if the surfaces had issued no
    // people queries at all, e.g. because a refactor moved them behind a cache.
    const composed = watch
      .observations()
      .filter((observation) => observation.verdict === 'composed')
      .map((observation) => observation.identity);

    expect(composed).toContain('services/check-ins.ts#collectMissingForDay workspaceMember.findMany');
    expect(composed).toContain('services/check-ins.ts#buildDailyReportTrends workspaceMember.findMany');
    expect(composed).toContain('services/work-health.ts#getWorkHealthSummary workspaceMember.findMany');
    expect(composed).toContain('routes/tasks.ts#anonymous workspaceMember.findMany');
    expect(composed).toContain('routes/tasks.ts#anonymous task.groupBy');
    // The two rosters that act on people rather than report on them.
    expect(composed).toContain('services/attention.ts#buildMissingCheckInAttentionCandidates workspaceMember.findMany');
    expect(composed).toContain('services/scheduled-jobs.ts#sendDailyReportReminders workspaceMember.findMany');
  });

  test('no query slipped the predicate in under a negation', () => {
    // `NOT: { ...measuredMemberWhere }` selects exactly the guests and agents. The old text scan
    // classified it as safe, because it searched the argument text for the identifier.
    expect(watch.observations().filter((observation) => observation.verdict === 'negated')).toEqual([]);
  });

  test('a reviewed exception cannot excuse an inverted predicate', async () => {
    // A reviewed exception is the claim "this query measures nobody". An inverted predicate is the
    // opposite claim — a search for exactly the excluded people — so writing one line in the map
    // below must not turn the guard off. Proven with a real query rather than by reading the code.
    const probe = watchPeopleQueries();
    try {
      await prisma.workspaceMember.findMany({
        where: { workspaceId: fixture.workspace.id, NOT: { ...measuredMemberWhere } },
        select: { userId: true }
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

    const probe = watchPeopleQueries();
    expect(prisma.$transaction).not.toBe(original);
    probe.stop();

    expect(prisma.$transaction).toBe(original);
  });
});

/**
 * Reviewed exceptions: people queries that legitimately see everyone.
 *
 * Keyed on `<file>#<enclosing function> <model>.<operation>`, read off the call stack at query time.
 * That identity survives edits above the query (unlike a line number, which rots on every unrelated
 * change until the guard gets deleted) and cannot be produced by writing a comment (unlike the
 * marker the static scan looks for). Renaming the function or moving the query to another module
 * does invalidate it — both are edits worth a second look.
 */
const reviewedVisibilityQueries: Record<string, string> = {
  'routes/users.ts#anonymous workspaceMember.findMany':
    'Member directory. Agents are teammates and belong in it.',
  'routes/users.ts#anonymous workspaceMember.count':
    "That directory's total, over the same where.",
  'services/check-ins.ts#buildDailyReportDigest checkInResponse.findMany':
    'Every report filed, for a manager to read, plus yesterday\'s plans as a per-author lookup. Narrowed to the measured roster in memory before anything is counted.',
  'services/check-ins.ts#collectMissingForDay checkInResponse.findMany':
    'Who already filed, subtracted from an already-measured roster; a stray row can only remove someone from the missing list.',
  'services/check-ins.ts#buildDailyReportTrends checkInResponse.findMany':
    'Every report in the window, for the per-day display counts. Intersected with the measured roster before any of it becomes a rate.',
  'services/work-health.ts#getWorkHealthSummary task.groupBy':
    "Active work counted by status. Grouped on the task's own column, not on an assignee.",
  'services/assignment.ts#listWorkspaceCandidateMembers workspaceMember.findMany':
    'Candidates are materialised in full and excluded in memory, so the per-reason counters shown to the user survive.',
  'services/attention.ts#buildMissingCheckInAttentionCandidates checkInResponse.findMany':
    'Latest report per author, subtracted from an already-measured roster; a stray row can only stop someone being chased.',
  'services/scheduled-jobs.ts#sendDailyReportReminders checkInResponse.findMany':
    'Who already filed today, subtracted from an already-measured roster; a stray row can only remove a nudge.'
};

describe('the predicate reader, which is what makes the runtime guard sound', () => {
  const member = { role: { not: 'GUEST' }, user: { kind: 'HUMAN' } };
  const subject = { kind: 'HUMAN', workspaces: { some: { workspaceId: 'ws-1', role: { not: 'GUEST' } } } };

  test('reads the predicate wherever it is conjunctively composed', () => {
    expect(readPredicate({ workspaceId: 'ws-1', ...member })).toBe('composed');
    expect(readPredicate({ AND: [{ workspaceId: 'ws-1' }, member] })).toBe('composed');
    // The leaderboard's shape: the subject form reached through a to-one relation filter.
    expect(readPredicate({ assignee: { is: subject } })).toBe('composed');
    expect(readPredicate({ user: { is: { kind: 'HUMAN' } }, role: { not: 'GUEST' } })).toBe('composed');
  });

  test('a predicate under NOT is the opposite of the predicate', () => {
    // The false-safe this replaces, stated as an example: this where-clause selects exactly the
    // people the predicate exists to exclude, and the text scan called it verified.
    expect(readPredicate({ workspaceId: 'ws-1', NOT: member })).toBe('negated');
    expect(readPredicate({ assignee: { isNot: subject } })).toBe('negated');
    // Half-negated is not the predicate either: this keeps the guests out and lets every agent in.
    expect(readPredicate({ user: { isNot: { kind: 'HUMAN' } }, role: { not: 'GUEST' } })).toBe('absent');
  });

  test('half the predicate is not the predicate', () => {
    expect(readPredicate({ role: { not: 'GUEST' } })).toBe('absent');
    expect(readPredicate({ user: { kind: 'HUMAN' } })).toBe('absent');
    expect(readPredicate({ role: { notIn: ['AGENT', 'GUEST'] } })).toBe('absent');
    expect(readPredicate(undefined)).toBe('absent');
  });

  test('a branch of an OR constrains nothing', () => {
    // The other branch is free to re-admit everyone, so this is not a measured query.
    expect(readPredicate({ OR: [member, { role: 'GUEST' }] })).toBe('absent');
  });
});

async function seedWorkspace(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Measured People ${suffix}`,
      slug: `measured-people-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true, slug: true }
  });

  const users = {
    owner: await createUser(`mp-owner-${suffix}`, 'Owner'),
    member: await createUser(`mp-member-${suffix}`, 'Member'),
    guest: await createUser(`mp-guest-${suffix}`, 'Guest'),
    agentAsAgent: await createUser(`mp-agent-role-${suffix}`, 'Agent With Agent Role', 'AGENT'),
    agentAsMember: await createUser(`mp-agent-member-${suffix}`, 'Agent With Member Role', 'AGENT')
  };

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: users.owner.id, role: 'OWNER' as WorkspaceRole },
      { workspaceId: workspace.id, userId: users.member.id, role: 'MEMBER' as WorkspaceRole },
      { workspaceId: workspace.id, userId: users.guest.id, role: 'GUEST' as WorkspaceRole },
      { workspaceId: workspace.id, userId: users.agentAsAgent.id, role: 'AGENT' as WorkspaceRole },
      // The load-bearing row. WorkspaceRole.AGENT is a permission, not a species: an agent can hold
      // MEMBER or ADMIN, and this one does.
      { workspaceId: workspace.id, userId: users.agentAsMember.id, role: 'MEMBER' as WorkspaceRole }
    ]
  });

  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Measured People Project ${suffix}`,
      keyPrefix: `MP${Math.floor(Math.random() * 9000 + 1000)}`
    },
    select: { id: true, keyPrefix: true }
  });

  // Real, measurable history for everyone but the owner: weighted work, some closed today, some
  // open and already overdue. The agents carry the heaviest load in the workspace on purpose — if
  // any of it leaked into a metric, it would dominate the humans rather than nudge them.
  const now = Date.now();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const tasks: Array<{ assigneeId: string; weight: number; done: boolean }> = [
    { assigneeId: users.member.id, weight: 3, done: false },
    { assigneeId: users.member.id, weight: 2, done: true },
    { assigneeId: users.guest.id, weight: 3, done: false },
    { assigneeId: users.guest.id, weight: 2, done: true },
    ...[users.agentAsAgent.id, users.agentAsMember.id].flatMap((assigneeId) => [
      { assigneeId, weight: 9, done: false },
      { assigneeId, weight: 9, done: false },
      { assigneeId, weight: 4, done: true },
      { assigneeId, weight: 4, done: true },
      { assigneeId, weight: 4, done: true }
    ])
  ];

  await prisma.task.createMany({
    data: tasks.map((task, index) => ({
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: index + 1,
      key: `${project.keyPrefix}-${index + 1}`,
      title: `کار ${index + 1}`,
      status: task.done ? ('DONE' as const) : ('TODO' as const),
      priority: 'MEDIUM' as const,
      weight: task.weight,
      assigneeId: task.assigneeId,
      dueAt: task.done ? null : yesterday,
      completedAt: task.done ? new Date(now - 60 * 60 * 1000) : null
    }))
  });

  const [workday, quietDay] = recentWorkdays(2);

  // Written straight to the table. The API gate refuses an agent report now, but rows filed before
  // it existed are exactly what pushed participation past 100%, and they are still in the database.
  //
  // `submittedFor` is deliberately stale for everyone but the member. The digest and the trends read
  // `dateKey`, so those numbers are unaffected; the missing-check-in roster reads `submittedFor`, so
  // this is what makes the guest and both agents LOOK overdue to it. Without that, a roster that
  // wrongly admitted them would write no row and the exclusion would go unproven.
  const staleSubmission = new Date(now - 5 * 24 * 60 * 60 * 1000);
  await prisma.checkInResponse.createMany({
    data: [
      {
        workspaceId: workspace.id,
        userId: users.member.id,
        authorId: users.member.id,
        dateKey: workday,
        submittedFor: new Date(now),
        completedText: 'کار انجام شد',
        blockersText: 'منتظر بازبینی'
      },
      {
        workspaceId: workspace.id,
        userId: users.guest.id,
        authorId: users.guest.id,
        dateKey: workday,
        submittedFor: staleSubmission,
        completedText: 'کار پیمانکار',
        blockersText: 'دسترسی ندارم',
        unplannedText: 'درخواست فوری'
      },
      {
        workspaceId: workspace.id,
        userId: users.agentAsAgent.id,
        authorId: users.agentAsAgent.id,
        dateKey: workday,
        submittedFor: staleSubmission,
        completedText: 'سه تسک بستم',
        blockersText: 'به کلید API نیاز دارم',
        unplannedText: 'کار پیش‌بینی‌نشده'
      },
      {
        workspaceId: workspace.id,
        userId: users.agentAsMember.id,
        authorId: users.agentAsMember.id,
        dateKey: workday,
        submittedFor: staleSubmission,
        completedText: 'سه تسک بستم',
        blockersText: 'به کلید API نیاز دارم',
        unplannedText: 'کار پیش‌بینی‌نشده'
      }
    ]
  });

  const session = await createUserSession(users.owner.id);
  return { workspace, project, users, ownerToken: session.token, workday, quietDay };
}

async function driveMeasurementSurfaces(): Promise<Surfaces> {
  const window = {
    startsAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };

  const [digest, trends, workHealth, leaderboard, assignment, directory, tasks, attention] = await Promise.all([
    asOwner<DigestBody>({ method: 'GET', url: `/check-ins/digest?dateKey=${fixture.workday}` }),
    asOwner<TrendsBody>({ method: 'GET', url: '/check-ins/trends?days=7' }),
    asOwner<WorkHealthBody>({ method: 'GET', url: '/work-health/summary' }),
    asOwner<LeaderboardBody>({
      method: 'GET',
      url: `/leaderboard?startsAt=${encodeURIComponent(window.startsAt)}&endsAt=${encodeURIComponent(window.endsAt)}`
    }),
    asOwner<AssignmentBody>({
      method: 'POST',
      url: '/assignment/recommend',
      payload: { projectId: fixture.project.id, weight: 2 }
    }),
    asOwner<DirectoryBody>({ method: 'GET', url: '/users' }),
    asOwner<TaskListBody>({ method: 'GET', url: `/tasks?projectId=${fixture.project.id}&limit=100` }),
    // Generates and then lists: the missing-check-in roster is the one measurement surface that
    // WRITES its verdict down, so reading the rows back is the only way to see who it judged.
    asOwner<AttentionBody>({ method: 'GET', url: '/attention?status=ALL&limit=100' })
  ]);

  const reminders = await driveDailyReportReminders();
  return { digest, trends, workHealth, leaderboard, assignment, directory, tasks, attention, reminders };
}

/**
 * Runs the evening nudge and reports who it reached inside this workspace.
 *
 * Called directly rather than through a route because the job has no route: it runs on a timer,
 * across every workspace at once, and that is exactly why it needs driving here — a roster nobody
 * looks at is where an exclusion rots unnoticed.
 */
async function driveDailyReportReminders(): Promise<ReminderOutcome> {
  const before = await prisma.notification.findMany({
    where: { type: DAILY_REPORT_REMINDER_NOTIFICATION_TYPE },
    select: { id: true }
  });
  const preexisting = new Set(before.map((row) => row.id));

  const stats = await sendDailyReportReminders(fixture.quietDay);

  const after = await prisma.notification.findMany({
    where: { type: DAILY_REPORT_REMINDER_NOTIFICATION_TYPE },
    select: { id: true, workspaceId: true, userId: true }
  });
  const created = after.filter((row) => !preexisting.has(row.id));
  for (const row of created) {
    if (row.workspaceId !== fixture.workspace.id) strayReminderIds.push(row.id);
  }

  return {
    stats,
    nudged: created.filter((row) => row.workspaceId === fixture.workspace.id).map((row) => row.userId)
  };
}

async function asOwner<T>(options: InjectOptions): Promise<T> {
  const response = await app.inject({
    ...options,
    headers: {
      authorization: `Bearer ${fixture.ownerToken}`,
      'x-workspace-slug': fixture.workspace.slug,
      ...(options.headers || {})
    }
  });
  if (response.statusCode >= 400) {
    throw new Error(`${options.method} ${options.url} → ${response.statusCode} ${response.body}`);
  }
  return response.json() as T;
}

async function createUser(key: string, name: string, kind: UserKind = 'HUMAN') {
  const user = await prisma.user.create({
    data: { email: `${key}@measured-people.test`.toLowerCase(), name, kind },
    select: { id: true, name: true }
  });
  return user;
}

/** Day keys inside the default 7-day trends window, newest first. */
function recentWorkdays(count: number): string[] {
  const today = workspaceDateKey();
  const keys: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) keys.push(shiftDateKey(today, -offset));
  const workdays = keys.filter(isWorkdayKey).slice(0, count);
  if (workdays.length < count) throw new Error(`Expected ${count} workdays in the trends window`);
  return workdays;
}
