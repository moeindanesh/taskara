import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * Optimistic concurrency for a task body, asserted at the HTTP boundary.
 *
 * A description is the one task field that is a *document*: a caller reads it, edits part of it and
 * writes the whole thing back. `PATCH /tasks/:idOrKey` had no concurrency control, so two sessions
 * appending a line to one Effort's Decisions-so-far index each read the same body, each wrote their
 * own version of it, and the later write erased the earlier one with 200 on both.
 *
 * Labels were fixed by making the two writes commute (#45). A body cannot be: the index sits in the
 * middle of the document, between Notes and Not-yet-specified, so there is no delta an append could
 * carry that would land in the right place. What is left is to make the loss visible — `baseVersion`
 * on the REST path, 409 on a stale write — and to make it impossible to opt out of on the one body
 * where a lost line is unrecoverable.
 *
 * Every test here interleaves two writers rather than asserting one happy path, because a
 * concurrency fix that is only exercised sequentially is a claim rather than a guarantee.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceId: string;
  workspaceSlug: string;
  ownerEmail: string;
  projectId: string;
  sequence: number;
}

/** The shape of a real map body: the index is section three of five, not the tail. */
const mapBody = [
  '## Destination',
  '',
  'Taskara is the issue tracker for agent-driven engineering work.',
  '',
  '## Notes',
  '',
  'This map carries execution.',
  '',
  '## Decisions so far',
  '',
  '- [An earlier ticket](https://example.test/1) — settled.',
  '',
  '## Not yet specified',
  '',
  '- Whatever is left.',
  '',
  '## Out of scope',
  '',
  '- Not this.',
  ''
].join('\n');

describe('PATCH /tasks/:idOrKey body concurrency', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({ where: { email: fixture.ownerEmail } });
    await app.close();
  });

  test('rewriting an Effort body without baseVersion is refused before anything is written', async () => {
    const effort = await seedEffort();

    const response = await patch(effort.key, { description: `${mapBody}\n- blind write\n` });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('baseVersion');
    // The refusal has to name the fix, not just the rule — the caller is an agent that has to
    // repair its own command line without a human reading the message for it.
    expect(response.json().message).toContain('version');
    expect(await descriptionOf(effort.id)).toBe(mapBody);
  });

  test('a body write carrying the version it was based on succeeds and moves the version on', async () => {
    const effort = await seedEffort();
    const read = await view(effort.key);

    const response = await patch(effort.key, {
      description: appended(read.description, 'the only writer'),
      baseVersion: read.version
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(read.version + 1);
    expect(await descriptionOf(effort.id)).toContain('the only writer');
  });

  test('two sessions that both read, then both write, lose nothing: the second is refused', async () => {
    const effort = await seedEffort();

    // The real interleave, in the order it actually happens across two agent sessions. Both reads
    // land before either write, which is what makes each write stale with respect to the other.
    const sessionA = await view(effort.key);
    const sessionB = await view(effort.key);
    expect(sessionA.version).toBe(sessionB.version);

    const firstWrite = await patch(effort.key, {
      description: appended(sessionA.description, 'decision from session A'),
      baseVersion: sessionA.version
    });
    const secondWrite = await patch(effort.key, {
      description: appended(sessionB.description, 'decision from session B'),
      baseVersion: sessionB.version
    });

    expect(firstWrite.statusCode).toBe(200);
    expect(secondWrite.statusCode).toBe(409);

    // The whole point: session B's line is not in the body, and session B was told so. Before this
    // change both writes answered 200 and session A's line was the one that vanished.
    const stored = await descriptionOf(effort.id);
    expect(stored).toContain('decision from session A');
    expect(stored).not.toContain('decision from session B');
  });

  test('the 409 hands back the row to merge against, so the loser needs no second read', async () => {
    const effort = await seedEffort();
    const stale = await view(effort.key);

    await patch(effort.key, {
      description: appended(stale.description, 'the winning line'),
      baseVersion: stale.version
    });
    const lost = await patch(effort.key, {
      description: appended(stale.description, 'the losing line'),
      baseVersion: stale.version
    });

    expect(lost.statusCode).toBe(409);
    const conflict = lost.json();
    // Half of "re-read and retry" is a round trip the server can simply skip: it has just read the
    // row to discover the conflict, so it returns it.
    expect(conflict.version).toBe(stale.version + 1);
    expect(conflict.description).toContain('the winning line');
  });

  test('the loser can re-apply against the body the 409 returned, and then both lines are there', async () => {
    const effort = await seedEffort();
    const sessionA = await view(effort.key);
    const sessionB = await view(effort.key);

    await patch(effort.key, {
      description: appended(sessionA.description, 'decision from session A'),
      baseVersion: sessionA.version
    });
    const refused = await patch(effort.key, {
      description: appended(sessionB.description, 'decision from session B'),
      baseVersion: sessionB.version
    });
    expect(refused.statusCode).toBe(409);

    // The retry the design pushes onto the caller, run once against what the 409 carried. It has to
    // terminate and it has to keep both lines, or the failure is merely a different way to lose one.
    const fresh = refused.json();
    const retried = await patch(effort.key, {
      description: appended(fresh.description, 'decision from session B'),
      baseVersion: fresh.version
    });

    expect(retried.statusCode).toBe(200);
    const stored = await descriptionOf(effort.id);
    expect(stored).toContain('decision from session A');
    expect(stored).toContain('decision from session B');
  });

  test('two writes in flight at the same instant settle as one winner and one 409', async () => {
    const effort = await seedEffort();
    const read = await view(effort.key);

    // No await between them: both requests are inside `updateTask` before either transaction
    // commits, which is the window the pre-transaction conflict scan cannot see. Only a lock taken
    // on the row itself decides this one.
    const [first, second] = await Promise.all([
      patch(effort.key, {
        description: appended(read.description, 'simultaneous A'),
        baseVersion: read.version
      }),
      patch(effort.key, {
        description: appended(read.description, 'simultaneous B'),
        baseVersion: read.version
      })
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

    // Exactly one line landed. Two 200s here would mean a body was overwritten while its author was
    // told the write succeeded — the original bug, just harder to reproduce.
    const stored = await descriptionOf(effort.id);
    const landed = ['simultaneous A', 'simultaneous B'].filter((line) => stored?.includes(line));
    expect(landed).toHaveLength(1);
  });

  test('ten simultaneous writers produce exactly one winner', async () => {
    const effort = await seedEffort();
    const read = await view(effort.key);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        patch(effort.key, {
          description: appended(read.description, `writer ${index}`),
          baseVersion: read.version
        })
      )
    );

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(9);

    const stored = await descriptionOf(effort.id);
    const landed = Array.from({ length: 10 }, (_, index) => `writer ${index}`)
      .filter((line) => stored?.includes(line));
    expect(landed).toHaveLength(1);
  });

  test('baseVersion is general, not a description flag: a stale title write is refused too', async () => {
    const effort = await seedEffort();
    const read = await view(effort.key);

    await patch(effort.key, { title: 'Renamed once', baseVersion: read.version });
    const stale = await patch(effort.key, { title: 'Renamed twice', baseVersion: read.version });

    expect(stale.statusCode).toBe(409);
    expect((await view(effort.key)).title).toBe('Renamed once');
  });

  test('a stale version only conflicts on a field the other write touched', async () => {
    const effort = await seedEffort();
    const read = await view(effort.key);

    await patch(effort.key, {
      description: appended(read.description, 'a body change'),
      baseVersion: read.version
    });

    // The version has moved, but nothing this write depends on has. Failing here would make
    // `baseVersion` unusable: every caller would 409 on somebody else's unrelated edit and retry
    // into a queue, which is how an optimistic scheme turns into a pessimistic one by accident.
    const unrelated = await patch(effort.key, { status: 'DONE', baseVersion: read.version });

    expect(unrelated.statusCode).toBe(200);
    expect(await descriptionOf(effort.id)).toContain('a body change');
  });

  test('a work task keeps its blind body rewrite', async () => {
    const task = await seedWorkTask();

    // The requirement is scoped to `kind = EFFORT` because an Effort body is the index many sessions
    // append to, and a work task's description is a value one caller sets. If this ever starts
    // refusing, the scope has silently widened and every `taskara task edit --body` in the tracker
    // doc has become a two-step operation.
    const response = await patch(task.key, { description: 'set, not merged' });

    expect(response.statusCode).toBe(200);
    expect(await descriptionOf(task.id)).toBe('set, not merged');
  });

  test('two blind work-task rewrites separated in time still lose to each other', async () => {
    const task = await seedWorkTask();
    const read = await view(task.key);

    // The accepted limit, pinned rather than asserted as good. Both writers read the same body, and
    // because neither quoted a version the second one simply wins. Nothing here can tell them apart
    // — by the time the second request reads the row, the first has already committed, so the row
    // has not moved *during* either request. Only `baseVersion` reaches this case, and a work task
    // is not required to send it.
    const first = await patch(task.key, { description: `${read.description} — writer one` });
    const second = await patch(task.key, { description: `${read.description} — writer two` });

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(await descriptionOf(task.id)).toBe(`${read.description} — writer two`);
  });

  test('two blind writes in the same instant no longer both report success', async () => {
    const task = await seedWorkTask();

    // A behaviour change other callers will see, so it is asserted rather than left to chance.
    // `updateTask` has always re-checked the version inside its transaction, but it did so with an
    // unlocked read, so the check was a coin toss — the second writer usually read the pre-commit
    // version, passed, and overwrote the first. The row lock makes the guard mean what its comment
    // has always said. A 409 here is not new behaviour being invented; it is old behaviour that only
    // sometimes fired now firing every time.
    const [first, second] = await Promise.all([
      patch(task.key, { description: 'from writer one' }),
      patch(task.key, { description: 'from writer two' })
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(['from writer one', 'from writer two']).toContain((await descriptionOf(task.id)) ?? '');
  });

  test('an Effort body write through /sync is not forced to carry baseVersion', async () => {
    const effort = await seedEffort();

    // The requirement is on the REST path only. /sync is the web client's optimistic mutation queue,
    // it has its own conflict machinery and already sends `baseVersion` where it has one; making the
    // field mandatory there would reject a first-ever push that has no prior version to quote.
    const response = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: headers(),
      payload: {
        clientId: `body-concurrency-${crypto.randomUUID()}`,
        mutations: [
          {
            mutationId: crypto.randomUUID(),
            name: 'task.update',
            args: { idOrKey: effort.key, patch: { description: appended(mapBody, 'through sync') } }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].status).toBe('applied');
    expect(await descriptionOf(effort.id)).toContain('through sync');
  });

  test('baseVersion must be a version, not any number a caller happens to hold', async () => {
    const effort = await seedEffort();

    const response = await patch(effort.key, {
      description: appended(mapBody, 'nonsense version'),
      baseVersion: 'yesterday'
    });

    expect(response.statusCode).toBe(400);
    expect(await descriptionOf(effort.id)).toBe(mapBody);
  });
});

/** Append a line to the Decisions-so-far section, the way a resolving session does. */
function appended(body: string | null | undefined, line: string): string {
  const marker = '## Not yet specified';
  const text = body ?? '';
  const at = text.indexOf(marker);
  const entry = `- [${line}](https://example.test/x) — done.\n\n`;
  if (at === -1) return `${text}${entry}`;
  return `${text.slice(0, at)}${entry}${text.slice(at)}`;
}

async function view(key: string): Promise<{ version: number; description: string | null; title: string }> {
  const response = await app.inject({ method: 'GET', url: `/tasks/${key}`, headers: headers() });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function descriptionOf(id: string): Promise<string | null> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id }, select: { description: true } });
  return task.description;
}

function patch(key: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/tasks/${key}`, headers: headers(), payload });
}

function headers(): Record<string, string> {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail };
}

function seedEffort() {
  return seed({ kind: 'EFFORT', status: 'IN_PROGRESS', description: mapBody });
}

function seedWorkTask() {
  return seed({ kind: 'WORK', status: 'TODO', description: 'A body one caller sets.' });
}

async function seed(data: { kind: 'WORK' | 'EFFORT'; status: string; description: string }) {
  fixture.sequence += 1;
  return prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      sequence: fixture.sequence,
      key: `BCC-${fixture.sequence}`,
      title: `Concurrency subject ${fixture.sequence}`,
      kind: data.kind,
      status: data.status as never,
      description: data.description
    },
    select: { id: true, key: true }
  });
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `body-concurrency-owner-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Body concurrency owner' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Body concurrency workspace', slug: `body-concurrency-${suffix}` }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Body concurrency',
      keyPrefix: `BC${suffix.slice(0, 3).toUpperCase()}`
    }
  });

  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    ownerEmail,
    projectId: project.id,
    sequence: 0
  };
}
