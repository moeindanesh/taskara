# The frontier is a composition of task filters, not an endpoint

An agent starting a session needs the *frontier* of an effort: the children that are unfinished, have
no open blocker, and have no assignee. We deliberately did NOT add a `/efforts/:id/frontier` endpoint
that returns that set. `GET /tasks` gained four independent filters instead, and the frontier is the
one request that composes them:

```
GET /tasks?parentId=<effort>&status=unfinished&assigneeId=none&blockers=none&sort=createdAt:asc
```

## Why

- **The same clauses have other callers, and an endpoint serves none of them.** Triage's discovery
  view is three label-scoped buckets over unfinished work, oldest first. The web list view wants a
  blocked badge and a "no open blockers" filter of its own. A frontier endpoint answers one question
  for one caller; these filters answer all three, and a fourth question nobody has asked yet.
- **A dedicated endpoint would be a second place the exclusion rules have to be re-stated.** Every
  server-side task read has to compose the effort exclusion, workspace access and team scoping. A
  parallel endpoint reproduces all of it, and the reproduction is where the next leak lives.
- **The round-trip argument is already satisfied.** The reason to want an endpoint was N+1; a
  composition that the server resolves in one query is one round trip too. The endpoint would buy
  nothing but a shorter URL.
- **The one honest argument for an endpoint — a single place to get the blocker predicate right —
  is answered without one.** `openBlockersWhere` in `services/tasks.ts` is that single place, and
  the `blockers` parameter is its only entry point on the read path.

The cost we accepted: the frontier's *definition* now lives in the caller, so two callers can
disagree about what takeable means. That is a real risk and it is the reason the parameter names had
to be chosen carefully rather than quickly — they are the vocabulary every agent runtime will speak.

## Considered options

- **`GET /efforts/:idOrKey/frontier`** — one round trip, one definition, one place for the blocker
  predicate. Rejected: it serves exactly one caller, duplicates access and exclusion logic, and
  hard-codes "unfinished + unassigned + unblocked" so a human surface cannot ask for a variation
  ("takeable, but assigned to me") without a second endpoint.
- **Generic filters with no `blockers` parameter**, leaving the agent to filter client-side.
  Rejected: the only signal a client has is `_count.blockingDependencies`, which counts every edge
  ever created and reports a task whose blockers are all DONE as blocked forever. Pushing the
  predicate to the client guarantees the wrong answer.

## Consequences

`status` is spelled `unfinished`, not `open`. Taskara has no concept called open — `unfinished`
already means `NOT IN (DONE, CANCELED)` here (a milestone's `unfinishedTaskPolicy`) — and `active`
was unavailable because `work-health.ts` uses it for a narrower set. Anyone reaching for `?state=open`
out of GitHub habit is reaching for the wrong tracker's word.

`blockers` is named for the dependency edge and not for `status: BLOCKED`, which is a self-declared
status and an unrelated claim. Both concepts now exist in the query surface and they must not be
conflated in later work.
