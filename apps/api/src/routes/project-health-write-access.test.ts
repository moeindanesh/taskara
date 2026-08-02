import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * The write branch of `requireProjectHealthAccess`, which the #59 audit found disagreeing three
 * ways with `canManageProjectPlanning` — the other spelling of "who may write to this project".
 *
 * Two were plain bugs and are closed: the old branch admitted **any** `ProjectMember` row and
 * **any** `TeamMember` row without reading the role on it, so a project `VIEWER` and a team `GUEST`
 * could post a health update while being refused a milestone on the same project the same second.
 *
 * The third is left, deliberately: a **teamless** project stays writable by anybody who can read it.
 * Both behaviours are asserted, so a later ticket that decides the question fails here and reads
 * this note rather than discovering it.
 *
 * Both halves throughout — the roles that lost the write, and the four that still have it.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  adminEmail: string;
  leadEmail: string;
  teamMemberEmail: string;
  teamGuestEmail: string;
  projectMemberEmail: string;
  projectViewerEmail: string;
  emails: string[];
  teamProjectId: string;
  teamlessProjectId: string;
}

describe('project health write access', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({ where: { email: { in: fixture.emails } } });
    await app.close();
  });

  test('a project VIEWER may read the project and may not post an update', async () => {
    expect(await readUpdates(fixture.projectViewerEmail)).toBe(200);
    expect(await postUpdate(fixture.projectViewerEmail, fixture.teamProjectId)).toBe(403);
  });

  test('a team GUEST may not post an update', async () => {
    expect(await postUpdate(fixture.teamGuestEmail, fixture.teamProjectId)).toBe(403);
  });

  /** Four ways in, one test each, so a failure names which one broke. */
  test('an admin, the lead, a project MEMBER and a team MEMBER all still post', async () => {
    expect(await postUpdate(fixture.adminEmail, fixture.teamProjectId)).toBe(201);
    expect(await postUpdate(fixture.leadEmail, fixture.teamProjectId)).toBe(201);
    expect(await postUpdate(fixture.projectMemberEmail, fixture.teamProjectId)).toBe(201);
    expect(await postUpdate(fixture.teamMemberEmail, fixture.teamProjectId)).toBe(201);
  });

  /**
   * The divergence left standing. `canManageProjectPlanning` refuses a teamless project to
   * everybody but an admin and the lead; this pins the current behaviour rather than endorsing it.
   */
  test('a teamless project stays writable by anybody who can read it', async () => {
    expect(await postUpdate(fixture.projectViewerEmail, fixture.teamlessProjectId)).toBe(201);
  });
});

function headers(email: string) {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email };
}

async function postUpdate(email: string, projectId: string): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/updates`,
    headers: headers(email),
    payload: { health: 'ON_TRACK', summary: 'weekly note' }
  });
  return response.statusCode;
}

async function readUpdates(email: string): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: `/projects/${fixture.teamProjectId}/updates`,
    headers: headers(email)
  });
  return response.statusCode;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const make = (name: string) => `ph-${name}-${suffix}@example.test`;
  const adminEmail = make('admin');
  const leadEmail = make('lead');
  const teamMemberEmail = make('teammember');
  const teamGuestEmail = make('teamguest');
  const projectMemberEmail = make('projmember');
  const projectViewerEmail = make('projviewer');
  const emails = [adminEmail, leadEmail, teamMemberEmail, teamGuestEmail, projectMemberEmail, projectViewerEmail];

  const users = Object.fromEntries(
    await Promise.all(
      emails.map(async (email) => [email, await prisma.user.create({ data: { email, name: email } })] as const)
    )
  );
  const workspace = await prisma.workspace.create({
    data: { name: 'Project health workspace', slug: `ph-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: emails.map((email) => ({
      workspaceId: workspace.id,
      userId: users[email].id,
      // Every one of them is a full workspace MEMBER, so the only thing under test is the project
      // and team role. A workspace GUEST is refused higher up by a different rule.
      role: email === adminEmail ? ('OWNER' as const) : ('MEMBER' as const)
    }))
  });

  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: `Team ${suffix}`, slug: `ph-team-${suffix}` }
  });
  await prisma.teamMember.createMany({
    data: [
      { teamId: team.id, userId: users[teamMemberEmail].id, role: 'MEMBER' },
      { teamId: team.id, userId: users[teamGuestEmail].id, role: 'GUEST' },
      // On the team as well, so the project-role branch is what decides them rather than the
      // absence of any membership at all.
      { teamId: team.id, userId: users[projectMemberEmail].id, role: 'GUEST' },
      { teamId: team.id, userId: users[projectViewerEmail].id, role: 'GUEST' }
    ]
  });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const teamProject = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Team project ${suffix}`,
      keyPrefix: `PH${prefix}`,
      teamId: team.id,
      leadId: users[leadEmail].id
    }
  });
  const teamlessProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: `Teamless ${suffix}`, keyPrefix: `PT${prefix}` }
  });
  await prisma.projectMember.createMany({
    data: [
      { projectId: teamProject.id, userId: users[projectMemberEmail].id, role: 'MEMBER' },
      { projectId: teamProject.id, userId: users[projectViewerEmail].id, role: 'VIEWER' }
    ]
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    adminEmail,
    leadEmail,
    teamMemberEmail,
    teamGuestEmail,
    projectMemberEmail,
    projectViewerEmail,
    emails,
    teamProjectId: teamProject.id,
    teamlessProjectId: teamlessProject.id
  };
}
