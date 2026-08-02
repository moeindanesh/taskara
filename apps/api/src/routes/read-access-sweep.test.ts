import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * The one-line gaps the #59 audit of every read path turned up, closed together.
 *
 * #57 → #58 → #59 each found a wider disclosure than the last, so #59 stopped fixing the report and
 * enumerated the whole surface instead — see `.scratch/AUDIT-read-access-sites.md`. These three are
 * the ones that were a single composed predicate away; the rest are named in that file and left
 * open on purpose rather than half-swept.
 *
 * Two shapes recur, and both are here:
 *
 * - **Gate the container, forget the contents.** `GET /projects/:id` gates the project and then
 *   lists its subprojects, which carry their own independent `teamId`.
 * - **The optional `access` argument.** `findTaskByIdOrKey(workspaceId, idOrKey, access = null)`
 *   silently degraded to workspace-only, and the ungated call read exactly like the eighteen gated
 *   ones. `services/notifications.ts` argues at length for the opposite design and was right: the
 *   argument was forgotten, three times, in a different function.
 *
 * Both halves are asserted throughout: who stops being reached, and who still is.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerEmail: string;
  insiderEmail: string;
  insiderId: string;
  /** The insider's Mattermost handle, so the same person can arrive over the slash command. */
  insiderHandle: string;
  outsiderEmail: string;
  outsiderHandle: string;
  parentProjectId: string;
  /** A subproject of the parent, on a team only the insider is on. */
  walledChildId: string;
  /** A subproject of the parent with no team of its own. */
  openChildId: string;
  nearProjectId: string;
}

describe('read access sweep', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: {
        OR: [
          { email: { in: [fixture.ownerEmail, fixture.insiderEmail, fixture.outsiderEmail] } },
          { mattermostUsername: { in: [fixture.insiderHandle, fixture.outsiderHandle] } }
        ]
      }
    });
    await app.close();
  });

  /**
   * `Project.subprojects` is a self-relation and a child carries its **own** `teamId`, so a reader
   * admitted by a teamless parent was handed every child's name, key prefix, description and lead.
   * Omitted rather than redacted: a subproject list decides nothing the way a blocker list does,
   * and the count beside it is corrected in the same breath so the two cannot disagree.
   */
  test('a subproject behind a team wall is absent from its parent, and present for somebody on that team', async () => {
    const outsiderView = await readProject(fixture.outsiderEmail, fixture.parentProjectId);
    expect(subprojectIds(outsiderView)).toEqual([fixture.openChildId]);
    expect(outsiderView._count.subprojects).toBe(1);
    expect(JSON.stringify(outsiderView)).not.toContain('the child nobody outside the team may read');

    const insiderView = await readProject(fixture.insiderEmail, fixture.parentProjectId);
    expect(subprojectIds(insiderView).sort()).toEqual([fixture.openChildId, fixture.walledChildId].sort());
    expect(insiderView._count.subprojects).toBe(2);
  });

  /**
   * A name-to-entity resolver: the generated Raycast script embeds the project's name and key
   * prefix, and the lookup was `{ id, workspaceId }` with no access clause.
   */
  test('the Raycast script refuses a project behind a team wall, and builds for somebody on that team', async () => {
    expect((await raycastScript(fixture.outsiderEmail, fixture.nearProjectId)).statusCode).toBe(404);

    const allowed = await raycastScript(fixture.insiderEmail, fixture.nearProjectId);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain('Near work');
  });

  /**
   * The Mattermost slash commands were the only callers of `findTaskByIdOrKey` that omitted the
   * access argument, and they do not merely read — each one resolves a key and then **writes**,
   * echoing the result back into the channel. `getMattermostActor` also creates a workspace member
   * out of a username it has never seen, so the reader population is anyone who can post in a
   * connected channel.
   */
  test('a Mattermost command cannot move a task behind a team wall, and still moves one it may read', async () => {
    const walled = await createTask('walled work, not yours to move', fixture.nearProjectId);

    const refused = await slashCommand(fixture.outsiderHandle, `status ${walled.key} in-review`);
    expect(refused.text).toContain('was not found');
    expect(await statusOf(walled.id)).toBe('TODO');

    const allowed = await slashCommand(fixture.insiderHandle, `status ${walled.key} in-review`);
    expect(allowed.text).toContain(walled.key);
    expect(await statusOf(walled.id)).toBe('IN_REVIEW');
  });

  /** The same argument was missing on `assign` and `due`, so each gets its own failure. */
  test('a Mattermost assign cannot reach a task behind a team wall', async () => {
    const walled = await createTask('not yours to assign', fixture.nearProjectId);

    const refused = await slashCommand(fixture.outsiderHandle, `assign ${walled.key} @${fixture.insiderHandle}`);
    expect(refused.text).toContain('was not found');
    expect(await assigneeOf(walled.id)).toBeNull();

    await slashCommand(fixture.insiderHandle, `assign ${walled.key} @${fixture.insiderHandle}`);
    expect(await assigneeOf(walled.id)).toBe(fixture.insiderId);
  });

  test('a Mattermost due date cannot reach a task behind a team wall', async () => {
    const walled = await createTask('not yours to schedule', fixture.nearProjectId);

    const refused = await slashCommand(fixture.outsiderHandle, `due ${walled.key} tomorrow`);
    expect(refused.text).toContain('was not found');
    expect(await dueOf(walled.id)).toBeNull();

    await slashCommand(fixture.insiderHandle, `due ${walled.key} tomorrow`);
    expect(await dueOf(walled.id)).not.toBeNull();
  });

  /** `/task bind` resolves a project by key prefix and answers with its name. */
  test('a Mattermost bind cannot name a project behind a team wall', async () => {
    const project = await prisma.project.findFirstOrThrow({
      where: { id: fixture.nearProjectId },
      select: { keyPrefix: true }
    });

    const refused = await slashCommand(fixture.outsiderHandle, `bind ${project.keyPrefix}`, 'channel-outsider');
    expect(refused.text).toContain('was not found');

    const allowed = await slashCommand(fixture.insiderHandle, `bind ${project.keyPrefix}`, 'channel-insider');
    expect(allowed.text).not.toContain('was not found');
  });
});

interface ProjectView {
  subprojects: Array<{ id: string }>;
  _count: { subprojects: number };
}

function subprojectIds(project: ProjectView): string[] {
  return project.subprojects.map((child) => child.id);
}

async function readProject(email: string, id: string): Promise<ProjectView> {
  const response = await app.inject({
    method: 'GET',
    url: `/projects/${id}`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ProjectView;
}

function raycastScript(email: string, projectId: string) {
  return app.inject({
    method: 'GET',
    url: `/raycast/scripts/taskara.bash?projectId=${projectId}`,
    headers: {
      'x-workspace-slug': fixture.workspaceSlug,
      'x-user-email': email,
      authorization: 'Bearer raycast-test-token'
    }
  });
}

async function slashCommand(handle: string, text: string, channelId = 'channel-1'): Promise<{ text: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/integrations/mattermost/command',
    payload: {
      workspace_slug: fixture.workspaceSlug,
      user_name: handle,
      channel_id: channelId,
      channel_name: channelId,
      text
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { text: string };
}

function statusOf(id: string): Promise<string> {
  return prisma.task.findFirstOrThrow({ where: { id }, select: { status: true } }).then((row) => row.status);
}

function assigneeOf(id: string): Promise<string | null> {
  return prisma.task.findFirstOrThrow({ where: { id }, select: { assigneeId: true } }).then((row) => row.assigneeId);
}

function dueOf(id: string): Promise<Date | null> {
  return prisma.task.findFirstOrThrow({ where: { id }, select: { dueAt: true } }).then((row) => row.dueAt);
}

async function createTask(title: string, projectId: string): Promise<{ id: string; key: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { projectId, title }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `rs-owner-${suffix}@example.test`;
  const insiderEmail = `rs-insider-${suffix}@example.test`;
  const outsiderEmail = `rs-outsider-${suffix}@example.test`;
  const insiderHandle = `rs-insider-${suffix}`;
  const outsiderHandle = `rs-outsider-${suffix}`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Owner' } });
  // The same two people reachable over both channels, so the Mattermost half tests access rather
  // than the accident of which user a synthetic email resolves to.
  const insider = await prisma.user.create({
    data: { email: insiderEmail, name: 'Insider', mattermostUsername: insiderHandle }
  });
  const outsider = await prisma.user.create({
    data: { email: outsiderEmail, name: 'Outsider', mattermostUsername: outsiderHandle }
  });
  const workspace = await prisma.workspace.create({
    data: { name: 'Read sweep workspace', slug: `rs-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: insider.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: outsider.id, role: 'MEMBER' }
    ]
  });

  const nearTeam = await prisma.team.create({
    data: { workspaceId: workspace.id, name: 'Near', slug: `rs-near-${suffix}` }
  });
  await prisma.teamMember.create({ data: { teamId: nearTeam.id, userId: insider.id, role: 'MEMBER' } });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const parent = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Parent', keyPrefix: `RP${prefix}` }
  });
  const walledChild = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      teamId: nearTeam.id,
      parentId: parent.id,
      name: 'the child nobody outside the team may read',
      keyPrefix: `RW${prefix}`
    }
  });
  const openChild = await prisma.project.create({
    data: { workspaceId: workspace.id, parentId: parent.id, name: 'Open child', keyPrefix: `RO${prefix}` }
  });
  const nearProject = await prisma.project.create({
    data: { workspaceId: workspace.id, teamId: nearTeam.id, name: 'Near work', keyPrefix: `RN${prefix}` }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    insiderEmail,
    insiderId: insider.id,
    insiderHandle,
    outsiderEmail,
    outsiderHandle,
    parentProjectId: parent.id,
    walledChildId: walledChild.id,
    openChildId: openChild.id,
    nearProjectId: nearProject.id
  };
}
