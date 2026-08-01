import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import {
  EFFORT_DESCRIPTION_MAX_CHARS,
  WORK_DESCRIPTION_MAX_CHARS,
  taskDescriptionMaxChars
} from '@taskara/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * How much prose a Task description may hold, and in what unit — issue #44.
 *
 * The ceiling is per `kind`, because an Effort's description *is* the wayfinder map: its
 * Destination, its Notes and the Decisions-so-far index that grows by a line every time a ticket
 * closes. A work task's description is a work task's description, and it stays where it was.
 *
 * Two facts these tests pin, both of which are easy to get backwards:
 *
 *  1. **The unit is UTF-16 code units, not bytes.** `z.string().max()` counts `String.length`, the
 *     column is Postgres `text` (no `@db.VarChar`), and nothing between them counts bytes. So the
 *     Zod cap is the only bound that binds, and it binds in code units. A Persian body therefore
 *     gets roughly twice the *bytes* an English one does at the same ceiling — which is the right
 *     way round for a Persian-speaking workspace, and the opposite of what a byte cap would do.
 *
 *  2. **Over the limit is refused, never truncated.** A silently shortened map loses the tail of
 *     the Decisions index, which is the part a reader actually navigates by — a corruption that
 *     looks like a successful write. Every refusal test below re-reads the row to prove the stored
 *     body is untouched.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspace: { id: string; slug: string };
  projectId: string;
  ownerEmail: string;
  sequence: number;
}

/**
 * The live map body on GitHub measured 22,535 UTF-16 code units / 22,667 UTF-8 bytes while this
 * ticket was open, and grows by one Decisions-so-far entry per closed ticket. The number is fixed
 * here rather than fetched so the test says what it is defending.
 */
const LIVE_MAP_CHARS = 22_535;

describe('Task description size', () => {
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

  test('the ceilings are per kind, and the effort ceiling clears the live map with room to grow', () => {
    expect(taskDescriptionMaxChars('WORK')).toBe(WORK_DESCRIPTION_MAX_CHARS);
    expect(taskDescriptionMaxChars('EFFORT')).toBe(EFFORT_DESCRIPTION_MAX_CHARS);

    // The work ceiling is unchanged by this ticket. It is the only bound on the local-first
    // bootstrap payload — `sync.ts` ships up to 500 work descriptions per cold start — so raising
    // it is the thing this change deliberately does not do.
    expect(WORK_DESCRIPTION_MAX_CHARS).toBe(15_000);

    // The map does not fit under the work ceiling. That is the bug.
    expect(LIVE_MAP_CHARS).toBeGreaterThan(WORK_DESCRIPTION_MAX_CHARS);
    // ...and it fits under the effort ceiling with better than 2x headroom, so the effort can
    // finish — nine tickets were still open when this was chosen — without a second migration.
    expect(EFFORT_DESCRIPTION_MAX_CHARS).toBeGreaterThan(LIVE_MAP_CHARS * 2);
  });

  test('an effort holds a body the size of the live wayfinder map, byte for byte', async () => {
    const effort = await seedTask({ kind: 'EFFORT', status: 'IN_PROGRESS' });
    const body = mapBody(LIVE_MAP_CHARS);
    expect(body).toHaveLength(LIVE_MAP_CHARS);

    const response = await patch(effort.key, { description: body });
    expect(response.statusCode).toBe(200);

    const stored = await description(effort.id);
    expect(stored).toBe(body);
    expect(stored).toHaveLength(LIVE_MAP_CHARS);
  });

  test('an effort accepts exactly its ceiling and refuses one character more', async () => {
    const effort = await seedTask({ kind: 'EFFORT', status: 'IN_PROGRESS' });

    const atLimit = mapBody(EFFORT_DESCRIPTION_MAX_CHARS);
    expect((await patch(effort.key, { description: atLimit })).statusCode).toBe(200);
    expect(await description(effort.id)).toHaveLength(EFFORT_DESCRIPTION_MAX_CHARS);

    const overLimit = mapBody(EFFORT_DESCRIPTION_MAX_CHARS + 1);
    const refused = await patch(effort.key, { description: overLimit });
    expect(refused.statusCode).toBe(400);
    expect(refusalText(refused)).toContain(String(EFFORT_DESCRIPTION_MAX_CHARS));

    // Refused, not truncated: the body that was already there survives intact.
    expect(await description(effort.id)).toBe(atLimit);
  });

  test('a work task keeps the old ceiling, and the refusal names it', async () => {
    const task = await seedTask({});

    const atLimit = mapBody(WORK_DESCRIPTION_MAX_CHARS);
    expect((await patch(task.key, { description: atLimit })).statusCode).toBe(200);
    expect(await description(task.id)).toHaveLength(WORK_DESCRIPTION_MAX_CHARS);

    const overLimit = mapBody(WORK_DESCRIPTION_MAX_CHARS + 1);
    const refused = await patch(task.key, { description: overLimit });
    expect(refused.statusCode).toBe(400);
    expect(refusalText(refused)).toContain(String(WORK_DESCRIPTION_MAX_CHARS));

    expect(await description(task.id)).toBe(atLimit);
  });

  test('a work task is refused a map-sized body even though an effort would take it', async () => {
    const task = await seedTask({});
    const body = mapBody(LIVE_MAP_CHARS);

    const refused = await patch(task.key, { description: body });
    expect(refused.statusCode).toBe(400);
    // The number that must appear is the one that applies to *this* row, not the wider one.
    expect(refusalText(refused)).toContain(String(WORK_DESCRIPTION_MAX_CHARS));
    expect(await description(task.id)).toBeNull();
  });

  test('the ceiling counts code units, not bytes: a Persian body at the limit round-trips whole', async () => {
    const task = await seedTask({});

    // Persian prose runs about 1.9 UTF-8 bytes per UTF-16 code unit, so a body at the work ceiling
    // is roughly 29 KB in the column. It is accepted, which is the point: the cap does not charge a
    // Persian author double for the same document, and Postgres `text` never binds.
    const persian = persianBody(WORK_DESCRIPTION_MAX_CHARS);
    expect(persian).toHaveLength(WORK_DESCRIPTION_MAX_CHARS);
    expect(Buffer.byteLength(persian, 'utf8')).toBeGreaterThan(WORK_DESCRIPTION_MAX_CHARS * 1.5);

    expect((await patch(task.key, { description: persian })).statusCode).toBe(200);

    const stored = await description(task.id);
    expect(stored).toBe(persian);
    expect(Buffer.byteLength(stored ?? '', 'utf8')).toBe(Buffer.byteLength(persian, 'utf8'));
  });

  test('an effort takes a Persian map far past the work ceiling in either unit', async () => {
    const effort = await seedTask({ kind: 'EFFORT', status: 'IN_PROGRESS' });
    const persian = persianBody(EFFORT_DESCRIPTION_MAX_CHARS);

    expect((await patch(effort.key, { description: persian })).statusCode).toBe(200);
    const stored = await description(effort.id);
    expect(stored).toBe(persian);
    expect(Buffer.byteLength(stored ?? '', 'utf8')).toBeGreaterThan(100_000);
  });

  test('the sync push path enforces the same per-kind ceiling and names it in the rejection', async () => {
    const task = await seedTask({});
    const effort = await seedTask({ kind: 'EFFORT', status: 'IN_PROGRESS' });
    const body = mapBody(LIVE_MAP_CHARS);

    // The web app writes through /sync/push, not PATCH. A batch push answers 200 with a per-mutation
    // verdict rather than a status code, so the limit has to be named in the rejection message —
    // otherwise the editor can only tell the author "something was wrong".
    const rejected = await push('task.update', { idOrKey: task.key, patch: { description: body } });
    expect(rejected.status).toBe('rejected');
    expect(rejected.error.message).toContain(String(WORK_DESCRIPTION_MAX_CHARS));
    expect(await description(task.id)).toBeNull();

    const applied = await push('task.update', { idOrKey: effort.key, patch: { description: body } });
    expect(applied.status).toBe('applied');
    expect(await description(effort.id)).toBe(body);
  });

  test('a body past the outer ceiling is still refused with the number, on both write paths', async () => {
    const effort = await seedTask({ kind: 'EFFORT', status: 'IN_PROGRESS' });
    const absurd = mapBody(EFFORT_DESCRIPTION_MAX_CHARS + 5_000);

    const refused = await patch(effort.key, { description: absurd });
    expect(refused.statusCode).toBe(400);
    expect(refusalText(refused)).toContain(String(EFFORT_DESCRIPTION_MAX_CHARS));

    const rejected = await push('task.update', { idOrKey: effort.key, patch: { description: absurd } });
    expect(rejected.status).toBe('rejected');
    expect(rejected.error.message).toContain(String(EFFORT_DESCRIPTION_MAX_CHARS));

    expect(await description(effort.id)).toBeNull();
  });

  test('the create ceiling follows the kind of the row being created', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(),
      payload: {
        projectId: fixture.projectId,
        title: 'Created with an over-long body',
        description: mapBody(WORK_DESCRIPTION_MAX_CHARS + 1)
      }
    });

    expect(created.statusCode).toBe(400);
    expect(refusalText(created)).toContain(String(WORK_DESCRIPTION_MAX_CHARS));

    // This half was written to fail the moment `kind` became writable (#46), because until then
    // create hardcoded the work ceiling on the grounds that no row it made could be an effort. It
    // can now, so what it pins is the other side of that bargain: a map-sized body has to fit
    // through create, or an effort's ceiling is reachable only through a later PATCH.
    const effort = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(),
      payload: {
        projectId: fixture.projectId,
        title: 'An effort minted with its map',
        kind: 'EFFORT',
        status: 'IN_PROGRESS',
        description: mapBody(LIVE_MAP_CHARS)
      }
    });
    expect(effort.statusCode).toBe(201);
    expect(effort.json().kind).toBe('EFFORT');
    expect(await description(effort.json().id)).toHaveLength(LIVE_MAP_CHARS);
  });
});

/**
 * A body of exactly `chars` UTF-16 code units, shaped like a map rather than one repeated letter:
 * newlines and markdown punctuation are what a real description carries, and a body of a single
 * repeated character would let a length check pass that a tokenizing one would not.
 */
function mapBody(chars: number): string {
  const unit = '- [A decision that was taken](https://example.test/x) — shipped.\n';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/** The same, in Persian: every letter is a 2-byte UTF-8 sequence in a single UTF-16 code unit. */
function persianBody(chars: number): string {
  const unit = 'نقشه‌ی این تلاش در تسکارا نگهداری می‌شود و با هر تصمیم تازه یک سطر بلندتر می‌شود.\n';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function authHeaders(): Record<string, string> {
  return { 'x-workspace-slug': fixture.workspace.slug, 'x-user-email': fixture.ownerEmail };
}

async function patch(key: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/tasks/${key}`, headers: authHeaders(), payload });
}

interface PushResult {
  status: string;
  error: { message: string };
}

async function push(name: string, args: Record<string, unknown>): Promise<PushResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: authHeaders(),
    payload: {
      clientId: `desc-size-${crypto.randomUUID()}`,
      mutations: [{ mutationId: crypto.randomUUID(), name, args }]
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json().results[0] as PushResult;
}

/**
 * Every refusal must name its limit somewhere a caller can read it. The REST handler answers
 * `{ message, issues }` for a schema failure and `{ message }` for a service one, so both are
 * searched rather than assuming which layer caught it.
 */
function refusalText(response: { json: () => unknown }): string {
  return JSON.stringify(response.json());
}

async function description(taskId: string): Promise<string | null> {
  return (await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { description: true }
  })).description;
}

async function seedTask(data: { kind?: 'WORK' | 'EFFORT'; status?: string }) {
  fixture.sequence += 1;
  const key = `DSZ-${fixture.sequence}`;
  return prisma.task.create({
    data: {
      workspaceId: fixture.workspace.id,
      projectId: fixture.projectId,
      sequence: fixture.sequence,
      key,
      title: `Body size subject ${fixture.sequence}`,
      kind: data.kind ?? 'WORK',
      status: (data.status ?? 'TODO') as never
    },
    select: { id: true, key: true }
  });
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `desc-size-owner-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Body size owner' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Body size workspace', slug: `desc-size-${suffix}` }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Body size', keyPrefix: 'DSZ' }
  });

  return { workspace, projectId: project.id, ownerEmail, sequence: 0 };
}
