import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * The activity log may not hand out entities the reader cannot open.
 *
 * Issue #59, fourth in the chain after #57 (notifications) and #58 (dependencies). `GET /activity`
 * returned the last 50 rows for the whole workspace to any member with no access filter at all, and
 * an activity row's `after` is a snapshot of the **whole entity** — so a member on no team read
 * titles, descriptions and assignees off every project in the workspace.
 *
 * Two people again, as in #57 and #58: an **insider** on the walled team and an **outsider** who is
 * a full workspace member on no team. Every test asserts both halves. A feed that returned nothing
 * to anybody would pass the first half of every one of these, and that failure looks like "activity
 * stopped working" months later with nothing pointing at access.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerEmail: string;
  ownerId: string;
  /** On the near team: reads the walled-off work, so its activity must still reach them. */
  insiderEmail: string;
  insiderId: string;
  /** A workspace member on no team: cannot open the walled-off work, so must not read its feed. */
  outsiderEmail: string;
  outsiderId: string;
  /** Owned by the near team, which the insider is on and the outsider is not. */
  nearProjectId: string;
  /** Teamless, so every workspace member can read it. */
  openProjectId: string;
  /** On a team nobody is on, but **led** by the outsider: reachable without any membership. */
  ledProjectId: string;
  /** On that same team, with the outsider an explicit `ProjectMember`: the other way in. */
  memberProjectId: string;
  /** A team the insider is on and the outsider is not. */
  nearTeamId: string;
}

interface ActivityRow {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

describe('activity log access', () => {
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

  /**
   * The report itself. The snapshot is the disclosure — `after` on a `created` row is the task,
   * description and all — so the assertion is against the serialized feed, not against a field.
   */
  test('a task behind a team wall is absent from the workspace feed, and present for somebody on that team', async () => {
    const walled = await createTask('the walled-off work', fixture.nearProjectId, {
      description: 'the body nobody outside the team may read'
    });

    const outsiderFeed = await workspaceActivity(fixture.outsiderEmail);
    expect(entityIds(outsiderFeed)).not.toContain(walled.id);
    expect(JSON.stringify(outsiderFeed)).not.toContain(walled.key);
    expect(JSON.stringify(outsiderFeed)).not.toContain('the body nobody outside the team may read');

    const insiderFeed = await workspaceActivity(fixture.insiderEmail);
    expect(entityIds(insiderFeed)).toContain(walled.id);
  });

  /**
   * The other half of the report, and the reason #58 left it: the same two fields it withheld from
   * the task detail, the agent's daily plan and the `task_blocked` body were still being served on
   * the task's own timeline, gated only on the *near* task.
   */
  test('a dependency entry names the blocker only to somebody who can open it', async () => {
    const task = await createTask('blocked, in the open', fixture.openProjectId);
    const blocker = await createTask('in the way, behind the wall', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const withheld = dependencyEntry(await taskActivity(fixture.outsiderEmail, task.key));
    expect(withheld?.after).toMatchObject({
      taskKey: task.key,
      blockedByTaskId: null,
      blockedByTaskKey: null,
      blockedByTaskTitle: null,
      blockedByTaskRedacted: true
    });

    const named = dependencyEntry(await taskActivity(fixture.insiderEmail, task.key));
    expect(named?.after).toMatchObject({ blockedByTaskKey: blocker.key, blockedByTaskTitle: blocker.title });
  });

  /**
   * Redacted rather than dropped, which is the opposite call to the row-level one above and the
   * whole reason the two are argued separately.
   *
   * `GET /tasks/:idOrKey` shows this reader a redacted edge in the dependency list — #58 made sure
   * of it, because a task with an invisible blocker reads as takeable. A timeline that omitted the
   * entry would say the edge was never drawn, and the task page would be contradicting itself in
   * two panels of the same screen.
   */
  test('the dependency entry survives redaction, so the timeline agrees with the dependency list', async () => {
    const task = await createTask('the timeline must not disagree', fixture.openProjectId);
    const blocker = await createTask('unnameable prerequisite', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const outsiderEntries = await taskActivity(fixture.outsiderEmail, task.key);
    const insiderEntries = await taskActivity(fixture.insiderEmail, task.key);

    expect(dependencyEntry(outsiderEntries)).toBeDefined();
    expect(outsiderEntries.length).toBe(insiderEntries.length);
    expect(JSON.stringify(outsiderEntries)).not.toContain(blocker.id);
    expect(JSON.stringify(outsiderEntries)).not.toContain(blocker.key);
    expect(JSON.stringify(outsiderEntries)).not.toContain(blocker.title);
  });

  /** The same payload rides out on the workspace feed, where the row itself is readable. */
  test('the workspace feed redacts a dependency far end on a row it is showing', async () => {
    const task = await createTask('feed row anybody may read', fixture.openProjectId);
    const blocker = await createTask('far end nobody outside may read', fixture.nearProjectId);
    await blockOn(task.key, blocker.key);

    const feed = await workspaceActivity(fixture.outsiderEmail);
    const entry = feed.find((row) => row.entityId === task.id && row.action === 'dependency_added');

    expect(entry).toBeDefined();
    expect(entry?.after).toMatchObject({ blockedByTaskKey: null, blockedByTaskRedacted: true });
    expect(JSON.stringify(feed)).not.toContain(blocker.key);
  });

  /**
   * The polymorphic pointer is the reason this surface needed a table rather than a predicate, and
   * default-deny is the property that ends the chain here: a type nobody has placed is not served.
   *
   * Asserted through a real administrative row rather than an invented one. `PATCH /me` snapshots
   * the editor's email and phone either side of the change, and an ordinary member has no business
   * reading either — while the workspace owner, who administers the place, still does.
   */
  test('an administrative row is admin-only: a profile edit is not workspace gossip', async () => {
    const changed = await editOwnProfile(fixture.insiderEmail, { phone: '09121110000' });
    expect(changed).toBe(true);

    const outsiderFeed = await workspaceActivity(fixture.outsiderEmail);
    expect(outsiderFeed.filter((row) => row.entityType === 'user')).toEqual([]);
    expect(JSON.stringify(outsiderFeed)).not.toContain('09121110000');

    const ownerFeed = await workspaceActivity(fixture.ownerEmail);
    expect(ownerFeed.some((row) => row.entityType === 'user' && row.entityId === fixture.insiderId)).toBe(true);
  });

  /**
   * A row about an entity type nobody has classified — a legacy row, or one written straight to the
   * table — is dropped rather than passed through. The compiler stops a *new* type reaching
   * `logActivity` unplaced; this is the half of the guard that covers rows already in the table.
   */
  test('a row whose entity type has no rule is dropped, and an admin still reads it', async () => {
    await prisma.activityLog.create({
      data: {
        workspaceId: fixture.workspaceId,
        actorId: fixture.ownerId,
        actorType: 'USER',
        entityType: 'entity_type_from_the_future',
        entityId: crypto.randomUUID(),
        action: 'happened'
      }
    });

    expect((await workspaceActivity(fixture.outsiderEmail)).map((row) => row.entityType))
      .not.toContain('entity_type_from_the_future');
    expect((await workspaceActivity(fixture.ownerEmail)).map((row) => row.entityType))
      .toContain('entity_type_from_the_future');
  });

  /**
   * A team's own rows go through `canReadTeam`, not through a project — the second rule this feed
   * defers to, and the one that would have been easiest to fold into the first and get wrong.
   */
  test('a team the reader is not on is absent from the feed, and present for a member of it', async () => {
    const team = await createTeam(`aa-secret-${crypto.randomUUID().slice(0, 6)}`);
    await addTeamMember(team.id, fixture.insiderId);

    const outsiderFeed = await workspaceActivity(fixture.outsiderEmail);
    expect(entityIds(outsiderFeed)).not.toContain(team.id);

    const insiderFeed = await workspaceActivity(fixture.insiderEmail);
    expect(entityIds(insiderFeed)).toContain(team.id);
    expect(insiderFeed.some((row) => row.entityType === 'team_member')).toBe(true);
  });

  /**
   * The plus-side finding #59 recorded rather than buried, acted on in #60.
   *
   * Nine entity types were denied to non-admins because their read rule was not callable from here.
   * `knowledge_page` is the first one whose rule became composable — `knowledgeSpaceWhereForAccess`
   * is a Prisma predicate now, not an async function over a `RequestActor` — so the row is placed by
   * asking it rather than by re-spelling it.
   *
   * Over-omission on a feed is not a disclosure, which is exactly why it is the kind of thing that
   * sits unnoticed for a month. Both halves again.
   */
  test('a knowledge page is placed by its space, and one in a walled project stays hidden', async () => {
    const walled = await createKnowledgeSpace('PROJECT', fixture.nearProjectId);
    const open = await createKnowledgeSpace('WORKSPACE');
    const walledPage = await createKnowledgePage(walled.id, 'the runbook behind the wall');
    const openPage = await createKnowledgePage(open.id, 'the runbook everybody reads');

    const outsiderFeed = await workspaceActivity(fixture.outsiderEmail);
    expect(entityIds(outsiderFeed)).not.toContain(walledPage.id);
    expect(entityIds(outsiderFeed)).toContain(openPage.id);
    expect(JSON.stringify(outsiderFeed)).not.toContain('the runbook behind the wall');

    const insiderFeed = await workspaceActivity(fixture.insiderEmail);
    expect(entityIds(insiderFeed)).toContain(walledPage.id);
    expect(entityIds(await workspaceActivity(fixture.ownerEmail))).toContain(walledPage.id);
  });

  /**
   * The other half, and the one #57 learned by planting it: its tenth regression was a missing
   * positive case, where deleting `canReadProject`'s admin branch failed nothing.
   *
   * Team membership is one of four ways in. A feed that checked it alone would go quiet for a
   * workspace admin, a project lead and an explicit project member, and would read as "activity
   * stopped working" with nothing pointing at access. One test per way in, so the failure names
   * which one broke.
   */
  describe('and still shows the feed to everybody who can read the work', () => {
    test('a workspace admin, who is on no team at all', async () => {
      const task = await createTask('read by the owner', fixture.nearProjectId);
      expect(entityIds(await workspaceActivity(fixture.ownerEmail))).toContain(task.id);
    });

    test('a teamless project, which every workspace member reads', async () => {
      const task = await createTask('open to everyone', fixture.openProjectId);
      expect(entityIds(await workspaceActivity(fixture.outsiderEmail))).toContain(task.id);
    });

    test('the lead of the project, without being on its team', async () => {
      const task = await createTask('in work they lead', fixture.ledProjectId);
      expect(entityIds(await workspaceActivity(fixture.outsiderEmail))).toContain(task.id);
    });

    test('an explicit project member, without being on its team', async () => {
      const task = await createTask('in a project they joined', fixture.memberProjectId);
      expect(entityIds(await workspaceActivity(fixture.outsiderEmail))).toContain(task.id);
    });
  });
});

interface DependencyPayload {
  taskKey: string;
  blockedByTaskId: string | null;
  blockedByTaskKey: string | null;
  blockedByTaskTitle: string | null;
  blockedByTaskRedacted?: boolean;
}

function dependencyEntry(rows: ActivityRow[]): { after: DependencyPayload | null } | undefined {
  const row = rows.find((entry) => entry.action === 'dependency_added');
  return row ? { after: (row.after ?? null) as DependencyPayload | null } : undefined;
}

async function taskActivity(email: string, idOrKey: string): Promise<ActivityRow[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/tasks/${idOrKey}/activity`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ActivityRow[];
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

/** Returns whether the edit landed, so a route that quietly refused cannot fake an empty feed. */
async function editOwnProfile(email: string, patch: Record<string, unknown>): Promise<boolean> {
  const response = await app.inject({
    method: 'PATCH',
    url: '/me',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: patch
  });
  return response.statusCode === 200;
}

async function createTeam(slug: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/teams',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { name: slug, slug }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function addTeamMember(teamId: string, userId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/teams/${teamId}/members`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { userId, role: 'MEMBER' }
  });
  expect(response.statusCode).toBe(201);
}

async function createKnowledgeSpace(type: 'WORKSPACE' | 'PROJECT', projectId?: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/knowledge/spaces',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: {
      type,
      projectId,
      key: `aa-${crypto.randomUUID().slice(0, 8)}`,
      name: `space ${crypto.randomUUID().slice(0, 6)}`
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function createKnowledgePage(spaceId: string, title: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/knowledge/pages',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { spaceId, title, slug: `page-${crypto.randomUUID().slice(0, 8)}` }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

function entityIds(rows: ActivityRow[]): string[] {
  return rows.map((row) => row.entityId);
}

async function workspaceActivity(email: string): Promise<ActivityRow[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/activity',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ActivityRow[];
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
  const ownerEmail = `aa-owner-${suffix}@example.test`;
  const insiderEmail = `aa-insider-${suffix}@example.test`;
  const outsiderEmail = `aa-outsider-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Owner' } });
  const insider = await prisma.user.create({ data: { email: insiderEmail, name: 'Insider' } });
  const outsider = await prisma.user.create({ data: { email: outsiderEmail, name: 'Outsider' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Activity access workspace', slug: `aa-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: insider.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: outsider.id, role: 'MEMBER' }
    ]
  });

  const nearTeam = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Near', slug: `aa-near-${suffix}` }
  });
  const farTeam = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Far', slug: `aa-far-${suffix}` }
  });
  await prisma.teamMember.create({ data: { teamId: nearTeam.id, userId: insider.id, role: 'MEMBER' } });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const nearProject = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: nearTeam.id, name: 'Near work', keyPrefix: `AN${prefix}` }
  });
  const openProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Open work', keyPrefix: `AO${prefix}` }
  });
  const ledProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: farTeam.id,
      leadId: outsider.id,
      name: 'Led work',
      keyPrefix: `AL${prefix}`
    }
  });
  const memberProject = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: farTeam.id, name: 'Member work', keyPrefix: `AM${prefix}` }
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
    memberProjectId: memberProject.id,
    nearTeamId: nearTeam.id
  };
}
