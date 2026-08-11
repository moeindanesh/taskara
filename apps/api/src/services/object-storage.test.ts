import { describe, expect, test } from 'bun:test';

process.env.API_HOST = '127.0.0.1';
process.env.API_PORT = '4000';
process.env.WEB_ORIGIN = 'http://localhost:3005';
process.env.MATTERMOST_SYNTHETIC_EMAIL_DOMAIN = 'mattermost.example.invalid';

const {
  assertStorageKey,
  buildObjectStorageUrlFromBase,
  createObjectKey,
  presignObjectUpload,
  resolveObjectStorageReadBase,
  resolveObjectStorageSettings
} = await import('./object-storage');

/**
 * Everything here is exercised through the *pure* resolvers, which take an env-shaped literal.
 *
 * That is not a stylistic preference. `config` is `envSchema.parse(process.env)` at module load, so
 * one test process gets exactly one configuration — and the properties worth asserting are mostly
 * about *disagreeing* configurations: configured against unconfigured, path-style against
 * virtual-hosted, a public base that overrides the derived one. Handing the resolvers a literal is
 * what makes those testable at all; the config-reading wrappers over them hold no logic to test.
 */

const COMPLETE = {
  TASKARA_S3_ENDPOINT: 'https://s3.example.test',
  TASKARA_S3_BUCKET: 'taskara-media',
  TASKARA_S3_ACCESS_KEY_ID: 'access-key',
  TASKARA_S3_SECRET_ACCESS_KEY: 'secret-key'
};

describe('object storage is configured only when it is fully configured', () => {
  test('an unconfigured deployment resolves to null rather than to a broken client', () => {
    expect(resolveObjectStorageSettings({})).toBeNull();
  });

  test('every missing load-bearing field on its own is enough to answer null', () => {
    // A half-configured bucket must read as "not configured", so the caller answers 503 with a
    // sentence an operator can act on. The rejected alternative is a client that constructs fine
    // and fails at the first PUT with a signature error from the provider, which names none of it.
    for (const missing of Object.keys(COMPLETE)) {
      const partial = { ...COMPLETE, [missing]: undefined };
      expect(resolveObjectStorageSettings(partial)).toBeNull();
    }
  });

  test('a blank string is absent, not present-and-empty', () => {
    // `.env.example` ships `NAME=""` and compose ships `${NAME:-}`, so blank is how an operator
    // spells "declared but not set" in both files this repository publishes.
    expect(resolveObjectStorageSettings({ ...COMPLETE, TASKARA_S3_BUCKET: '   ' })).toBeNull();
  });

  test('a complete configuration fills in the defaults it was not given', () => {
    const settings = resolveObjectStorageSettings(COMPLETE);

    expect(settings).toMatchObject({
      endpoint: 'https://s3.example.test',
      bucket: 'taskara-media',
      region: 'us-east-1',
      publicBaseUrl: 'https://s3.example.test/taskara-media',
      keyPrefix: '',
      uploadTtlSeconds: 900,
      virtualHostedStyle: false
    });
  });

  test('a key prefix is normalised to exactly one trailing slash however it was written', () => {
    for (const written of ['attachments', '/attachments', 'attachments/', '/attachments/']) {
      expect(resolveObjectStorageSettings({ ...COMPLETE, TASKARA_S3_KEY_PREFIX: written })?.keyPrefix).toBe(
        'attachments/'
      );
    }
  });
});

describe('the read base is resolvable without credentials', () => {
  test('reads need no access key, so losing a secret does not take down GET /tasks', () => {
    // The asymmetry is deliberate and is the reason there are two resolvers. Serializing an
    // attachment happens on essentially every task read; signing an upload happens on upload. If
    // reads went through the credentialed settings, a rotated-out secret would 503 the task list.
    expect(resolveObjectStorageSettings({ TASKARA_S3_PUBLIC_BASE_URL: 'https://cdn.example.test' })).toBeNull();
    expect(resolveObjectStorageReadBase({ TASKARA_S3_PUBLIC_BASE_URL: 'https://cdn.example.test' })).toBe(
      'https://cdn.example.test'
    );
  });

  test('an explicit public base wins over the one derived from the endpoint', () => {
    // A bucket fronted by a CDN or a custom domain is readable somewhere the API endpoint cannot
    // describe, and the endpoint may not even be reachable from a browser.
    expect(
      resolveObjectStorageReadBase({ ...COMPLETE, TASKARA_S3_PUBLIC_BASE_URL: 'https://media.example.test/files/' })
    ).toBe('https://media.example.test/files');
  });

  test('path-style puts the bucket in the path', () => {
    expect(resolveObjectStorageReadBase(COMPLETE)).toBe('https://s3.example.test/taskara-media');
  });

  test('virtual-hosted addressing takes the endpoint as the host and does not insert the bucket', () => {
    // Bun's client ignores `bucket` when an endpoint is given with `virtualHostedStyle`, and its own
    // documented example passes an already-qualified endpoint. So the operator supplies the
    // bucket-qualified host, and the read base is that host unchanged. Inserting the bucket here --
    // which is the intuitive reading -- addresses `bucket.bucket.host` on a correctly configured
    // deployment, and no endpoint value makes the read and the write agree.
    expect(
      resolveObjectStorageReadBase({
        ...COMPLETE,
        TASKARA_S3_ENDPOINT: 'https://taskara-media.s3.example.test',
        TASKARA_S3_VIRTUAL_HOSTED_STYLE: true
      })
    ).toBe('https://taskara-media.s3.example.test');
  });

  test('nothing configured is null, not an empty base that would build relative URLs', () => {
    expect(resolveObjectStorageReadBase({})).toBeNull();
    expect(resolveObjectStorageReadBase({ TASKARA_S3_ENDPOINT: 'https://s3.example.test' })).toBeNull();
  });
});

describe('a bucket key is joined to a base without the CDN route shape', () => {
  test('the base and key are joined with exactly one slash', () => {
    expect(buildObjectStorageUrlFromBase('https://s3.example.test/bucket', 'abc.png')).toBe(
      'https://s3.example.test/bucket/abc.png'
    );
    expect(buildObjectStorageUrlFromBase('https://s3.example.test/bucket/', '/abc.png')).toBe(
      'https://s3.example.test/bucket/abc.png'
    );
  });

  test('no /v1/media/ segment is spliced in, and a key that looks like one is left alone', () => {
    // `buildMediaUrlFromBase` in media.ts splices that segment in and refuses to double it, which
    // is the CDN's route shape. Sharing it here would both invent a path the bucket does not serve
    // and silently mangle a bucket key that legitimately began `v1/media/`.
    expect(buildObjectStorageUrlFromBase('https://s3.example.test/bucket', 'v1/media/abc.png')).toBe(
      'https://s3.example.test/bucket/v1/media/abc.png'
    );
  });
});

describe('a storage key is a key, not a path expression', () => {
  test('a traversal segment is refused rather than resolved', () => {
    // The registration body names its own object, so this is the open-redirect class of defect that
    // `GET /media/*` was fixed for, arriving through the other door: the escape happens in the
    // browser, after a perfectly well-formed URL has been built and returned.
    for (const key of ['../secrets/key.png', 'a/../../b.png', '..']) {
      expect(() => assertStorageKey(key)).toThrow(/plain storage key/);
    }
  });

  test('an empty segment, a leading slash and a scheme are all refused', () => {
    for (const key of ['a//b.png', '/leading.png', 'https://elsewhere.example.test/x.png', '']) {
      expect(() => assertStorageKey(key)).toThrow(/plain storage key/);
    }
  });

  test('the keys this service actually mints pass', () => {
    expect(() => assertStorageKey(createObjectKey('photo.png'))).not.toThrow();
    expect(() => assertStorageKey(createObjectKey('photo.png', settings({ TASKARA_S3_KEY_PREFIX: 'a/b' })))).not.toThrow();
  });
});

describe('a minted key is the access control, so it carries entropy and nothing else', () => {
  // Explicit settings on every call. The file's whole premise is that these functions are testable
  // because they take a literal, and a bare `createObjectKey()` quietly reads the ambient
  // module-load configuration instead -- which is the one thing these tests are not supposed to
  // depend on.
  const noPrefix = () => settings({ TASKARA_S3_KEY_PREFIX: '' });

  test('52 base62 characters, before any prefix or extension', () => {
    // ADR-0004 measured the CDN's own keys at 48-56 alphanumeric characters. The point of matching
    // that range is not symmetry, it is not regressing the property the ADR relies on.
    expect(createObjectKey(undefined, noPrefix())).toMatch(/^[A-Za-z0-9]{52}$/);
  });

  test('two keys minted in the same millisecond differ', () => {
    const keys = new Set(Array.from({ length: 500 }, () => createObjectKey(undefined, noPrefix())));
    expect(keys.size).toBe(500);
  });

  test('every character of the alphabet is equally likely', () => {
    // A uniform random byte folded with `% 62` gives the first eight letters an extra chance each,
    // because 256 is not a multiple of 62. It is a small bias and it breaks nothing today, which is
    // exactly why it would survive forever unmeasured -- in the function that mints the value ADR
    // -0004 relies on being unguessable. The tolerance is loose enough not to flake and far tighter
    // than the 1.24x the folding version produced.
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const character of createObjectKey(undefined, noPrefix())) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    const frequencies = [...counts.values()];
    expect(counts.size).toBe(62);
    expect(Math.max(...frequencies) / Math.min(...frequencies)).toBeLessThan(1.15);
  });

  test('nothing about the caller reaches the key', () => {
    // This is the assertion that would fail if somebody "improved" keys to be readable. Structure —
    // a workspace, a task, a date, the original filename — turns an unguessable capability into an
    // address that can be walked, and every URL still resolves while it happens.
    const key = createObjectKey('quarterly-salary-review.png', noPrefix());
    expect(key).not.toContain('quarterly');
    expect(key).not.toContain('salary');
    expect(key.replace(/\.png$/, '')).toMatch(/^[A-Za-z0-9]{52}$/);
  });

  test('a plain extension is kept and anything else is dropped rather than sanitised', () => {
    expect(createObjectKey('photo.PNG', noPrefix())).toMatch(/\.png$/);
    expect(createObjectKey('archive.tar.gz', noPrefix())).toMatch(/\.gz$/);
    expect(createObjectKey('no-extension', noPrefix())).toMatch(/^[A-Za-z0-9]{52}$/);
    expect(createObjectKey('weird.name with spaces', noPrefix())).toMatch(/^[A-Za-z0-9]{52}$/);
    expect(createObjectKey('trick.php%00', noPrefix())).toMatch(/^[A-Za-z0-9]{52}$/);
  });

  test('the configured prefix is applied', () => {
    expect(createObjectKey('photo.png', settings({ TASKARA_S3_KEY_PREFIX: 'attachments' }))).toMatch(
      /^attachments\/[A-Za-z0-9]{52}\.png$/
    );
  });
});

describe('an upload is presigned, so the API never holds the bytes', () => {
  test('an unconfigured deployment answers 503 rather than minting something unusable', () => {
    expect(() => presignObjectUpload({ name: 'photo.png' }, null)).toThrow(/not configured/);
  });

  test('the signed URL is a PUT against the configured bucket, expiring when configured', () => {
    const upload = presignObjectUpload({ name: 'photo.png', contentType: 'image/png' }, settings());

    expect(upload.method).toBe('PUT');
    expect(upload.uploadUrl).toStartWith(`https://s3.example.test/taskara-media/${upload.object}?`);
    expect(upload.uploadUrl).toContain('X-Amz-Signature=');
    expect(upload.uploadUrl).toContain('X-Amz-Expires=900');
  });

  test('the read address is the public base, not the signed one', () => {
    // These are two different URLs on purpose, and conflating them is the mistake worth pinning
    // against: the signed one expires and carries a signature, the stored one must work forever.
    const upload = presignObjectUpload({ name: 'photo.png' }, settings());

    expect(upload.url).toBe(`https://s3.example.test/taskara-media/${upload.object}`);
    expect(upload.url).not.toContain('X-Amz-');
  });

  test('a public base that is a CDN is where the object is read from, not where it is written', () => {
    const upload = presignObjectUpload(
      { name: 'photo.png' },
      settings({ TASKARA_S3_PUBLIC_BASE_URL: 'https://media.example.test' })
    );

    expect(upload.url).toBe(`https://media.example.test/${upload.object}`);
    expect(upload.uploadUrl).toStartWith('https://s3.example.test/taskara-media/');
  });

  test('the content type is returned as a header to send, and is not part of the signature', () => {
    // Measured rather than assumed, and the assumption was wrong in the useful direction: a Bun 1.3
    // presigned URL signs `host` alone, so the content type constrains nothing. It still has to be
    // sent, because it is what the provider stores and what decides whether the web previews the
    // object or downloads it -- but a test asserting it were signed would be asserting a fiction.
    const upload = presignObjectUpload({ name: 'p.png', contentType: 'image/png; charset=binary' }, settings());

    expect(upload.headers).toEqual({ 'content-type': 'image/png' });
    expect(new URL(upload.uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  test('the parameters are dropped from a content type before it is handed back', () => {
    expect(presignObjectUpload({ name: 'p.png', contentType: 'text/plain; charset=utf-8' }, settings()).headers).toEqual(
      { 'content-type': 'text/plain' }
    );
  });

  test('a content type nobody can parse is dropped rather than passed through', () => {
    const upload = presignObjectUpload({ name: 'p.png', contentType: 'not a mime type' }, settings());

    expect(upload.headers).toEqual({});
  });

  test('a caller-supplied object is validated before it is signed', () => {
    expect(() => presignObjectUpload({ object: '../escape.png' }, settings())).toThrow(/plain storage key/);
  });

  test('the write and the read address the same object, in every addressing style', () => {
    // An invariant, not a case, and deliberately so: the bug this replaces was a plausible-looking
    // derivation that made the PUT land on one host and the stored URL point at another. Every
    // upload succeeded and every read 404'd, and no assertion about either URL *alone* could see
    // it. Any new addressing style has to satisfy this or it is broken.
    const configurations = [
      settings(),
      settings({ TASKARA_S3_KEY_PREFIX: 'attachments' }),
      settings({
        TASKARA_S3_ENDPOINT: 'https://taskara-media.s3.example.test',
        TASKARA_S3_VIRTUAL_HOSTED_STYLE: true
      })
    ];

    for (const configuration of configurations) {
      const upload = presignObjectUpload({ name: 'photo.png' }, configuration);
      expect(upload.uploadUrl.split('?')[0]).toBe(upload.url);
    }
  });

  test('the expiry is reported as an absolute instant the client can compare against', () => {
    const upload = presignObjectUpload({ name: 'photo.png' }, settings());
    const remainingMs = new Date(upload.expiresAt).getTime() - Date.now();

    expect(remainingMs).toBeGreaterThan(890_000);
    expect(remainingMs).toBeLessThanOrEqual(900_000);
  });
});

function settings(overrides: Record<string, unknown> = {}) {
  const resolved = resolveObjectStorageSettings({ ...COMPLETE, ...overrides });
  if (!resolved) throw new Error('test settings must resolve');
  return resolved;
}
