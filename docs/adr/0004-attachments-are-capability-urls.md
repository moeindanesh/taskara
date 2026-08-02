# Attachments are capability URLs, not access-controlled objects

An attachment is reachable by anyone holding its URL. The media service does not ask who is asking,
and Taskara does not put an access check in front of it. What protects an attachment is that its
object key is long and unguessable — a **capability**, not an authorisation.

This is a deliberate posture, confirmed by the workspace owner, and it is written down because the
alternative is that somebody re-derives it from the code every year and reaches a different answer.

## Why it is not a code question

`GET /media/*` is a **URL builder, not a proxy**. It takes an object key and answers `302` with the
CDN address. Authenticating it would protect nothing: the web client composes the identical URL from
a base that ships to every browser in `VITE_TASKARA_CDN_MEDIA_BASE_URL`, so a caller who wanted the
object would simply not use the route. The lever is the media service, not the API.

Measured rather than assumed, on the deployed service:

- An unauthenticated request for a key that does not exist answers **500** — a server error while
  trying to serve it — not `401` or `403`. Nothing gates the read.
- Stored object keys are a short prefix and **48–56 alphanumeric characters**, so the key space is
  not enumerable.

## What this costs, stated plainly

These follow from the posture and are accepted, not overlooked:

- **A URL, once obtained, works forever.** There is no expiry and no signature to rotate.
- **Removing somebody from a workspace does not revoke media they have already seen.** Their session
  dies; the links in their scrollback do not.
- **The read-access work of #57–#60 stops at the attachment boundary.** Those tickets made a task
  row, its dependencies, its timeline and its notifications respect `canReadProject`. An attachment
  URL that has left the building is outside all of it.

If any of those becomes unacceptable — an attachment holding something that must be revocable — the
change is at the media service (signed, expiring URLs), not in this repository.

## What this does *not* excuse

`GET /media/*` accepted an absolute URL as its object and redirected to it, which made an
unauthenticated open redirect on Taskara's own domain. That was a **separate defect** and is fixed:
pass-through is opt-in, and the route does not opt in. A posture that says "the object is public"
never implied "the route will send you anywhere you like".

## Status

Accepted. Investigation in `.scratch/AUDIT-media-posture.md` (local, gitignored), from issue
[#60](https://github.com/moeindanesh/taskara/issues/60).
