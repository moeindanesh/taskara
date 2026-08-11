import { config } from '../config';
import { HttpError } from './http';

/**
 * S3-compatible object storage: where Taskara puts bytes when it owns them.
 *
 * This module is deliberately the only place that knows an S3 client exists. Everything above it
 * deals in an object key and a `MediaStorage` value, which is what lets `buildMediaUrl` stay a
 * synchronous pure-ish function and lets an attachment row keep meaning what it meant before the
 * bucket existed.
 *
 * Two settings objects, not one, and the split matters. **Reading** a stored object needs only a
 * public base address — no credentials. **Writing** needs a full credentialed client. A deployment
 * that serves its bucket through a CDN can therefore give the API a read base and no secret, and a
 * deployment whose credentials are rotated out keeps serving every attachment it already has. If
 * reads went through the credentialed settings, losing a secret would take down `GET /tasks`.
 */

export type MediaStorageBackend = 'CDN' | 'S3';

/** The slice of `config` this module reads, named so the pure resolvers can be handed a literal. */
export interface ObjectStorageEnv {
  TASKARA_S3_ENDPOINT?: string;
  TASKARA_S3_REGION?: string;
  TASKARA_S3_BUCKET?: string;
  TASKARA_S3_ACCESS_KEY_ID?: string;
  TASKARA_S3_SECRET_ACCESS_KEY?: string;
  TASKARA_S3_PUBLIC_BASE_URL?: string;
  TASKARA_S3_KEY_PREFIX?: string;
  TASKARA_S3_UPLOAD_TTL_SECONDS?: number;
  TASKARA_S3_VIRTUAL_HOSTED_STYLE?: boolean;
}

export interface ObjectStorageSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  keyPrefix: string;
  uploadTtlSeconds: number;
  virtualHostedStyle: boolean;
}

export interface PresignedUpload {
  object: string;
  url: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;

/**
 * The address a bucket object is publicly readable at, or `null` if nothing says.
 *
 * `TASKARA_S3_PUBLIC_BASE_URL` wins when set, because a bucket fronted by a CDN or a custom domain
 * is readable somewhere the API endpoint cannot describe. Otherwise it is derived from the endpoint
 * and bucket in whichever addressing style the provider serves.
 */
export function resolveObjectStorageReadBase(env: ObjectStorageEnv): string | null {
  const explicit = trimmed(env.TASKARA_S3_PUBLIC_BASE_URL);
  if (explicit) return stripTrailingSlashes(explicit);

  const endpoint = trimmed(env.TASKARA_S3_ENDPOINT);
  const bucket = trimmed(env.TASKARA_S3_BUCKET);
  if (!endpoint || !bucket) return null;

  return stripTrailingSlashes(derivePublicBaseUrl(endpoint, bucket, env.TASKARA_S3_VIRTUAL_HOSTED_STYLE === true));
}

/**
 * The full write-capable settings, or `null` when object storage is not configured.
 *
 * All four of endpoint, bucket, access key and secret are required together. A partially configured
 * bucket is answered as "not configured" rather than as a client that will fail at the first PUT:
 * the deployment that half-set these variables gets a 503 saying object storage is not configured,
 * which is true, instead of an opaque signature error from a provider.
 */
export function resolveObjectStorageSettings(env: ObjectStorageEnv): ObjectStorageSettings | null {
  const endpoint = trimmed(env.TASKARA_S3_ENDPOINT);
  const bucket = trimmed(env.TASKARA_S3_BUCKET);
  const accessKeyId = trimmed(env.TASKARA_S3_ACCESS_KEY_ID);
  const secretAccessKey = trimmed(env.TASKARA_S3_SECRET_ACCESS_KEY);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  const publicBaseUrl = resolveObjectStorageReadBase(env);
  if (!publicBaseUrl) return null;

  return {
    endpoint: stripTrailingSlashes(endpoint),
    region: trimmed(env.TASKARA_S3_REGION) || DEFAULT_REGION,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
    keyPrefix: normalizeKeyPrefix(env.TASKARA_S3_KEY_PREFIX),
    uploadTtlSeconds: env.TASKARA_S3_UPLOAD_TTL_SECONDS || DEFAULT_UPLOAD_TTL_SECONDS,
    virtualHostedStyle: env.TASKARA_S3_VIRTUAL_HOSTED_STYLE === true
  };
}

let readBaseMemo: { value: string | null } | undefined;
let settingsMemo: { value: ObjectStorageSettings | null } | undefined;

/** Resolved lazily so that a route which never touches media never touches storage settings. */
export function objectStorageReadBase(): string | null {
  readBaseMemo ??= { value: resolveObjectStorageReadBase(config) };
  return readBaseMemo.value;
}

export function objectStorageSettings(): ObjectStorageSettings | null {
  settingsMemo ??= { value: resolveObjectStorageSettings(config) };
  return settingsMemo.value;
}

/**
 * Whether uploads can be minted. Reads may still work when this is false — see the module comment —
 * so this is the question an upload endpoint asks, never the question a read path asks.
 */
export function isObjectStorageConfigured(): boolean {
  return objectStorageSettings() !== null;
}

/**
 * A bucket key joined to a read base.
 *
 * Kept separate from `buildMediaUrlFromBase` in `media.ts` rather than sharing it, even though both
 * join a base to a key. That one splices in a `/v1/media/` segment and refuses to double it, which
 * is the CDN's route shape and is meaningless here — and worse, it would mangle a bucket key that
 * legitimately began `v1/media/`. Two callers doing a similar thing for unrelated reasons are two
 * functions.
 */
export function buildObjectStorageUrlFromBase(baseUrl: string, key: string): string {
  return `${stripTrailingSlashes(baseUrl)}/${key.replace(/^\/+/, '')}`;
}

/**
 * The public address of a stored bucket object.
 *
 * Throws 503 rather than returning a broken address when no read base is configured, matching what
 * the CDN branch does when `TASKARA_CDN_MEDIA_BASE_URL` is missing. The symmetry is the point: an
 * attachment whose backend cannot be resolved is a server misconfiguration in both directions.
 */
export function buildObjectStorageUrl(key: string, readBase = objectStorageReadBase()): string {
  if (!readBase) {
    throw new HttpError(503, 'TASKARA_S3_PUBLIC_BASE_URL or TASKARA_S3_ENDPOINT and TASKARA_S3_BUCKET are required for object storage URLs');
  }
  assertStorageKey(key);
  return buildObjectStorageUrlFromBase(readBase, key);
}

const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/**
 * A bucket key is a key, not a path expression.
 *
 * A registration body names its own object, so `..` in a key would resolve — in the browser, after
 * the URL is built — to somewhere other than the object, on Taskara's own bucket host. This is the
 * same class of defect as the open redirect that `GET /media/*` was fixed for, arriving through the
 * other door, and it is cheaper to refuse the key than to reason about what a resolver will do
 * with it.
 */
export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key) || key.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new HttpError(400, 'Object storage key must be a plain storage key');
  }
}

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY_LENGTH = 52;
// 256 is not a multiple of 62, so folding a random byte with `% 62` hands the first eight letters
// an extra chance each -- measured at 1.24x. It costs a few bits of an already generous budget
// rather than breaking anything, but this alphabet is the access control, and "the bias is small"
// is not a sentence worth leaving in the one function ADR-0004's posture rests on. Bytes at or
// above the largest exact multiple are discarded instead of folded.
const KEY_BYTE_CEILING = 256 - (256 % KEY_ALPHABET.length);

/**
 * Mint an object key.
 *
 * The key *is* the access control — see ADR-0004 — so this is a security-relevant function even
 * though it looks like a formatting helper. Two properties are load-bearing and neither is visible
 * from a passing test: it comes from a CSPRNG, and it carries no workspace, task, user, date or
 * original filename. Structure in the path is what turns an unguessable capability into an address
 * somebody can walk, and the walk succeeds silently because every URL still resolves.
 *
 * 52 characters of base62 is ~309 bits, comfortably past the 48–56 alphanumeric characters ADR-0004
 * measured on the CDN's own keys — the point is to not regress that, not to match it.
 *
 * The extension is kept, when the name has a plain one, because previews are chosen from the served
 * `Content-Type` and several providers infer that from the key. It adds no structure an attacker
 * could enumerate: knowing an object is a `.png` does not help find it.
 */
export function createObjectKey(fileName?: string, settings = objectStorageSettings()): string {
  let key = '';
  while (key.length < KEY_LENGTH) {
    const bytes = new Uint8Array(KEY_LENGTH - key.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= KEY_BYTE_CEILING) continue;
      key += KEY_ALPHABET[byte % KEY_ALPHABET.length];
    }
  }

  return `${settings?.keyPrefix ?? ''}${key}${extensionOf(fileName)}`;
}

/**
 * A presigned PUT the browser or the agent uploads to directly.
 *
 * The API stays out of the byte path entirely: it signs a URL and forgets. That is what keeps
 * `TASKARA_UPLOAD_MAX_BYTES`, Fastify's body limit and nginx's `client_max_body_size` out of the
 * question of how large an attachment may be, and it is why no multipart parser is needed anywhere.
 */
export function presignObjectUpload(
  input: { name?: string; contentType?: string; object?: string },
  settings = objectStorageSettings()
): PresignedUpload {
  if (!settings) throw new HttpError(503, 'Object storage is not configured');

  const object = input.object ?? createObjectKey(input.name, settings);
  assertStorageKey(object);

  const contentType = normalizeContentType(input.contentType);
  const client = createClient(settings);
  // `type` is deliberately not passed. Measured, not assumed: a presigned URL from Bun 1.3 carries
  // `X-Amz-SignedHeaders=host`, and passing `type` changes neither that nor the signature, so it
  // would read as a constraint while enforcing nothing.
  const uploadUrl = client.presign(object, { method: 'PUT', expiresIn: settings.uploadTtlSeconds });

  return {
    object,
    url: buildObjectStorageUrlFromBase(settings.publicBaseUrl, object),
    uploadUrl,
    method: 'PUT',
    // Advisory, and load-bearing anyway. The content type is not part of the signature, so this
    // header does not authorise the upload -- but it is what the provider stores as the object's
    // `Content-Type`, and the web renders an attachment as `<img>`, `<video>` or `<iframe>` from
    // what the bucket serves. An object stored as `application/octet-stream` downloads instead of
    // previewing, and the failure is silent.
    headers: contentType ? { 'content-type': contentType } : {},
    expiresAt: new Date(Date.now() + settings.uploadTtlSeconds * 1000).toISOString()
  };
}

/**
 * Constructed explicitly, never `Bun.s3`.
 *
 * The default client reads `S3_*` and `AWS_*` from the ambient environment — variables `envSchema`
 * does not declare and Bun auto-loads from a `.env` beside the process. Using it would mean a
 * machine with unrelated cloud credentials exported could write Taskara's attachments to somebody
 * else's bucket, with nothing in this repository saying so.
 */
function createClient(settings: ObjectStorageSettings): Bun.S3Client {
  return new Bun.S3Client({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    bucket: settings.bucket,
    endpoint: settings.endpoint,
    region: settings.region,
    virtualHostedStyle: settings.virtualHostedStyle
  });
}

/**
 * The address the bucket serves an object at, which must be the address the presigned PUT writes to.
 *
 * Measured against `Bun.S3Client`, because guessing here produces a deployment where every upload
 * succeeds and every read 404s:
 *
 * - Path-style (the default): the client addresses `<endpoint>/<bucket>/<key>`, so the base is
 *   `<endpoint>/<bucket>`.
 * - Virtual-hosted: the client addresses `<endpoint>/<key>` and **ignores the bucket entirely** —
 *   Bun's own documented example passes an endpoint that is already bucket-qualified
 *   (`https://my-bucket.s3.us-east-1.amazonaws.com`). So the endpoint *is* the addressed host and
 *   the base is the endpoint unchanged.
 *
 * The earlier version of this function prepended the bucket to the endpoint host in the
 * virtual-hosted branch, which read as the obvious thing and was wrong in a way no configuration
 * could work around: with a plain endpoint the PUT went to a bucket-less path while the read URL
 * named `bucket.host`, and with a bucket-qualified endpoint the read URL named `bucket.bucket.host`.
 * The regression test for it is not a case, it is an invariant — the upload URL with its query
 * string removed must equal the read URL, for every addressing style.
 */
function derivePublicBaseUrl(endpoint: string, bucket: string, virtualHostedStyle: boolean): string {
  if (virtualHostedStyle) return stripTrailingSlashes(endpoint);

  return `${stripTrailingSlashes(endpoint)}/${bucket}`;
}

function normalizeKeyPrefix(prefix?: string): string {
  const value = trimmed(prefix);
  if (!value) return '';
  return `${value.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
}

/** Only a plain, short, alphanumeric extension. Anything else is dropped rather than sanitised. */
function extensionOf(fileName?: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(trimmed(fileName) ?? '');
  return match ? `.${match[1].toLowerCase()}` : '';
}

/** Parameters are dropped: `image/png; charset=binary` signs differently than it is later sent. */
function normalizeContentType(contentType?: string): string | undefined {
  const value = trimmed(contentType)?.split(';')[0]?.trim().toLowerCase();
  if (!value || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)) return undefined;
  return value;
}

function trimmed(value?: string): string | undefined {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
