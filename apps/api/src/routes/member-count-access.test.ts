import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Gap 5 of the #59 audit, and the narrowest: the numbers beside the member directory.
 *
 * The **roster** is workspace-wide on purpose — every member sees the directory, and that is
 * written down where it is decided. The `_count` hanging off each row was not: it counted assigned
 * tasks, reported tasks and comments over every project in the workspace, walled ones included.
 *
 * Counts only, which is why it sat here through four tickets. A headcount of work behind a wall is
 * still a fact about that work, and the codebase already disagreed with itself — `GET /leaderboard`
 * puts `taskWhereForAccess` on the identical per-person rollup. This is the other half catching up.
 *
 * Both halves in every test, and one further assertion the shape needs: the two readers must see
 * **different** numbers for the same person, because a filter that produced the same number
 * everywhere would be no filter at all.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  adminEmail: string;
  /** On the walled team; holds one task in each project. */
  workerEmail: string;
  workerId: string;
  /** A full member on no team: sees the worker in the directory, not their walled work. */
  outsiderEmail: string;
}

interface MemberRow {
  id: string;
  _count?: { assignedTasks?: number; reportedTasks?: number; comments?: number };
}

describe('member directory counts', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: { email: { in: [fixture.adminEmail, fixture.workerEmail, fixture.outsiderEmail] } }
    });
    await app.close();
  });

  test('GET /users counts only the work the reader can open', async () => {
    const forOutsider = await directoryRow(fixture.outsiderEmail);
    expect(forOutsider._count?.assignedTasks).toBe(1);
    expect(forOutsider._count?.reportedTasks).toBe(1);
    expect(forOutsider._count?.comments).toBe(1);

    const forInsider = await directoryRow(fixture.workerEmail);
    expect(forInsider._count?.assignedTasks).toBe(2);
    expect(forInsider._count?.reportedTasks).toBe(2);
    expect(forInsider._count?.comments).toBe(2);
  });

  test('an admin counts everything', async () => {
    const forAdmin = await directoryRow(fixture.adminEmail);
    expect(forAdmin._count?.assignedTasks).toBe(2);
    expect(forAdmin._count?.reportedTasks).toBe(2);
    expect(forAdmin._count?.comments).toBe(2);
  });

  /** The offline copy of the same block, which is why the two now compose one predicate. */
  test('/sync/bootstrap counts the same way', async () => {
    const forOutsider = await bootstrapRow(fixture.outsiderEmail);
    expect(forOutsider._count?.assignedTasks).toBe(1);
    expect(forOutsider._count?.comments).toBe(1);

    const forInsider = await bootstrapRow(fixture.workerEmail);
    expect(forInsider._count?.assignedTasks).toBe(2);
    expect(forInsider._count?.comments).toBe(2);
  });

  /** The roster itself is deliberately workspace-wide: only the numbers were ever the question. */
  test('the outsider still sees the person, just not their walled work', async () => {
    const response = await app.inject({ method: 'GET', url: '/users?limit=100', headers: headers(fixture.outsiderEmail) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ id: string; email: string }> };
    expect(body.items.map((item) => item.email)).toContain(fixture.workerEmail);
  });
});

function headers(email: string) {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email };
}

async function directoryRow(email: string): Promise<MemberRow> {
  const response = await app.inject({ method: 'GET', url: '/users?limit=100', headers: headers(email) });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { items: MemberRow[] };
  const row = body.items.find((item) => item.id === fixture.workerId);
  expect(row).toBeDefined();
  return row as MemberRow;
}

async function bootstrapRow(email: string): Promise<MemberRow> {
  const response = await app.inject({ method: 'GET', url: '/sync/bootstrap', headers: headers(email) });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { users: MemberRow[] };
  const row = body.users.find((item) => item.id === fixture.workerId);
  expect(row).toBeDefined();
  return row as MemberRow;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `mc-admin-${suffix}@example.test`;
  const workerEmail = `mc-worker-${suffix}@example.test`;
  const outsiderEmail = `mc-outsider-${suffix}@example.test`;

  const admin = await prisma.user.create({ data: { email: adminEmail, name: 'Admin' } });
  const worker = await prisma.user.create({ data: { email: workerEmail, name: 'Worker' } });
  const outsider = await prisma.user.create({ data: { email: outsiderEmail, name: 'Outsider' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Member count workspace', slug: `mc-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: worker.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: outsider.id, role: 'MEMBER' }
    ]
  });

  const team = await prisma.team.create({
    data: { workspaceId: workspace.id, name: `Walled ${suffix}`, slug: `mc-walled-${suffix}` }
  });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: worker.id, role: 'MEMBER' } });

  const prefix = suffix.slice(0, 3).toUpperCase();
  const walledProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: `Walled ${suffix}`, keyPrefix: `MW${prefix}`, teamId: team.id }
  });
  const openProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: `Open ${suffix}`, keyPrefix: `MO${prefix}` }
  });

  // One of each, so a reader who can open half sees exactly half.
  for (const projectId of [walledProject.id, openProject.id]) {
    const task = await createTask(workspace.slug, workerEmail, projectId, worker.id);
    await comment(workspace.slug, workerEmail, task.id);
  }

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    adminEmail,
    workerEmail,
    workerId: worker.id,
    outsiderEmail
  };
}

async function createTask(
  workspaceSlug: string,
  email: string,
  projectId: string,
  assigneeId: string
): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': workspaceSlug, 'x-user-email': email },
    payload: { projectId, title: `counted work ${projectId.slice(0, 6)}`, assigneeId }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function comment(workspaceSlug: string, email: string, taskId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${taskId}/comments`,
    headers: { 'x-workspace-slug': workspaceSlug, 'x-user-email': email },
    payload: { body: 'counted comment' }
  });
  expect(response.statusCode).toBe(201);
}
