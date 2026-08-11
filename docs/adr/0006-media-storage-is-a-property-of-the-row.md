# Media storage is a property of the attachment, not of the deployment

Taskara can serve media from S3-compatible object storage instead of the external CDN. Which service
holds a given object is recorded **on the attachment row**, in a `storage` column, and is decided per
object at the moment it is uploaded.

The alternative — one environment variable naming the current backend — is a one-line change and is
wrong, for a reason that has nothing to do with taste.

## Why a column and not a setting

A CDN object key exists in no bucket. A bucket key is not a CDN document id. The keys are minted by
different services and mean nothing to each other, so "which service resolves this key" is a fact
about the key, not a fact about the deployment that happens to be reading it.

A deployment-level switch therefore does not *migrate* anything. It silently repoints every
attachment Taskara has ever stored at a service that has never held its bytes, for every historical
task, retroactively, with no failing test and no error in a log — the URLs are well-formed, they
simply 404 in somebody's browser. And it is not reversible by flipping the variable back, because by
then the objects uploaded while it was on are in the other state.

With the backend on the row, compatibility is not a discipline anyone has to maintain. Every row
written before this change reads `CDN`, which is the honest answer for all of them, so the migration
needs no backfill and `buildMediaUrl(object)` with no backend argument keeps meaning exactly what it
meant — which matters, because roughly thirty read paths call it that way and `GET /media/*` still
does.

`apps/api/src/routes/media-attachments.test.ts` holds the assertion the argument rests on: one task
with a CDN attachment and a bucket attachment, both resolving to their own service in the same
response. Under a deployment switch, one of those two URLs is necessarily wrong.

## The API is not in the byte path

A client asks `POST /storage/uploads` for a presigned `PUT`, uploads to the bucket directly, and then
registers the object through the attachment endpoint it already used. Nothing changes about
registration: the same JSON body, the same route, the same 201.

So no file passes through the API. Fastify's `bodyLimit` and nginx's `client_max_body_size` never
see an attachment's bytes, and no multipart parser is needed anywhere — which is what keeps
`Dockerfile.api`'s dependency layer and the agent package's zero-dependency property intact. The
presign endpoint is authenticated even though the object it produces is not: reading needs only the
key, but *minting* consumes somebody's bucket.

`TASKARA_UPLOAD_MAX_BYTES` does apply at the presign endpoint, against the size the client
*declares*. It is checked only after the endpoint has established that a bucket exists at all, and
the ordering is the whole of a compatibility argument rather than a detail. That limit has never
applied to attachment bytes — they went from the browser to the CDN and never touched the API — so on
a deployment with no bucket it must not start applying. The route answers "not configured" before it
parses or measures anything, which is also what the web client falls back to the CDN on. A 413 that
pre-empted that 503 would be a file that used to upload and no longer does.

Bun 1.3 ships `Bun.S3Client`, so this adds no dependency. The client is constructed explicitly from
values that went through `envSchema`, never `Bun.s3`'s default client, which reads `S3_*` and `AWS_*`
from an ambient environment this repository does not declare and Bun auto-loads from a `.env` beside
the process.

Measured while building it, and worth writing down because the code reads as though the opposite were
true: a presigned URL from Bun 1.3 carries `X-Amz-SignedHeaders=host`, and passing the `type` option
changes neither the signed headers nor the signature. The content type is therefore **advisory**. It
is still sent, because it is what the bucket stores and what decides whether the web previews an
attachment or downloads it — but nothing rejects an upload that sends a different one.

## What this changes about ADR-0004, and what it leaves standing

> _Contradicts ADR-0004 (attachments are capability URLs) — but worth reopening because that ADR's
> closing sentence, "the change is at the media service, signed expiring URLs, **not in this
> repository**", was true only while this repository had no storage of its own._

What it leaves standing, deliberately and in full:

- **The posture.** A bucket object is reachable by anyone holding its URL. There is no access check
  in front of it and none is added. The key is the capability.
- **Permanence.** Read URLs do not expire and carry no signature. Only the *write* is presigned.
  This is not conservatism: `SyncEvent.payload` and `ActivityLog.after` rows have absolute URLs
  frozen into them and are never pruned, the web's IndexedDB caches replay whole bootstrap snapshots,
  and inline editor nodes bake a URL into task descriptions. An expiring read URL goes stale in four
  places that nothing re-derives, and the timeline entry for an attachment renders as *nothing* when
  its frozen `url` is missing.
- **Every cost ADR-0004 accepted.** A URL, once obtained, works forever. Removing somebody from the
  workspace does not revoke media they have already seen.

What it changes: the lever now exists here. A deployment that needs revocable media can have it
without leaving the repository — but it is not this change, and the paragraph above is the list of
what would have to move first.

Key minting is the one genuinely new security-relevant thing. `createObjectKey` produces 52
characters of CSPRNG base62 and carries no workspace, task, user, date or original filename, because
structure in a key turns an unguessable capability into an address somebody can walk while every URL
still resolves. `object-storage.test.ts` asserts the absence of that structure, which is the only
form the assertion can take.

## What this costs, stated plainly

- **The CDN cannot be decommissioned.** Not now, and not after every attachment has moved. Four
  upload paths call `uploadMedia` and register no attachment row, so they store an absolute URL and
  no object key anywhere: avatars (`settings-view.tsx`, into `User.avatarUrl`), and the inline
  Lexical images in the task composer (`tasks-view.tsx`) and in the two meetings surfaces
  (`meetings-view.tsx`, `communications-view.tsx`). There is no key to re-sign and no back-reference
  to follow, so those addresses can only ever be resolved by the service that minted them. New
  uploads through all four go to the bucket; the old ones stay where they are forever.

  Task attachments, task-comment attachments and knowledge-page attachments are *not* in that list —
  all three register a row, so all three carry a key and a backend. Knowledge-page content does bake
  the resolved URL into its Lexical document, and `KnowledgePageVersion` keeps a copy per version,
  but the row behind it is recoverable. That distinction is why permanent read URLs are load-bearing
  rather than merely convenient.
- **Two backends, permanently.** Every deployment that adopts object storage runs both. That is the
  steady state, not a migration window.
- **The bucket must be publicly readable and must serve a correct `Content-Type`.** The web renders
  attachments as `<img>`, `<video>` and `<iframe>` with no custom headers, so header-authenticated
  reads are ruled out, and an object stored as `application/octet-stream` degrades to a download
  icon silently.
- **Browser uploads need CORS on the bucket.** A cross-origin `PUT` is preflighted, and its failure
  reaches JavaScript as an opaque `TypeError` that says nothing about CORS. Nothing in this
  repository can configure or detect that.
- **`sizeBytes` is still client-declared and unverified.** The presign endpoint refuses a request
  that *announces* itself as over `TASKARA_UPLOAD_MAX_BYTES`; since the bytes never reach the API,
  nothing proves the file that follows is that size. The bucket's own policy is the real limit.
- **Nothing deletes a stored object, and this does not add that.** There is no attachment DELETE
  route and no lifecycle hook. Object lifecycle is deliberately out of scope: a rule keyed on "no row
  references this key" would 404 already-shared capability URLs the moment a task was deleted, which
  is ADR-0004's posture violated by a side door.

## The count nobody has run

ADRs 0004 and 0005 both record a measurement rather than an assertion, and the comparable one here is
a single query: how many rows in `TaskAttachment` and `KnowledgePageAttachment`, and how many of
their `object` values are bare keys versus `v1/media/`-prefixed versus bare document ids versus
absolute URLs. All four shapes are reachable through `normalizeUploadedMediaInput` and all four are
covered by tests.

It has **not** been run against production. The compatibility claim here is structural — the column
defaults to `CDN`, so every existing row keeps the resolver it had regardless of which shapes are
present — but the distribution is worth knowing before the first deployment turns a bucket on, and
the unused `@@index([object])` on both tables is the index that query wants.

## Status

Accepted. Object storage is opt-in and every deployment that sets none of the `TASKARA_S3_*`
variables is unchanged. Out of scope by decision, not oversight: migrating existing CDN objects into
a bucket, moving avatars and inline editor nodes onto stored keys, object lifecycle, and revocable
reads — the second of those is the prerequisite for the fourth.
