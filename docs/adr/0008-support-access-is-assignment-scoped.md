# Support access is assignment-scoped and revocation removes every projection

An ordinary Department member reads only Support Cases currently assigned to their own active
Department membership. Membership alone does not reveal the Department Inbox or a peer's Case.
Department managers read and dispatch their Departments; an explicit triager grant adds unrouted
Cases and by itself grants only those; explicit Support supervisors and Workspace owners/admins read
all Support Cases. Human Department memberships and Support grants compose. `GUEST` and a
browser-authenticated `UserKind.AGENT` have no Support access. `WorkspaceRole.AGENT` grants no
Support access by itself; a human holding that workspace role still needs a Department membership
or explicit Support grant.

This predicate is server-owned and applies to every shipped Support read path: list, detail, search,
counts, reports, sync, notifications, contact hydration, calls, assistance/quality and
cross-Workspace links. It also governs any common-activity projection that contains Support Case
data. Any future attachment, export or model-context path must use the same predicate. Unauthorized
entity reads return `404` where existence is sensitive. A menu or client-side filter is not part of
the security boundary.

## Why

- The product requirement is stricter than a private group. Peers inside the same Department must
  not infer one another's customer, Case title, workload, conversation or outcome.
- A Case transfer revokes access immediately. A row delivered earlier through sync, inbox or a
  notification is still a leak if another reader can hydrate it from stale local state.
- Credentials are bearer authorities, not their holder's human session. An agent credential bound
  to an owner User gets only explicit `SupportCredentialGrant` scopes, evaluated before human role
  implications.
- Contact data is needed before a Case exists during authorized intake, but contact search must not
  become a side channel for Case counts, ownership or history.

## Revocation and browser state

Workspace role, Support grant and Department membership/role changes increment a per-user
`SupportAccessEpoch` transactionally. Support sync is audience-specific: it bootstraps only
currently readable hot Cases, publishes `removeFromScope` when ownership changes, and rejects a
cursor whose access epoch is stale. Notifications are re-gated when read because assignment may
have changed since delivery.

The v1 Support store is memory-only and partitioned by Workspace and authenticated User. It keeps no
Case body, requester, interaction or offline mutation in localStorage/IndexedDB and clears on
logout, Workspace switch or access-epoch reset. Counts and reports are scoped on the server and
suppress aggregates that would expose a peer's private workload.

## Sensitive media boundary

[ADR-0004](./0004-attachments-are-capability-urls.md) records that current attachment URLs are
permanent capabilities: removing access cannot revoke a URL already seen. That posture is
incompatible with private Case recordings and sensitive attachments. Operational Support v1 stores
call metadata and consent only; recordings and Support attachments do not use the current media
path. Shipping them requires authenticated, expiring and revocable media plus a retention/redaction
decision.

Interaction bodies are separated from immutable envelopes and audit events. The encrypted-content
schema preserves the metadata needed for a future authorized retention/redaction path while
provenance, ordering and non-sensitive SLA evidence remain; no such command or job ships today.
Append-only Case events never contain requester PII or conversation bodies.

## Consequences

- Routing points the assignee at a real membership in the owning Department; a compound foreign key
  rejects cross-Department and cross-Workspace combinations, while services also require it active.
- Transfer, assignment, lifecycle/version, next action, events and audience effects commit in one
  optimistic transaction. Moving Departments clears an invalid member assignee.
- Deactivating a membership clears its assignment from every `nonClosed` Case before access is
  removed. Actionable Cases return to the Department Inbox; resolved history stays out of the
  dispatch queue. A Department with `nonClosed` work cannot be deactivated until that work is
  transferred.
- Duplicate relations and Case–Task links grant no access to either source aggregate.

## Considered options

- **Every Department member sees its Department.** Rejected: directly contradicts peer privacy.
- **Send everything and filter in the browser.** Rejected: payloads, caches, counts and devtools are
  disclosures even when the rendered row is hidden.
- **Persist Support sync like Task sync.** Rejected for v1: stale encrypted-at-rest browser data can
  outlive a transfer and reappear before reauthorization.
- **Reuse permanent attachment capability URLs.** Rejected: access revocation would stop at the most
  sensitive content.
