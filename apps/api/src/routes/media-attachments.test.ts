import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

/**
 * The attachment surface at the HTTP boundary, which had none before object storage arrived.
 *
 * Every assertion below about a CDN key is a description of behaviour that predates this file — the
 * point of writing them down now is that adding a second storage backend makes them a claim rather
 * than a fact. `services/media.test.ts` pins the URL builder; this pins what a client actually gets
 * back from the three registration endpoints and, more importantly, from the *read* path, where a
 * task's attachments are serialized by a different function.
 *
 * The configuration under test is the one the `test:api` script sets, and it is not an arbitrary
 * choice: a CDN base and a bucket read base, with no bucket credentials. That is precisely the
 * state every deployment adopting object storage passes through, and it separates the two questions
 * the module keeps apart — an object can be *read* from the bucket while no upload can be *minted*.
 */

let app: FastifyInstance;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerEmail: string;
  projectId: string;
}

interface Attachment {
  id: string;
  name: string;
  object: string;
  url: string;
  storage?: string;
  documentId?: string | null;
}

// File-scoped, not describe-scoped: the second describe below runs after the first one's hooks, so
// tearing the app down inside either of them closes it out from under the other.
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

describe('attachment registration resolves each row against its own backend', () => {
  test('a bare CDN key registers and resolves exactly as it always did', async () => {
    const task = await createTask('has a bare cdn key');

    const attachment = await register(task.key, { object: 'note.png', name: 'Note' });

    expect(attachment.url).toBe('https://cdn.example.test/v1/media/note.png');
    expect(attachment.object).toBe('note.png');
  });

  test('a key already carrying the CDN route segment is not given a second one', async () => {
    const task = await createTask('has a prefixed cdn key');

    const attachment = await register(task.key, { object: 'v1/media/note.png', name: 'Note' });

    expect(attachment.url).toBe('https://cdn.example.test/v1/media/note.png');
  });

  test('a documentId is enough on its own, and becomes the object', async () => {
    const task = await createTask('has a document id only');

    const attachment = await register(task.key, { documentId: 'doc-only', name: 'Document' });

    expect(attachment.object).toBe('doc-only');
    expect(attachment.url).toBe('https://cdn.example.test/v1/media/doc-only');
  });

  test('an object that is already an absolute url is stored and returned unchanged', async () => {
    const task = await createTask('has an absolute object');

    const attachment = await register(task.key, { url: 'https://assets.example.test/legacy.png', name: 'Legacy' });

    expect(attachment.url).toBe('https://assets.example.test/legacy.png');
  });

  test('a bucket registration resolves against the bucket and records where it went', async () => {
    const task = await createTask('has a bucket object');

    const attachment = await register(task.key, { object: 'kQ7fN2.png', name: 'Screenshot', storage: 'S3' });

    expect(attachment.url).toBe('https://s3.example.test/taskara-media/kQ7fN2.png');
    expect(attachment.storage).toBe('S3');
  });

  test('a registration that names no backend is recorded as CDN, not as unknown', async () => {
    const task = await createTask('names no backend');

    const attachment = await register(task.key, { object: 'silent.png', name: 'Silent' });

    // The column default and the serializer default have to agree with each other and with what
    // every row written before this column existed means. A client that predates object storage
    // sends exactly this body.
    expect(attachment.storage).toBe('CDN');
  });

  test('the same task can hold both backends at once, each resolving to its own service', async () => {
    // The whole compatibility argument in one assertion. If the backend were a deployment setting
    // rather than a column, one of these two URLs would necessarily be wrong -- and it would be
    // wrong retroactively, for every attachment the workspace had ever stored.
    const task = await createTask('holds both backends');
    await register(task.key, { object: 'from-the-cdn.png', name: 'Old' });
    await register(task.key, { object: 'inTheBucket.png', name: 'New', storage: 'S3' });

    const listed = await list(task.key);

    expect(listed.map((attachment) => attachment.url).sort()).toEqual([
      'https://cdn.example.test/v1/media/from-the-cdn.png',
      'https://s3.example.test/taskara-media/inTheBucket.png'
    ]);
  });

  test('reading the task back resolves the same way the registration did', async () => {
    // A different function serializes here (`serializeTaskForResponse` -> `serializeTaskAttachment`)
    // than the one that answered the POST, and it is the one reached by ~30 read paths. A fix
    // applied only where attachments are created would pass every test above this one.
    const task = await createTask('is read back');
    await register(task.key, { object: 'onRead.png', name: 'Read', storage: 'S3' });
    await register(task.key, { object: 'onReadCdn.png', name: 'ReadCdn' });

    const response = await app.inject({ method: 'GET', url: `/tasks/${task.key}`, headers: headers() });
    const body = response.json() as { attachments: Attachment[] };

    expect(response.statusCode).toBe(200);
    expect(body.attachments.map((attachment) => attachment.url).sort()).toEqual([
      'https://cdn.example.test/v1/media/onReadCdn.png',
      'https://s3.example.test/taskara-media/onRead.png'
    ]);
  });

  test('a comment attachment resolves against its backend too', async () => {
    const task = await createTask('has a comment with a file');
    const comment = await createComment(task.key, 'here is the screenshot');

    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${task.key}/comments/${comment.id}/attachments`,
      headers: headers(),
      payload: { object: 'onAComment.png', name: 'Comment file', storage: 'S3' }
    });

    expect(response.statusCode).toBe(201);
    expect((response.json() as Attachment).url).toBe('https://s3.example.test/taskara-media/onAComment.png');
  });

  test('a knowledge page attachment resolves against its backend, on both branches', async () => {
    // The third registration endpoint, and the one most likely to be left behind: it lives in a
    // different service (`services/knowledge.ts`) with its own serializer and its own create call,
    // so a change applied only to `task-attachments.ts` passes every other test in this file while
    // leaving the knowledge base silently CDN-only.
    const page = await createKnowledgePage();

    const [bucket, cdn] = await Promise.all([
      registerKnowledgeAttachment(page.id, { object: 'onAPage.png', name: 'Diagram', storage: 'S3' }),
      registerKnowledgeAttachment(page.id, { object: 'onAPageCdn.png', name: 'Old diagram' })
    ]);

    expect(bucket.url).toBe('https://s3.example.test/taskara-media/onAPage.png');
    expect(bucket.storage).toBe('S3');
    expect(cdn.url).toBe('https://cdn.example.test/v1/media/onAPageCdn.png');
    expect(cdn.storage).toBe('CDN');
  });

  test('a bucket key that walks out of the bucket is refused rather than stored', async () => {
    const task = await createTask('is handed a traversal key');

    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${task.key}/attachments`,
      headers: headers(),
      payload: { object: '../../etc/passwd', name: 'Escape', storage: 'S3' }
    });

    expect(response.statusCode).toBe(400);
    expect(await list(task.key)).toHaveLength(0);
  });
});

/**
 * Minting an upload is a different question from resolving one, and this suite answers no to the
 * first while answering yes to the second.
 *
 * A deployment with a bucket read base but no credentials -- which is what `test:api` configures --
 * serves every stored object and can sign nothing. The 503 here is not an error path bolted on for
 * completeness: it is the entire mechanism by which the web client discovers it should keep using
 * the CDN, so it has to be exactly this status.
 */
describe('POST /storage/uploads', () => {
  test('answers 503 when no bucket credentials are configured, which is what makes clients fall back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/storage/uploads',
      headers: headers(),
      payload: { name: 'photo.png', mimeType: 'image/png', sizeBytes: 1024 }
    });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { message: string }).message).toMatch(/not configured/);
  });

  test('still answers 503 for a file larger than the upload limit, rather than 413', async () => {
    // The regression this guards is a backward-compatibility break, not a wrong status code. The
    // size gate used to run first, so on a CDN-only deployment a 40MB video answered 413 -- and 413
    // is not a status the web client falls back on, so the upload failed outright. Before this
    // change `TASKARA_UPLOAD_MAX_BYTES` never applied to attachment bytes at all: they went from
    // the browser straight to the CDN and never passed through the API. A limit that has never
    // applied must not start applying to a deployment that has not opted into object storage.
    const response = await app.inject({
      method: 'POST',
      url: '/storage/uploads',
      headers: headers(),
      payload: { name: 'huge.mp4', mimeType: 'video/mp4', sizeBytes: 40 * 1024 * 1024 }
    });

    expect(response.statusCode).toBe(503);
  });

  test('answers 503 for a body it could not have parsed, because there is nowhere to put a file either way', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/storage/uploads',
      headers: headers(),
      payload: { sizeBytes: 3_000_000_000 }
    });

    expect(response.statusCode).toBe(503);
  });

  test('requires a caller, because minting an object consumes somebody else\'s bucket', async () => {
    const response = await app.inject({ method: 'POST', url: '/storage/uploads', payload: { name: 'photo.png' } });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});

function headers(): Record<string, string> {
  return { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail };
}

async function register(taskKey: string, payload: Record<string, unknown>): Promise<Attachment> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${taskKey}/attachments`,
    headers: headers(),
    payload
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Attachment;
}

async function list(taskKey: string): Promise<Attachment[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/tasks/${taskKey}/attachments`,
    headers: headers()
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Attachment[];
}

async function createTask(title: string): Promise<{ id: string; key: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: headers(),
    payload: { projectId: fixture.projectId, title }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; key: string };
}

async function createKnowledgePage(): Promise<{ id: string }> {
  const space = await app.inject({
    method: 'POST',
    url: '/knowledge/spaces',
    headers: headers(),
    payload: { name: 'Media space' }
  });
  expect(space.statusCode).toBe(201);

  const page = await app.inject({
    method: 'POST',
    url: '/knowledge/pages',
    headers: headers(),
    payload: { spaceId: (space.json() as { id: string }).id, title: 'Page with attachments' }
  });
  expect(page.statusCode).toBe(201);
  return page.json() as { id: string };
}

async function registerKnowledgeAttachment(
  pageId: string,
  payload: Record<string, unknown>
): Promise<Attachment> {
  const response = await app.inject({
    method: 'POST',
    url: `/knowledge/pages/${pageId}/attachments`,
    headers: headers(),
    payload
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Attachment;
}

async function createComment(taskKey: string, body: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${taskKey}/comments`,
    headers: headers(),
    payload: { body }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `media-owner-${suffix}@example.test`;
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'Media owner' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'Media workspace', slug: `media-${suffix}` }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' }
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Media', keyPrefix: `MD${suffix.slice(0, 3).toUpperCase()}` }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    projectId: project.id
  };
}
