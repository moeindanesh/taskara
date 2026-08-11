import { describe, expect, test } from 'bun:test';

process.env.API_HOST = '127.0.0.1';
process.env.API_PORT = '4000';
process.env.WEB_ORIGIN = 'http://localhost:3005';
process.env.TASKARA_CDN_MEDIA_BASE_URL = 'https://cdn.example.test/v1/media/';
process.env.MATTERMOST_SYNTHETIC_EMAIL_DOMAIN = 'mattermost.example.invalid';
// A bucket *and* a CDN, which is the configuration every deployment that adopts object storage is
// in permanently: the CDN keeps resolving the keys it minted, and cannot be turned off. Note the
// absence of credentials -- resolving a stored object needs a read base and nothing else.
//
// Set here *and* in the `test:api` script, exactly as `TASKARA_CDN_MEDIA_BASE_URL` above already
// is, and both are load-bearing for different runs. `config` is `envSchema.parse(process.env)` at
// module load, so in a whole-suite run some other file has already imported it and frozen the
// configuration before this line executes -- only the script's prelude reaches that. These
// assignments are what make the file pass when it is run on its own.
process.env.TASKARA_S3_ENDPOINT = 'https://s3.example.test';
process.env.TASKARA_S3_BUCKET = 'taskara-media';

const { buildMediaUrl, buildMediaUrlFromBase, normalizeUploadedMediaInput, uploadedMediaInputSchema } = await import('./media');

describe('media URL handling', () => {
  test('builds CDN URLs whether the base is the CDN root or media endpoint', () => {
    expect(buildMediaUrlFromBase('https://cdn.example.test', 'objects/file.png')).toBe(
      'https://cdn.example.test/v1/media/objects/file.png'
    );
    expect(buildMediaUrlFromBase('https://cdn.example.test/v1/media/', 'objects/file.png')).toBe(
      'https://cdn.example.test/v1/media/objects/file.png'
    );
    expect(buildMediaUrlFromBase('https://cdn.example.test/v1/media/', '/v1/media/objects/file.png')).toBe(
      'https://cdn.example.test/v1/media/objects/file.png'
    );
  });

  test('keeps absolute CDN objects unchanged', () => {
    expect(buildMediaUrlFromBase('https://cdn.example.test/v1/media/', 'https://assets.example.test/file.png')).toBe(
      'https://assets.example.test/file.png'
    );
  });

  test('normalizes uploaded media metadata for attachment registration', () => {
    const input = uploadedMediaInputSchema.parse({
      documentId: 'doc-1',
      object: 'objects/file.txt',
      name: 'Public name',
      mimeType: 'text/plain',
      sizeBytes: 5
    });

    expect(normalizeUploadedMediaInput(input)).toEqual({
      documentId: 'doc-1',
      object: 'objects/file.txt',
      url: 'https://cdn.example.test/v1/media/objects/file.txt',
      name: 'Public name',
      mimeType: 'text/plain',
      sizeBytes: 5
    });
  });

  test('uses documentId as the media object when that is all the CDN returns', () => {
    const input = uploadedMediaInputSchema.parse({
      documentId: 'doc-only',
      name: 'Document only'
    });

    expect(normalizeUploadedMediaInput(input)).toMatchObject({
      documentId: 'doc-only',
      object: 'doc-only',
      url: 'https://cdn.example.test/v1/media/doc-only',
      name: 'Document only'
    });
  });
});

/**
 * A caller-supplied object is not an address.
 *
 * `buildMediaUrl` passes an absolute URL through, which is right for a stored attachment — the CDN
 * hands one back and the row genuinely holds the address. `GET /media/*` takes its object from the
 * request path, so there the same branch lets the caller choose the destination of a redirect
 * served from Taskara's own domain.
 *
 * Written as a property of the two modes rather than as a reproduction: this repository is public,
 * and a test named after the route it abuses is the recipe written down.
 */
describe('media url pass-through is opt-in', () => {
  test('a stored attachment keeps its absolute url', () => {
    expect(buildMediaUrl('https://cdn.example.test/v1/media/stored.png')).toBe(
      'https://cdn.example.test/v1/media/stored.png'
    );
  });

  test('a caller-supplied object may not be an absolute url', () => {
    expect(() => buildMediaUrl('https://elsewhere.example.test/x.png', { allowAbsolute: false })).toThrow(
      /storage key/
    );
  });

  test('a storage key still resolves when pass-through is refused', () => {
    expect(buildMediaUrl('some/object/key.png', { allowAbsolute: false })).toContain('some/object/key.png');
  });
});

/**
 * Which service holds a key is a property of the row, not of the deployment.
 *
 * The whole compatibility argument for object storage rests on this one dispatch. A key minted by
 * the CDN exists in no bucket, so the moment a bucket is configured, every historical attachment
 * would resolve to an address that has never held its bytes — unless the row says where its bytes
 * are. That is why `storage` is a column and not an environment variable, and these tests are what
 * hold the two apart.
 *
 * Every test above this line runs with a bucket configured and none of them changed, which is the
 * actual claim being made: configuring object storage does nothing to a CDN attachment.
 */
describe('an attachment resolves against the backend its row names', () => {
  test('an S3 row resolves against the bucket', () => {
    expect(buildMediaUrl('abc123.png', { storage: 'S3' })).toBe('https://s3.example.test/taskara-media/abc123.png');
  });

  test('a CDN row resolves against the CDN even though a bucket is configured', () => {
    expect(buildMediaUrl('abc123.png', { storage: 'CDN' })).toBe('https://cdn.example.test/v1/media/abc123.png');
  });

  test('an omitted backend means CDN, because every row written before the column did', () => {
    // The argument's load-bearing default. `buildMediaUrl(object)` is what ~30 read paths called
    // before this change and what `GET /media/*` still calls; it has to keep meaning "CDN".
    expect(buildMediaUrl('abc123.png')).toBe(buildMediaUrl('abc123.png', { storage: 'CDN' }));
    expect(buildMediaUrl('abc123.png', { storage: null })).toBe('https://cdn.example.test/v1/media/abc123.png');
  });

  test('an absolute object is still returned unchanged, whatever backend the row names', () => {
    // The absolute branch runs first because such a row has no key to build from — it can be
    // resolved no other way, so a backend cannot be allowed to override it.
    expect(buildMediaUrl('https://assets.example.test/file.png', { storage: 'S3' })).toBe(
      'https://assets.example.test/file.png'
    );
  });

  test('a caller-supplied object may not be an absolute url on the bucket branch either', () => {
    expect(() => buildMediaUrl('https://elsewhere.example.test/x.png', { allowAbsolute: false, storage: 'S3' })).toThrow(
      /storage key/
    );
  });

  test('a bucket key that tries to walk out of the bucket is refused', () => {
    // A registration body names its own object. The CDN branch has no equivalent exposure because
    // its base ends in a route the CDN itself resolves; the bucket branch joins to a host root.
    expect(() => buildMediaUrl('../../etc/passwd', { storage: 'S3' })).toThrow(/plain storage key/);
  });
});

describe('registration records the backend the client uploaded to', () => {
  test('an S3 registration is normalised against the bucket and keeps its backend', () => {
    const input = uploadedMediaInputSchema.parse({
      object: 'kQ7fN2.png',
      name: 'Screenshot',
      mimeType: 'image/png',
      sizeBytes: 2048,
      storage: 'S3'
    });

    expect(normalizeUploadedMediaInput(input)).toEqual({
      object: 'kQ7fN2.png',
      url: 'https://s3.example.test/taskara-media/kQ7fN2.png',
      name: 'Screenshot',
      mimeType: 'image/png',
      sizeBytes: 2048,
      storage: 'S3'
    });
  });

  test('a registration that names no backend produces exactly the object it always produced', () => {
    // The strict `toEqual` at the top of this file already pins this, and this test says why that
    // strictness is worth keeping: a client written before object storage existed sends no
    // `storage`, and the field is spread conditionally so that its output is unchanged rather than
    // merely compatible. `storage` must be absent here, not `undefined` and not `'CDN'`.
    const normalized = normalizeUploadedMediaInput(uploadedMediaInputSchema.parse({ object: 'legacy.png' }));

    expect('storage' in normalized).toBe(false);
    expect(normalized.url).toBe('https://cdn.example.test/v1/media/legacy.png');
  });

  test('a backend nobody recognises is refused at the schema, not stored', () => {
    expect(uploadedMediaInputSchema.safeParse({ object: 'a.png', storage: 'GCS' }).success).toBe(false);
  });
});
