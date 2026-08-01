import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import { EFFORT_DESCRIPTION_MAX_CHARS, WORK_DESCRIPTION_MAX_CHARS } from '@taskara/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Creating an Effort over HTTP — issue #46.
 *
 * `POST /tasks` could only ever mint `WORK`, so the one row the whole tracker effort has to produce
 * first — the Effort that holds the map — was unreachable through the API. Three things have to be
 * true at once for that to change, and each is easy to land without the others:
 *
 *  1. `kind` is writable, and **absent means `WORK`**. Every caller that exists today omits it — the
 *     web app, the Mattermost bot, the menubar app, every internal path that mints a task from a
 *     meeting or a check-in — so the default is the entire compatibility story.
 *  2. The description ceiling on create follows the kind. A map body is 22,000-odd characters; if
 *     create keeps the work ceiling, an effort can only reach its own ceiling through a later
 *     `PATCH`, which makes creating one a two-step dance for no reason.
 *  3. The two `CHECK` constraints from #19 answer as **400s that name the field**. They stay in the
 *     database — they are the guarantee — but a caller must never meet one as a raw Postgres string.
 *     An agent pasting a command needs to be told what it did wrong.
 *
 * Every constraint test below has a twin that writes the same row straight through Prisma and
 * asserts the database still refuses it. The app-layer message is the diagnosis; it must not quietly
 * become the only guard.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspace: { id: string; slug: string };
  projectId: string;
  ownerId: string;
  ownerEmail: string;
  milestoneId: string;
  cycleId: string;
  parentTaskId: string;
  sequence: number;
}

const EFFORT_FIELDS_CONSTRAINT = 'Task_effort_has_no_work_fields';
const EFFORT_STATUS_CONSTRAINT = 'Task_effort_status';

describe('creating an effort through the API', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspace.id } });
    await prisma.user.deleteMany({ where: { email: fixture.ownerEmail } });
    await app.close();
  });

  test('POST /tasks mints an effort when asked, with a real key in the project it concerns', async () => {
    const created = await post({
      title: 'Taskara as the agent issue tracker',
      kind: 'EFFORT',
      status: 'IN_PROGRESS',
      description: '## Destination\n\nThe tracker, charted.'
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.kind).toBe('EFFORT');
    expect(body.status).toBe('IN_PROGRESS');
    expect(body.key).toMatch(/^CEF-\d+$/);
    expect(body.projectId).toBe(fixture.projectId);

    const stored = await prisma.task.findUniqueOrThrow({
      where: { id: body.id },
      select: { kind: true, status: true, description: true, assigneeId: true, parentId: true }
    });
    expect(stored.kind).toBe('EFFORT');
    expect(stored.description).toBe('## Destination\n\nThe tracker, charted.');
    expect(stored.assigneeId).toBeNull();
    expect(stored.parentId).toBeNull();
  });

  test('a caller that says nothing about kind still gets work', async () => {
    // The load-bearing half. Nothing in the web app, the bot or the menubar sends `kind`, and each
    // of them creates ordinary work that people are measured on. A default of EFFORT — or no
    // default, making the field required — would silently reclassify every task the team files.
    const created = await post({ title: 'An ordinary task' });

    expect(created.statusCode).toBe(201);
    expect(created.json().kind).toBe('WORK');
    // Its work fields still work: the default is a default, not a narrowing.
    const assigned = await post({ title: 'Assigned work', assigneeId: fixture.ownerId, weight: 3 });
    expect(assigned.statusCode).toBe(201);
    expect(assigned.json().kind).toBe('WORK');
    expect(assigned.json().assigneeId).toBe(fixture.ownerId);
  });

  test('create carries the whole map body, because the ceiling follows the kind', async () => {
    // #44 raised the effort ceiling to 60,000 but could only reach it through PATCH: create
    // hardcoded the work ceiling on the grounds that no row it made could be an effort. That stops
    // being true above, so the map body has to fit through create or minting one stays a two-step.
    const map = mapBody(LIVE_MAP_CHARS);
    const created = await post({ title: 'A map that arrives whole', kind: 'EFFORT', status: 'IN_PROGRESS', description: map });

    expect(created.statusCode).toBe(201);
    expect(await description(created.json().id)).toBe(map);
  });

  test('the create ceiling is the row\'s own, and the refusal names the number that applies', async () => {
    const workOverflow = await post({ title: 'Work with a map-sized body', description: mapBody(LIVE_MAP_CHARS) });
    expect(workOverflow.statusCode).toBe(400);
    expect(refusalText(workOverflow)).toContain(String(WORK_DESCRIPTION_MAX_CHARS));
    // The number a work caller is told must be its own, not the wider one it cannot have.
    expect(refusalText(workOverflow)).not.toContain(String(EFFORT_DESCRIPTION_MAX_CHARS));

    const effortOverflow = await post({
      title: 'An effort past its own ceiling',
      kind: 'EFFORT',
      status: 'IN_PROGRESS',
      description: mapBody(EFFORT_DESCRIPTION_MAX_CHARS + 1)
    });
    expect(effortOverflow.statusCode).toBe(400);
    expect(refusalText(effortOverflow)).toContain(String(EFFORT_DESCRIPTION_MAX_CHARS));

    // Refused, not truncated, and nothing half-made is left behind — a create that fails must leave
    // no row at all, or the caller retries into a duplicate.
    expect(
      await prisma.task.count({
        where: { workspaceId: fixture.workspace.id, title: { in: ['Work with a map-sized body', 'An effort past its own ceiling'] } }
      })
    ).toBe(0);
  });

  describe('Task_effort_has_no_work_fields', () => {
    const workFields = (): Array<[string, Record<string, unknown>]> => [
      ['assigneeId', { assigneeId: fixture.ownerId }],
      ['dueAt', { dueAt: new Date().toISOString() }],
      ['weight', { weight: 3 }],
      ['milestoneId', { milestoneId: fixture.milestoneId }],
      ['cycleId', { cycleId: fixture.cycleId }],
      ['parentId', { parentId: fixture.parentTaskId }]
    ];

    test('each forbidden field is a 400 that names the field and says why', async () => {
      for (const [field, patch] of workFields()) {
        const refused = await post({ title: `Effort with ${field}`, kind: 'EFFORT', status: 'IN_PROGRESS', ...patch });

        expect(`${field}: ${refused.statusCode}`).toBe(`${field}: 400`);
        const message = refused.json().message as string;
        // The field, so a caller knows which argument to drop...
        expect(`${field}: ${message}`).toContain(field);
        // ...and only that field, so the name is a finding rather than a recital of the whole rule.
        for (const [other] of workFields()) {
          if (other === field || other.startsWith(field)) continue;
          expect(`${field}: ${message}`).not.toContain(other);
        }
        // ...and the reason, so it knows this is a rule about efforts and not a typo.
        expect(message.toLowerCase()).toContain('effort');
        // Not the raw Postgres string. This is the whole point of the ticket: an agent that pasted a
        // command gets told what it did wrong, not handed a constraint name and a row dump.
        expect(message).not.toContain(EFFORT_FIELDS_CONSTRAINT);
        expect(message).not.toContain('violates check constraint');
      }

      expect(
        await prisma.task.count({ where: { workspaceId: fixture.workspace.id, title: { startsWith: 'Effort with ' } } })
      ).toBe(0);
    });

    test('one refusal names every field the caller sent, not just the first', async () => {
      // An agent pasting a command should learn everything wrong with it in one round trip.
      const refused = await post({
        title: 'Effort dressed as work',
        kind: 'EFFORT',
        status: 'IN_PROGRESS',
        assigneeId: fixture.ownerId,
        dueAt: new Date().toISOString(),
        weight: 2
      });

      expect(refused.statusCode).toBe(400);
      const message = refused.json().message as string;
      expect(message).toContain('assigneeId');
      expect(message).toContain('dueAt');
      expect(message).toContain('weight');
    });

    test('an explicit null is not a carried field', async () => {
      // `weight` is the one of the six that is nullable, and a client that serialises an empty form
      // sends `null` rather than omitting the key. Null *is* the absence the constraint wants, so
      // reading it as a violation would refuse a legitimate effort over a serialisation detail.
      const created = await post({ title: 'An effort with an explicit null weight', kind: 'EFFORT', status: 'IN_PROGRESS', weight: null });

      expect(created.statusCode).toBe(201);
      expect(created.json().kind).toBe('EFFORT');
    });

    test('the database still refuses the same row written straight through Prisma', async () => {
      // The 400 above is the diagnosis. The constraint is the guarantee, and it has to stay the
      // thing that is actually load-bearing: ten of the thirteen write paths never reach this
      // service (#19), so an app-layer message alone would be a sieve.
      const error = await captureError(
        prisma.task.create({ data: effortRow({ title: 'Smuggled assignee', assigneeId: fixture.ownerId }) })
      );
      expect(String(error?.message)).toContain(EFFORT_FIELDS_CONSTRAINT);
    });

    test('a work task is untouched by the rule — it may carry all six', async () => {
      const created = await post({
        title: 'Fully loaded work',
        assigneeId: fixture.ownerId,
        dueAt: new Date().toISOString(),
        weight: 2,
        milestoneId: fixture.milestoneId,
        cycleId: fixture.cycleId,
        parentId: fixture.parentTaskId
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().kind).toBe('WORK');
      expect(created.json().assigneeId).toBe(fixture.ownerId);
    });
  });

  describe('Task_effort_status', () => {
    test('a status an effort cannot hold is a 400 that names the field and the three that work', async () => {
      for (const status of ['TODO', 'BACKLOG', 'IN_REVIEW', 'BLOCKED'] as const) {
        const refused = await post({ title: `Effort ${status}`, kind: 'EFFORT', status });

        expect(`${status}: ${refused.statusCode}`).toBe(`${status}: 400`);
        const message = refused.json().message as string;
        expect(`${status}: ${message}`).toContain('status');
        expect(message).toContain('IN_PROGRESS');
        expect(message).not.toContain(EFFORT_STATUS_CONSTRAINT);
      }
    });

    test('the default status is the one an effort cannot have, so the refusal has to say so', async () => {
      // `status` defaults to TODO for every task, and an effort may not be TODO. A caller that omits
      // status therefore always lands here, which makes this the first message anyone minting an
      // effort will read — it has to name the fix rather than merely refuse.
      const refused = await post({ title: 'An effort with no status', kind: 'EFFORT' });

      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toContain('IN_PROGRESS');
    });

    test('the three statuses an effort may hold all go through, completedAt included', async () => {
      for (const status of ['IN_PROGRESS', 'DONE', 'CANCELED'] as const) {
        const created = await post({ title: `Effort ok ${status}`, kind: 'EFFORT', status });
        expect(`${status}: ${created.statusCode}`).toBe(`${status}: 201`);
        expect(created.json().status).toBe(status);
      }

      // DONE sets completedAt on the ordinary path, and #19 left that writable on purpose: an
      // effort genuinely completes, and forbidding it would leave no honest way to close one.
      const done = await post({ title: 'A finished effort', kind: 'EFFORT', status: 'DONE' });
      expect(done.statusCode).toBe(201);
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: done.json().id }, select: { status: true } })).status
      ).toBe('DONE');
    });

    test('the database still refuses the same status written straight through Prisma', async () => {
      const error = await captureError(
        prisma.task.create({ data: effortRow({ title: 'Smuggled backlog effort', status: 'BACKLOG' }) })
      );
      expect(String(error?.message)).toContain(EFFORT_STATUS_CONSTRAINT);
    });
  });

  describe('the sync create path', () => {
    test('/sync/push mints an effort through the same schema and the same service', async () => {
      // The web app writes through /sync/push, not POST /tasks. `task.create` parses the same
      // `createTaskSchema` and calls the same `createTask`, so it inherits the default, the widened
      // ceiling and both guards — this pins that it is one path and not two that drifted.
      const applied = await push({
        title: 'An effort pushed from a client',
        kind: 'EFFORT',
        status: 'IN_PROGRESS',
        description: mapBody(LIVE_MAP_CHARS)
      });

      expect(applied.status).toBe('applied');
      expect(applied.entity.kind).toBe('EFFORT');
      expect(await description(applied.entity.id)).toHaveLength(LIVE_MAP_CHARS);
    });

    test('a push that omits kind still creates work', async () => {
      const applied = await push({ title: 'Ordinary pushed work' });
      expect(applied.status).toBe('applied');
      expect(applied.entity.kind).toBe('WORK');
    });

    test('both constraints reach a pushing client as a named rejection, not a status code', async () => {
      // A batch push answers 200 with a per-mutation verdict, so a raw Postgres string here is worse
      // than on REST: there is no status code to read either, only this message.
      const fields = await push({
        title: 'Pushed effort with an assignee',
        kind: 'EFFORT',
        status: 'IN_PROGRESS',
        assigneeId: fixture.ownerId
      });
      expect(fields.status).toBe('rejected');
      expect(fields.error.message).toContain('assigneeId');
      expect(fields.error.message).not.toContain('violates check constraint');

      const status = await push({ title: 'Pushed effort in backlog', kind: 'EFFORT', status: 'BACKLOG' });
      expect(status.status).toBe('rejected');
      expect(status.error.message).toContain('IN_PROGRESS');
      expect(status.error.message).not.toContain(EFFORT_STATUS_CONSTRAINT);

      expect(
        await prisma.task.count({ where: { workspaceId: fixture.workspace.id, title: { startsWith: 'Pushed effort ' } } })
      ).toBe(0);
    });
  });
});

/**
 * The live map body measured 22,535 UTF-16 code units while #44 was open — over the work ceiling,
 * comfortably under the effort one. Shaped like a map rather than one repeated letter, so a length
 * check that happens to pass on `'a'.repeat(n)` is not what is being proven.
 */
const LIVE_MAP_CHARS = 22_535;

function mapBody(chars: number): string {
  const unit = '- [A decision that was taken](https://example.test/x) — shipped.\n';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/** A refusal must name its limit somewhere a caller can read it; which layer caught it is not the point. */
function refusalText(response: { json: () => unknown }): string {
  return JSON.stringify(response.json());
}

async function description(taskId: string): Promise<string | null> {
  return (await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { description: true } })).description;
}

function authHeaders(): Record<string, string> {
  return { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': fixture.ownerEmail };
}

async function post(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/tasks',
    headers: authHeaders(),
    payload: { projectId: fixture.projectId, ...payload }
  });
}

interface PushResult {
  status: string;
  entity: { id: string; kind: string };
  error: { message: string };
}

async function push(args: Record<string, unknown>): Promise<PushResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: authHeaders(),
    payload: {
      clientId: `create-effort-${crypto.randomUUID()}`,
      mutations: [{
        mutationId: crypto.randomUUID(),
        name: 'task.create',
        args: { projectId: fixture.projectId, ...args }
      }]
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json().results[0] as PushResult;
}

/** A row the API would refuse, written straight at Postgres to prove the constraint is still there. */
function effortRow(overrides: Record<string, unknown>) {
  fixture.sequence += 1;
  return {
    workspaceId: fixture.workspace.id,
    projectId: fixture.projectId,
    sequence: fixture.sequence,
    key: `CEF-${fixture.sequence}`,
    kind: 'EFFORT',
    status: 'IN_PROGRESS',
    ...overrides
  } as never;
}

async function captureError(work: Promise<unknown>): Promise<Error | undefined> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `create-effort-owner-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Effort owner' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Create effort workspace', slug: `create-effort-${suffix}` }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Create effort', keyPrefix: 'CEF' }
  });
  const milestone = await prisma.milestone.create({
    data: { workspaceId: workspace.id, projectId: project.id, name: 'Scope', kind: 'FEATURE' },
    select: { id: true }
  });
  const cycle = await prisma.cycle.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Cycle 1',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 7 * 86_400_000)
    },
    select: { id: true }
  });
  const parentTask = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      sequence: 900,
      key: 'CEF-900',
      title: 'A parent work task'
    },
    select: { id: true }
  });

  return {
    workspace,
    projectId: project.id,
    ownerId: owner.id,
    ownerEmail,
    milestoneId: milestone.id,
    cycleId: cycle.id,
    parentTaskId: parentTask.id,
    sequence: 900
  };
}
