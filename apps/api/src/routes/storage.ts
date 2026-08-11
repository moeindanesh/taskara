import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { getRequestActor } from '../services/actor';
import { HttpError } from '../services/http';
import { isObjectStorageConfigured, presignObjectUpload } from '../services/object-storage';

const presignUploadSchema = z.object({
  name: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().max(2147483647).optional()
});

/**
 * Minting an upload, without the API ever holding the bytes.
 *
 * The client asks for a place to put a file and gets back a presigned `PUT` plus the address the
 * object will be readable at. It uploads to the bucket directly and then registers the object with
 * the attachment endpoint it already used. So the byte path never crosses the API: Fastify's
 * `bodyLimit`, nginx's `client_max_body_size` and the API's memory are all out of the question of
 * how large an attachment may be, and no multipart parser is needed anywhere in the app.
 *
 * This endpoint is authenticated even though ADR-0004 says the object it produces will not be. The
 * two are not in tension: reading an object needs only the unguessable key, but *minting* one
 * consumes somebody's bucket, and an unauthenticated mint is an open write endpoint.
 *
 * A deployment with no bucket configured answers 503 here and keeps working — every client falls
 * back to the CDN upload path it used before this route existed. That 503 is the whole discovery
 * mechanism, which is why it is worth having rather than a browser-visible feature flag: a flag
 * would need a new variable in `.env.example`, both compose files, the web entrypoint's three
 * parallel edits and `vite-env.d.ts`, and would then be served from an `/env.js` that nginx caches
 * immutable for a year.
 */
export async function registerStorageRoutes(app: FastifyInstance): Promise<void> {
  app.post('/storage/uploads', async (request) => {
    await getRequestActor(request);

    // First, before parsing and before any limit. Every other answer this route can give is a
    // statement about an upload that is going to happen, and on a deployment with no bucket none of
    // them is true — the only true thing is that there is nowhere to put a file.
    //
    // Order matters here in a way that is invisible from the handler. The 503 is what the web
    // client falls back to the CDN on, so any status that pre-empts it is an upload that fails
    // instead of falling back. That is a regression against the CDN-only deployment this change is
    // required not to touch: `TASKARA_UPLOAD_MAX_BYTES` has never applied to attachment bytes,
    // which went straight from the browser to the CDN, so a 40MB video answered 413 here would be
    // a file that used to upload and now does not.
    if (!isObjectStorageConfigured()) throw new HttpError(503, 'Object storage is not configured');

    const input = presignUploadSchema.parse(request.body ?? {});

    // Client-declared and unverified — the bytes never pass through here, so this refuses an upload
    // that announces itself as too large rather than proving one was. It is worth doing anyway: it
    // is the difference between a clear 413 before the transfer and a provider error after it.
    if (input.sizeBytes !== undefined && input.sizeBytes > config.TASKARA_UPLOAD_MAX_BYTES) {
      throw new HttpError(413, `File is larger than the ${config.TASKARA_UPLOAD_MAX_BYTES} byte upload limit`);
    }

    return { storage: 'S3' as const, ...presignObjectUpload({ name: input.name, contentType: input.mimeType }) };
  });
}
