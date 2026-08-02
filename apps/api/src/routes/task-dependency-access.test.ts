import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * A task's blockers may not be read by somebody who cannot open them.
 *
 * Issue #58. `GET /tasks/:idOrKey` returned the far end of every blocking edge in full — key, title,
 * status and body — with only the effort filter on it, and a dependency is not constrained to one
 * project. So reading any task read everything it blocked or was blocked by, across team walls.
 *
 * Two people are needed to test this at all, as in #57: an **insider** on the project's team, and
 * an **outsider** who is a full workspace member on no team. Every test asserts both halves — the
 * outsider does not get the far end *and* the insider still does. A filter that returned nothing to
 * anybody would pass the first half on its own, and that is how a fix like this quietly deletes the
 * dependency section.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerEmail: string;
  ownerId: string;
  /** On the near team: can read the walled-off work, so must still see it on the far end. */
  insiderEmail: string;
  insiderId: string;
  /** A workspace member on no team: cannot open the walled-off work, so must not read it here. */
  outsiderEmail: string;
  outsiderId: string;
  /** Owned by the near team, which the insider is on and the outsider is not. */
  nearProjectId: string;
  /** Teamless, so every workspace member can read it. Where the task under test lives. */
  openProjectId: string;
  /** On a team nobody is on, but **led** by the outsider: reachable without any membership. */
  ledProjectId: string;
  /** On that same team, with the outsider an explicit `ProjectMember`: the other way in. */
  memberProjectId: string;
}

/** What the route returns in place of a task the reader may not open. */
interface RedactedRef {
  redacted: true;
  open: boolean;
}

type FarEnd = RedactedRef | { id: string; key: string; title: string; status: string; description?: string | null };

describe('task dependency access', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: { email: { in: [fixture.ownerEmail, fixture.insiderEmail, fixture.outsiderEmail] } }
    });
    await app.close();
  });

  test('a blocker behind a team wall is redacted, and still readable by somebody on that team', async () => {
    const task = await createTask('open to everyone', fixture.openProjectId);
    const blocker = await createTask('the thing in the way', fixture.nearProjectId, {
      description: 'the body nobody outside the team may read'
    });
    await blockOn(task.key, blocker.key);

    const [hidden] = await blockers(fixture.outsiderEmail, task.key);
    expect(hidden).toEqual({ redacted: true, open: true });

    const [shown] = await blockers(fixture.insiderEmail, task.key);
    expect(shown).toMatchObject({ key: blocker.key, title: blocker.title });
  });

  /**
   * The downstream direction, which is the one the reported include pair makes easy to forget: it
   * is the *other* task that drew the edge, so nobody reading this task ever consented to it.
   */
  test('a task this one blocks is redacted the same way, in the other direction', async () => {
    const task = await createTask('the prerequisite everyone can see', fixture.openProjectId);
    const dependent = await createTask('waiting behind a team wall', fixture.nearProjectId);
    await blockOn(dependent.key, task.key);

    const [hidden] = await blocks(fixture.outsiderEmail, task.key);
    expect(hidden).toEqual({ redacted: true, open: true });

    const [shown] = await blocks(fixture.insiderEmail, task.key);
    expect(shown).toMatchObject({ key: dependent.key, title: dependent.title });
  });

  /**
   * The reason the edge is redacted instead of dropped, asserted as the property it protects.
   *
   * Omitting the edge is the fix a `taskWhereForAccess` on the include would have given for free,
   * and it would have made this task read as takeable to the outsider while a blocker was sitting
   * in front of it. #24 made blockedness true and #50 draws it; a list that shrinks by reader is a
   * different answer to "can I pick this up" depending on who asks, and the wrong one is the
   * permissive one.
   */
  test('a redacted blocker still blocks: the list does not shrink and the count still counts it', async () => {
    const task = await createTask('blocked by something out of reach', fixture.openProjectId);
    const blocker = await createTask('in the way, behind the wall', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const outsiderView = await readTask(fixture.outsiderEmail, task.key);
    const insiderView = await readTask(fixture.insiderEmail, task.key);

    expect(edgeCount(outsiderView)).toBe(edgeCount(insiderView));
    expect(openBlockerCount(outsiderView)).toBe(1);
    expect(openBlockerCount(insiderView)).toBe(1);
  });

  /**
   * And the other half of the same bit. Reporting every hidden blocker as open would wall a task
   * off permanently once a prerequisite it cannot see is finished — the one-way door `blockers.ts`
   * exists to keep shut — so `open` is read from the blocker's real status even though the status
   * itself is not disclosed.
   */
  test('a redacted blocker that is finished says so, so the task reads as takeable again', async () => {
    const task = await createTask('was blocked, prerequisite finished', fixture.openProjectId);
    const blocker = await createTask('finished behind the wall', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);
    await patch(blocker.key, { status: 'DONE' });

    const outsiderView = await readTask(fixture.outsiderEmail, task.key);
    expect(blockersOf(outsiderView)).toEqual([{ redacted: true, open: false }]);
    expect(openBlockerCount(outsiderView)).toBe(0);
  });

  /**
   * A redaction that ships the hidden task's primary key is cosmetic: the id is a handle to
   * correlate the same hidden task across every edge that touches it. The edge's own id stays —
   * that identifies the relationship, which the reader is being told about on purpose.
   */
  test('a redacted edge carries no handle to the task behind it', async () => {
    const task = await createTask('nothing to correlate on', fixture.openProjectId);
    const blocker = await createTask('anonymous', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const view = await readTask(fixture.outsiderEmail, task.key);
    const [edge] = view.blockingDependencies as Array<{ id: string; blockedByTaskId: string | null }>;

    expect(edge.id).toBeTruthy();
    expect(edge.blockedByTaskId).toBeNull();
    expect(JSON.stringify(view)).not.toContain(blocker.id);
    expect(JSON.stringify(view)).not.toContain(blocker.key);
  });

  /**
   * `subtasks` was not in the report and has the same shape, which is the whole reason to look.
   *
   * The route to a cross-project child is `PATCH /tasks/:key { projectId }`: it moves the task and
   * leaves `parentId` alone, and `assertTaskRelations` only re-checks a parent when the patch names
   * one. So a child walks behind a team wall while its parent keeps listing it.
   */
  test('a subtask that has moved behind a team wall is redacted for the reader who cannot follow it', async () => {
    const parent = await createTask('the parent everyone can read', fixture.openProjectId);
    const child = await createTask('the child that walked away', fixture.openProjectId, { parentId: parent.id });
    await moveToProject(child.key, fixture.nearProjectId);

    expect(subtasksOf(await readTask(fixture.outsiderEmail, parent.key))).toEqual([{ redacted: true, open: true }]);
    expect(subtasksOf(await readTask(fixture.insiderEmail, parent.key))[0]).toMatchObject({ key: child.key });
  });

  /**
   * The third surface carrying a far end, found by sweeping for the shape rather than by fixing
   * what was reported. `POST /agent/daily-plan` hands an agent its own assigned work with the open
   * blockers materialised, and returns those rows — so the blocker's whole record rode out on a
   * route whose reader is only guaranteed to be the *blocked* task's assignee.
   */
  test('the agent daily plan redacts a blocker its reader cannot open', async () => {
    const task = await createTask('assigned to the outsider', fixture.openProjectId);
    await patch(task.key, { assigneeId: fixture.outsiderId, status: 'TODO' });
    const blocker = await createTask('in the way, behind the wall', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const plan = await dailyPlan(fixture.outsiderEmail);
    const planned = plan.blocked.find((row) => row.key === task.key);
    expect(planned?.blockingDependencies.map((edge) => edge.blockedByTask)).toEqual([
      { redacted: true, open: true }
    ]);
  });

  /**
   * #57's one deliberate omission, revisited because this ticket removed the reason for it.
   *
   * `task_blocked` is the only notification body that names a **second** task, key and title. #57
   * left it alone on the ground that it disclosed nothing the recipient could not already fetch
   * from `GET /tasks/:idOrKey` — which was true then and is not any more. Whoever watches a task
   * still hears that it became blocked; only the naming of the blocker is withheld, and only from
   * the people the redaction above already applies to.
   */
  test('a task_blocked notification names the blocker only to somebody who can open it', async () => {
    const task = await createTask('watched by both', fixture.openProjectId);
    await subscribe(task.key, fixture.outsiderEmail);
    await subscribe(task.key, fixture.insiderEmail);
    const blocker = await createTask('named to one of them', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const withheld = await blockedNotification(task.id, fixture.outsiderId);
    const named = await blockedNotification(task.id, fixture.insiderId);

    // Delivered, not dropped — asserted first, because every assertion below would pass on a row
    // that was never written, and a silent unsubscribe is not the fix this is.
    expect(withheld).not.toBeNull();
    expect(withheld?.body).not.toContain(blocker.key);
    expect(withheld?.body).not.toContain(blocker.title);
    expect(named?.body).toContain(blocker.key);
  });

  /**
   * The sync payload, checked rather than assumed — and it is clean, which is the finding.
   *
   * `taskInclude` carries `_count` and no far-end array at all, so the ambient stream has never
   * disclosed a blocker's key or title, and #24 chose it deliberately: an edge write emits an event
   * for the blocked task only, because the blocker's serialized row is byte-identical.
   *
   * That is a property of one include, one edit away from being untrue, and the client cache is
   * exactly where a leak would be least visible. So it is pinned: adding a far end to `taskInclude`
   * fails here, and whoever adds it has to route it through `redactRelatedTasks` first. The `_count`
   * is asserted present in the same breath, because deleting the arrays is not the fix — the
   * unfiltered open-blocker count is what keeps the list badge honest for work behind a wall.
   */
  test('the sync payload carries the blocker count and no far end to redact', async () => {
    const task = await createTask('synced to a client', fixture.openProjectId);
    const blocker = await createTask('never named in the stream', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const synced = await bootstrapTasks(fixture.outsiderEmail);
    const row = synced.find((item) => item.key === task.key);

    expect(row).toBeDefined();
    expect((row?._count as { blockingDependencies: number }).blockingDependencies).toBe(1);
    expect(row).not.toHaveProperty('blockingDependencies');
    expect(row).not.toHaveProperty('blockedTasks');
    expect(row).not.toHaveProperty('subtasks');
  });

  /**
   * The other half, and the half #57 learned the hard way: its tenth planted regression was a
   * missing positive case, where deleting the admin branch of `canReadProject` failed nothing.
   *
   * Team membership is one of four ways in. A fix that checked it alone would blank the dependency
   * section for a workspace admin, a project lead and an explicit project member — every one of
   * whom opens that work daily — and it would read as "the section stopped working", weeks later,
   * with nothing pointing at access. One test per way in, so the failure names which one broke.
   */
  describe('and still shows the far end to everybody who can open it', () => {
    test('a workspace admin, who is on no team at all', async () => {
      const task = await createTask('read by the owner', fixture.openProjectId);
      const blocker = await createTask('on a team the owner never joined', fixture.nearProjectId);
      await blockOn(task.key, blocker.key);

      expect((await blockers(fixture.ownerEmail, task.key))[0]).toMatchObject({ key: blocker.key });
    });

    test('a teamless project, which every workspace member reads', async () => {
      const task = await createTask('open, blocked by open', fixture.openProjectId);
      const blocker = await createTask('also open to everyone', fixture.openProjectId);
      await blockOn(task.key, blocker.key);

      expect((await blockers(fixture.outsiderEmail, task.key))[0]).toMatchObject({ key: blocker.key });
    });

    test('the lead of the far end\'s project, without being on its team', async () => {
      const task = await createTask('blocked by work they lead', fixture.openProjectId);
      const blocker = await createTask('led by the outsider', fixture.ledProjectId);
      await blockOn(task.key, blocker.key);

      expect((await blockers(fixture.outsiderEmail, task.key))[0]).toMatchObject({ key: blocker.key });
    });

    test('an explicit project member of the far end\'s project, without being on its team', async () => {
      const task = await createTask('blocked by a project they joined', fixture.openProjectId);
      const blocker = await createTask('joined by the outsider', fixture.memberProjectId);
      await blockOn(task.key, blocker.key);

      expect((await blockers(fixture.outsiderEmail, task.key))[0]).toMatchObject({ key: blocker.key });
    });
  });
});

async function subscribe(idOrKey: string, email: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${idOrKey}/subscription`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: {}
  });
  expect(response.statusCode).toBe(200);
}

/** Read off the table, never through the inbox: a row written and never shown is still a row. */
function blockedNotification(taskId: string, userId: string): Promise<{ body: string | null } | null> {
  return prisma.notification.findFirst({
    where: { taskId, userId, type: 'task_blocked' },
    select: { body: true }
  });
}

async function bootstrapTasks(email: string): Promise<Array<Record<string, unknown> & { key: string }>> {
  const response = await app.inject({
    method: 'GET',
    url: '/sync/bootstrap',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { tasks: Array<Record<string, unknown> & { key: string }> }).tasks;
}

interface PlannedTask {
  key: string;
  blockingDependencies: Array<{ blockedByTask: FarEnd }>;
}

async function dailyPlan(email: string): Promise<{ blocked: PlannedTask[]; focus: PlannedTask[] }> {
  const response = await app.inject({
    method: 'POST',
    url: '/agent/daily-plan',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: {}
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { blocked: PlannedTask[]; focus: PlannedTask[] };
}

function edgeCount(view: Record<string, unknown>): number {
  return (view.blockingDependencies as unknown[]).length;
}

function openBlockerCount(view: Record<string, unknown>): number {
  return (view._count as { blockingDependencies: number }).blockingDependencies;
}

function blockersOf(view: Record<string, unknown>): FarEnd[] {
  return (view.blockingDependencies as Array<{ blockedByTask: FarEnd }>).map((edge) => edge.blockedByTask);
}

function subtasksOf(view: Record<string, unknown>): FarEnd[] {
  return view.subtasks as FarEnd[];
}

async function patch(idOrKey: string, body: Record<string, unknown>): Promise<void> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/tasks/${idOrKey}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: body
  });
  expect(response.statusCode).toBe(200);
}

/** The move itself, asserted to have happened — a silently rejected PATCH would fake every result. */
async function moveToProject(idOrKey: string, projectId: string): Promise<void> {
  await patch(idOrKey, { projectId });
  const moved = await prisma.task.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId, key: idOrKey },
    select: { projectId: true, parentId: true }
  });
  expect(moved.projectId).toBe(projectId);
  expect(moved.parentId).not.toBeNull();
}

/** `A` is blocked by `B`, drawn by the owner, who can reach both ends. */
async function blockOn(idOrKey: string, blockedBy: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${idOrKey}/dependencies`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { blockedBy }
  });
  expect(response.statusCode).toBe(201);
}

async function readTask(email: string, idOrKey: string): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'GET',
    url: `/tasks/${idOrKey}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

async function blockers(email: string, idOrKey: string): Promise<FarEnd[]> {
  const body = await readTask(email, idOrKey);
  const edges = body.blockingDependencies as Array<{ blockedByTask: FarEnd }>;
  return edges.map((edge) => edge.blockedByTask);
}

async function blocks(email: string, idOrKey: string): Promise<FarEnd[]> {
  const body = await readTask(email, idOrKey);
  const edges = body.blockedTasks as Array<{ task: FarEnd }>;
  return edges.map((edge) => edge.task);
}

function createTask(
  title: string,
  projectId: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; key: string; title: string }> {
  return createTaskAs(fixture.ownerEmail, title, projectId, extra);
}

async function createTaskAs(
  email: string,
  title: string,
  projectId: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; key: string; title: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: { projectId, title, ...extra }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string; title: string };
  return { id: body.id, key: body.key, title: body.title };
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `da-owner-${suffix}@example.test`;
  const insiderEmail = `da-insider-${suffix}@example.test`;
  const outsiderEmail = `da-outsider-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Owner' } });
  const insider = await prisma.user.create({ data: { email: insiderEmail, name: 'Insider' } });
  const outsider = await prisma.user.create({ data: { email: outsiderEmail, name: 'Outsider' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Dependency access workspace', slug: `da-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: insider.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: outsider.id, role: 'MEMBER' }
    ]
  });

  const nearTeam = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Near', slug: `da-near-${suffix}` }
  });
  const farTeam = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Far', slug: `da-far-${suffix}` }
  });
  await prisma.teamMember.create({ data: { teamId: nearTeam.id, userId: insider.id, role: 'MEMBER' } });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const nearProject = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: nearTeam.id, name: 'Near work', keyPrefix: `DN${prefix}` }
  });
  const openProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Open work', keyPrefix: `DO${prefix}` }
  });
  const ledProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: farTeam.id,
      leadId: outsider.id,
      name: 'Led work',
      keyPrefix: `DL${prefix}`
    }
  });
  const memberProject = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: farTeam.id, name: 'Member work', keyPrefix: `DM${prefix}` }
  });
  await prisma.projectMember.create({
    data: { projectId: memberProject.id, userId: outsider.id, role: 'MEMBER' }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    ownerId: owner.id,
    insiderEmail,
    insiderId: insider.id,
    outsiderEmail,
    outsiderId: outsider.id,
    nearProjectId: nearProject.id,
    openProjectId: openProject.id,
    ledProjectId: ledProject.id,
    memberProjectId: memberProject.id
  };
}
