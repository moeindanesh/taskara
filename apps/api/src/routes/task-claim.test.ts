import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * The mutual-exclusion primitive the agent surface rests on, asserted at the HTTP boundary.
 *
 * Issue #33 on this effort was implemented twice, in parallel, by two sessions — the convention was
 * that you read the assignee before starting, and nothing enforced it. `POST /tasks/:key/claim` is
 * the enforcement: one conditional `updateMany` on `assigneeId: null`, and the loser is told who
 * holds it rather than left to infer anything from a stale read.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  firstEmail: string;
  secondEmail: string;
  firstId: string;
  secondId: string;
  projectId: string;
  projectKeyPrefix: string;
}

describe('POST /tasks/:idOrKey/claim', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({ where: { email: { in: [fixture.firstEmail, fixture.secondEmail] } } });
    await app.close();
  });

  test('claiming an unassigned task assigns it to the caller', async () => {
    const task = await createTask('there for the taking');

    const response = await claim(task.key, fixture.firstEmail);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { key: string; assignee: { id: string } | null };
    expect(body.key).toBe(task.key);
    expect(body.assignee?.id).toBe(fixture.firstId);
  });

  test('claiming a task somebody else holds is refused, and names the holder', async () => {
    const task = await createTask('already spoken for');
    expect((await claim(task.key, fixture.firstEmail)).statusCode).toBe(200);

    const response = await claim(task.key, fixture.secondEmail);

    expect(response.statusCode).toBe(409);
    const body = response.json() as { message: string; assignee: { id: string; name: string } | null };
    // The holder, in the failure itself. A loser that has to go and look is a loser that can decide
    // the claim was stale — which is precisely how #33 came to be built twice.
    expect(body.message).toContain('First claimant');
    expect(body.assignee?.id).toBe(fixture.firstId);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.assigneeId).toBe(fixture.firstId);
  });

  test('exactly one of two simultaneous claims wins', async () => {
    const task = await createTask('contested by two agents at once');

    const responses = await Promise.all([
      claim(task.key, fixture.firstEmail),
      claim(task.key, fixture.secondEmail)
    ]);

    const codes = responses.map((response) => response.statusCode).sort();
    expect(codes).toEqual([200, 409]);

    // And the winner in the reply is the winner in the database — not merely "someone won".
    const winner = responses.find((response) => response.statusCode === 200);
    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.assigneeId).not.toBeNull();
    expect((winner?.json() as { assignee: { id: string } }).assignee.id).toBe(String(stored.assigneeId));
  });

  test('re-claiming a task you already hold reports that you took nothing', async () => {
    const task = await createTask('claimed twice by one agent');
    expect((await claim(task.key, fixture.firstEmail)).statusCode).toBe(200);

    // Not idempotent, on purpose. "You hold this" and "you just took this" are different answers,
    // and an orchestrator re-running a script must not read the first as the second.
    const response = await claim(task.key, fixture.firstEmail);

    expect(response.statusCode).toBe(409);
    expect((response.json() as { assignee: { id: string } }).assignee.id).toBe(fixture.firstId);
  });

  test('an effort cannot be claimed, and says so instead of tripping a CHECK constraint', async () => {
    const effort = await prisma.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        // A real key for the fixture's own project. Task lookup upper-cases the key it is given,
        // so a hand-rolled lowercase one matches only when its random part happens to be all digits.
        key: `${fixture.projectKeyPrefix}-9001`,
        sequence: 9001,
        title: 'A map, not a unit of work',
        kind: 'EFFORT',
        status: 'IN_PROGRESS',
        reporterId: fixture.firstId
      }
    });

    const response = await claim(effort.key, fixture.firstEmail);

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('effort');
    const stored = await prisma.task.findUniqueOrThrow({ where: { id: effort.id } });
    expect(stored.assigneeId).toBeNull();
  });

  test('claiming a task that does not exist is a 404, not a silent success', async () => {
    const response = await claim('NOPE-404', fixture.firstEmail);
    expect(response.statusCode).toBe(404);
  });
});

function claim(key: string, email: string) {
  return app.inject({
    method: 'POST',
    url: `/tasks/${key}/claim`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': email },
    payload: {}
  });
}

async function createTask(title: string): Promise<{ id: string; key: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.firstEmail },
    payload: { projectId: fixture.projectId, title }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const firstEmail = `claim-first-${suffix}@example.test`;
  const secondEmail = `claim-second-${suffix}@example.test`;
  const first = await prisma.user.create({ data: { email: firstEmail, name: 'First claimant' } });
  const second = await prisma.user.create({ data: { email: secondEmail, name: 'Second claimant' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Claim workspace', slug: `claim-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: first.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: second.id, role: 'MEMBER' }
    ]
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Claim', keyPrefix: `CM${suffix.slice(0, 3).toUpperCase()}` }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    firstEmail,
    secondEmail,
    firstId: first.id,
    secondId: second.id,
    projectId: project.id,
    projectKeyPrefix: project.keyPrefix
  };
}
