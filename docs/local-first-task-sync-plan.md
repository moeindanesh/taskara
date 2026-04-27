# Local-First Task Sync Plan

## Purpose

The web task panel currently treats most writes as server-first. `TasksView` loads tasks, projects, teams, users, and views together, and task create/update/delete paths often call `load()` after a mutation. This makes every task change feel like a full refresh and prevents other open clients from seeing changes until they refetch.

The target architecture is local-first for the task surface:

- User actions update local state immediately.
- Mutations are queued, idempotent, retried, and acknowledged in the background.
- Server state remains authoritative.
- Connected clients receive lightweight realtime notifications and pull only the incremental changes they missed.
- Full reloads happen only for initial bootstrap, old cursor recovery, schema migration, auth/workspace changes, or unrecoverable sync errors.

## Research Summary

Linear publicly describes a realtime sync engine as core to the product, and its published talk page says the architecture and API evolved around scaling that engine. A community summary of Linear's talks describes a normalized object graph, a persisted IndexedDB transaction queue, WebSocket-driven remote change notification, and local reactivity to update UI without manual request handling. That is the right product shape for Taskara, but Taskara can start with a simpler server-authoritative event-log model rather than a full object ORM.

The local-first software paper argues that server-centric apps force mutations through a network round trip, while local-first apps keep the user's local copy usable and sync in the background. This directly maps to task status, assignee, priority, due date, and title edits: the UI should never wait on the network before reflecting a user's intent.

Replicache's production pattern is also a good fit: local mutators update a client store immediately, a push endpoint sends queued mutations, a pull endpoint returns canonical changes since a cursor, and a lightweight "poke" over SSE/WebSocket tells clients to pull. Replicache's rebase model is more infrastructure than we need to adopt as a library right now, but the concepts are worth copying.

For ordinary optimistic UI, TanStack Query and Apollo both converge on the same core practice: write the optimistic value into the local cache, cancel or guard against stale refetches overwriting it, snapshot previous state, and rollback or reconcile when the server responds. Apollo also keeps optimistic data separate from canonical data, then removes the optimistic layer when the server result arrives. Taskara should follow that layered approach instead of replacing the whole task list.

For fan-out, Server-Sent Events are enough for the MVP because task updates are still written through HTTP requests and realtime traffic is server-to-client. MDN documents SSE as a one-way server stream with built-in reconnect, event ids, retry hints, named events, and keep-alive comments. Because native `EventSource` cannot set custom auth headers reliably, Taskara should use short-lived stream tokens or a fetch-based SSE client. PostgreSQL `LISTEN`/`NOTIFY` can wake up API instances after commit, but it is not a durable event store and payloads are limited; use it only to signal that durable rows exist in a sync event table.

Sources:

- Linear, "Scaling the Linear Sync Engine": https://linear.app/blog/scaling-the-linear-sync-engine
- Local-First Conf 2025, "Building a synchronous experience with asynchronous data: Linear's sync engine": https://app-2025.localfirstconf.com/schedule/talks-day-1/linear
- Fujimon summary of Linear sync talks: https://www.fujimon.com/blog/linear-sync-engine
- Kleppmann et al., "Local-First Software": https://martin.kleppmann.com/papers/local-first.pdf
- Replicache docs: https://doc.replicache.dev/
- Replicache architecture summary: https://queryplane.com/docs/blog/replicache-local-first-sync
- TanStack Query optimistic updates: https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
- Apollo optimistic mutation lifecycle: https://www.apollographql.com/docs/react/performance/optimistic-ui
- MDN Server-Sent Events: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- PostgreSQL `NOTIFY`: https://www.postgresql.org/docs/current/sql-notify.htm
- MDN Web Locks API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- MDN Broadcast Channel API: https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API
- Chrome IndexedDB durability notes: https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed

## Current Codebase Findings

- [apps/web/components/taskara/tasks-view.tsx](/Users/hypermadar/Workspace/taskara/apps/web/components/taskara/tasks-view.tsx) owns live task state with local React `useState`, not a domain-level task store.
- `load()` fetches `/tasks`, `/projects`, `/teams`, `/users`, and `/views` together, then replaces all local arrays.
- Task creation waits for `POST /tasks`, optionally uploads attachments, resets composer state, then calls `load()`.
- Task updates call `PATCH /tasks/:key`, patch the returned item into the local array, then call `load()` for most fields.
- Task delete removes the task locally, then calls `load()`.
- [apps/web/components/taskara/issue-page.tsx](/Users/hypermadar/Workspace/taskara/apps/web/components/taskara/issue-page.tsx) has its own independent task state and activity fetches, so list/detail pages can drift.
- [apps/web/lib/taskara-client.ts](/Users/hypermadar/Workspace/taskara/apps/web/lib/taskara-client.ts) forces `cache: 'no-store'` and has no shared cache, client id, mutation id, retry policy, or sync hooks.
- [apps/api/src/services/tasks.ts](/Users/hypermadar/Workspace/taskara/apps/api/src/services/tasks.ts) already increments `Task.version` on update, which gives us a useful conflict and reconciliation primitive.
- The API has no realtime route, sync cursor, durable event log, idempotency table, or active-client fan-out.

## Recommended Architecture

Use a transaction-outbox sync engine, not a CRDT engine, for the first implementation.

Task fields are mostly scalar and server-authoritative: title, description, status, priority, assignee, project, due date, parent, cycle. That does not require CRDT complexity. We can get Linear-like responsiveness with:

- A normalized local task store.
- A persistent mutation outbox.
- Server idempotency by `clientId + mutationId`.
- A durable `SyncEvent` table with monotonically increasing cursors.
- SSE/WebSocket "poke" notifications.
- Incremental pull and local reconciliation.

Keep the canonical PostgreSQL database as the source of truth. The local browser store is the fast working copy plus unacknowledged mutations.

## Data Model Changes

Add a durable event log:

```prisma
model WorkspaceSyncState {
  workspaceId String @id @db.Uuid
  nextSeq     BigInt @default(1)
  updatedAt   DateTime @updatedAt
}

model SyncEvent {
  id           String   @id @default(uuid()) @db.Uuid
  workspaceId  String   @db.Uuid
  workspaceSeq BigInt
  entityType   String
  entityId     String   @db.Uuid
  operation    String
  entityVersion Int?
  actorId      String?  @db.Uuid
  clientId     String?
  mutationId   String?
  payload      Json
  createdAt    DateTime @default(now())

  @@unique([workspaceId, workspaceSeq])
  @@index([workspaceId, entityType, entityId])
  @@index([workspaceId, clientId, mutationId])
}
```

Do not use a plain global autoincrement value as the sync cursor. PostgreSQL sequences are not transactional, so two concurrent transactions can receive sequence values in one order and commit in another; a client that advances past the later committed value can miss the earlier transaction when it commits. Allocate `workspaceSeq` by locking and incrementing `WorkspaceSyncState` inside the same transaction as the task write and event insert. Serialize all cursors as decimal strings because JavaScript cannot safely round-trip arbitrary `BigInt` values through JSON numbers.

Add an idempotency/ack table:

```prisma
model ClientMutation {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String  @db.Uuid
  userId      String  @db.Uuid
  clientId    String
  mutationId  String
  name        String
  status      String
  resultWorkspaceSeq BigInt?
  errorCode   String?
  errorMessage String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([workspaceId, clientId, mutationId])
  @@index([workspaceId, userId, createdAt])
}
```

Task changes:

- Keep `Task.version`; increment on every server-side task mutation.
- Add `version` to `TaskaraTask` in [apps/web/lib/taskara-types.ts](/Users/hypermadar/Workspace/taskara/apps/web/lib/taskara-types.ts) so the client can send `baseVersion` and reconcile canonical acks.
- Consider allowing client-generated `Task.id` on create for true local-first identity. If that feels too broad, use `clientTempId` in the event payload and reconcile temp id to server id on ack.
- Add tombstone events for deletes. Do not depend on a deleted task row being present for clients to remove it.

Retention:

- Keep sync events for at least 30 days initially.
- If a client cursor is older than retention, return `resetRequired: true` and force a scoped bootstrap.

## API Contracts

### Bootstrap

`GET /sync/bootstrap?scope=tasks&teamId=all`

Returns:

```ts
type BootstrapResponse = {
  cursor: string;
  serverTime: string;
  tasks: TaskaraTask[];
  projects: TaskaraProject[];
  teams: TaskaraTeam[];
  users: TaskaraUser[];
  views: TaskaraView[];
};
```

Use this on first load, workspace switch, schema version mismatch, or old-cursor reset.

### Pull

`GET /sync/pull?cursor=123&scope=tasks&teamId=all`

Returns ordered events after the cursor that the current user is authorized to see:

```ts
type PullResponse = {
  cursor: string;
  resetRequired?: boolean;
  events: SyncEventPayload[];
};
```

The pull endpoint enforces workspace membership and scope filters. The stream can be broad, but pull must be authoritative.

Pull must be scope-aware, not just event-aware. A task can move into the current view because its project, team, assignee, status, or completion state changed; it can also move out of the view for the same reasons. For every task event, the server should compare the task's before and after visibility against the client's subscribed scopes and return one of:

- `upsert` with a full task payload when the task now belongs in the local scope;
- `removeFromScope` when the task no longer belongs in that scope but is not globally deleted;
- `delete` when the task was deleted;
- no event when neither before nor after is visible.

This avoids the hidden edge case where a client never learns about a task that moved into its filtered/team/my-issues view.

### Push

`POST /sync/push`

Accepts a batch:

```ts
type PushRequest = {
  clientId: string;
  mutations: Array<{
    mutationId: string;
    name:
      | 'task.create'
      | 'task.update'
      | 'task.delete'
      | 'task.comment.create'
      | 'task.attachment.add'
      | 'task.label.add'
      | 'task.label.remove';
    args: unknown;
    baseVersion?: number;
    createdAt: string;
  }>;
};
```

Returns per-mutation acknowledgements:

```ts
type PushResponse = {
  cursor: string;
  results: Array<{
    mutationId: string;
    status: 'applied' | 'duplicate' | 'rejected' | 'conflict';
    workspaceSeq?: string;
    entity?: unknown;
    error?: { code: string; message: string; retryable: boolean };
  }>;
};
```

Implementation rule: every mutation runs in a database transaction that:

1. Validates permissions and business rules.
2. Applies the canonical write.
3. Inserts or updates `ClientMutation`.
4. Inserts `SyncEvent`.
5. Commits.
6. Publishes a post-commit poke to connected clients.

Existing REST routes can remain for compatibility, but the web task panel should migrate to `/sync/push` so all writes share idempotency, event creation, and acknowledgements.

### Stream

`GET /sync/stream?token=<short-lived-token>&cursor=123`

Send SSE events:

```text
id: 124
event: sync
data: {"cursor":"124","entityTypes":["task"],"workspaceId":"..."}

: keepalive
```

Rules:

- Use `id:` so reconnect can resume from `Last-Event-ID`.
- Send keep-alive comments every 20-30 seconds.
- Do not put sensitive task payloads in the stream. Treat it as a wake-up signal.
- On reconnect, client immediately calls pull from its last durable cursor.
- Use a short-lived stream token because the current web client authenticates API requests with an `Authorization` header, and native `EventSource` is awkward for that. Alternatively, use a fetch-based SSE client that can set headers.
- Configure reverse proxies for streaming: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, disabled response buffering/compression for this route, and heartbeat comments that are more frequent than proxy idle timeouts.
- Native SSE has per-origin connection limits on HTTP/1.1. Prefer one stream-owning tab per browser profile, then distribute stream pokes to other tabs with `BroadcastChannel`.

## Server Fan-Out Strategy

Phase 1: single API process

- Implement an in-memory `SyncHub`.
- Each connected SSE client registers `{workspaceId, userId, clientId, scopes, send}`.
- After a successful task transaction commits, publish `{workspaceId, cursor, entityTypes}` to that workspace's connections.
- Clients ignore their own acked mutation by matching `clientId/mutationId`, but still advance cursor.
- If the current process restarts, connected clients reconnect and pull by cursor. No correctness may depend on in-memory hub state.

Phase 2: multiple API instances

- Keep `SyncEvent` as the durable source.
- Use PostgreSQL `LISTEN/NOTIFY` only as a wake-up signal after event insertion.
- API instances receiving the notification call pull/read by `workspaceSeq` and publish local SSE pokes.
- Monitor `pg_notification_queue_usage`.
- Move to Redis Pub/Sub, NATS, or a managed event bus if connection count or notification volume grows.

Do not build the durable sync system on `LISTEN/NOTIFY` alone. PostgreSQL notifications are delivered after commit and are useful for signaling, but payload size is limited and notifications are not a replacement for an event table.

The current API uses Prisma and does not have a direct PostgreSQL driver dependency for `LISTEN`. If we choose Postgres notifications, add a dedicated listener connection through `pg` or equivalent; do not try to multiplex this through Prisma query calls.

## Web Client Design

Create a domain sync layer under `apps/web/lib/sync` and move task state out of `TasksView`.

Recommended modules:

- `client-id.ts`: creates and persists a UUID per browser profile.
- `local-db.ts`: IndexedDB wrapper for canonical entities, outbox, sync metadata, and schema version.
- `task-store.ts`: Zustand store or `useSyncExternalStore` facade over normalized data.
- `task-mutators.ts`: local mutators for create/update/delete/comment/label actions.
- `outbox.ts`: queues, retries, exponential backoff, and per-mutation status.
- `sync-client.ts`: bootstrap, push, pull, stream reconnect, and cursor persistence.
- `task-selectors.ts`: scoped, filtered, grouped, and sorted task views.
- `tab-coordinator.ts`: Web Locks based leader election for the stream/outbox flusher, with `BroadcastChannel` updates for non-leader tabs.

Local store shape:

```ts
type LocalTaskState = {
  entities: Record<string, TaskaraTask>;
  deletedIds: Record<string, true>;
  pendingByEntityId: Record<string, string[]>;
  outbox: Record<string, LocalMutation>;
  cursor: string | null;
  syncStatus: 'idle' | 'syncing' | 'offline' | 'error';
};
```

Use selectors to derive list rows instead of storing pre-filtered arrays. `TasksView` should subscribe to selectors and dispatch mutators; it should not fetch and replace the whole world after every write.

Persist local mutations before broadcasting them into React state. If the UI updates first and the tab crashes before the outbox write commits, the user sees a change that cannot sync. Use one IndexedDB transaction for canonical-base changes, optimistic overlays, outbox enqueue, and cursor metadata where possible. For schema migrations and critical outbox state, consider `strict` IndexedDB durability when available; for normal entity cache writes, relaxed durability is acceptable because the server can rehydrate.

## Optimistic Mutation Rules

### Create task

1. Generate `clientId`, `mutationId`, and either a real UUID task id or a temp id.
2. Build an optimistic task with:
   - temp key like `...` or `NEW`
   - selected project/team references from local cache
   - `version: 0`
   - `pending: true`
3. Insert it into the local store immediately.
4. Queue `task.create`.
5. Push in the background.
6. On ack, replace temp id/key with canonical id/key and clear pending state.
7. On rejection, remove the optimistic task and show a recoverable composer error.

### Update task

1. Snapshot the previous task and current `version`.
2. Apply the patch locally immediately.
3. Queue `task.update` with `baseVersion`.
4. On ack, merge the canonical server task and clear pending state.
5. On retryable network failure, keep local state and show a subtle offline/pending indicator.
6. On validation/permission failure, rollback that mutation and show a toast.
7. On conflict, pull latest canonical state, replay still-valid pending local mutations, and surface a conflict note only when the same field was changed concurrently.

Do not rollback by blindly restoring an old snapshot if there are later pending mutations on the same task. Keep a canonical base plus an ordered optimistic operation log. When a mutation fails or a remote event arrives, rebuild the visible task by applying remaining pending operations on top of the newest canonical entity.

### Delete task

1. Mark the task locally as deleted/tombstoned immediately.
2. Queue `task.delete`.
3. On ack, keep tombstone until old events are compacted.
4. On failure, restore the snapshot.
5. If a remote delete arrives while local updates are pending, delete wins and pending updates are rejected locally.

### Labels

Replace full-list label updates with set operations:

- `task.label.add`
- `task.label.remove`

This avoids conflicts where two users add different labels and one update overwrites the other.

### Attachments

Treat uploads separately at first:

- Create task/comment optimistically.
- Upload files after the canonical task/comment exists, or allow uploads against a client-generated id if the server accepts client ids.
- Emit `task.attachment.added` events so all clients update counts and detail pages.

Attachment uploads are not safe to retry blindly unless the upload itself is idempotent. Include an upload idempotency key or object key in the mutation, and handle the case where the file upload succeeds but the acknowledgement is lost. Large files should not live in IndexedDB outbox by default; queue metadata and require the `File` object to remain available only during the active session unless a later offline-file design is added.

## Conflict Policy

Start pragmatic and explicit:

- Server commit order is authoritative.
- Disjoint field updates merge naturally.
- Same-field concurrent updates are last-write-wins by server commit order.
- Deletes beat updates.
- Project moves get a new canonical key from the server; clients reconcile key changes.
- Labels use add/remove operations.
- Comments are append-only, so no conflict beyond duplicate mutation id handling.

Use `Task.version` and `baseVersion` for conflict detection. The server can still accept stale mutations if the changed fields do not overlap with changes since `baseVersion`. To do that, store enough changed-field metadata in `SyncEvent.payload` to compare overlap.

## Edge Case Matrix

| Area | Edge case | Required behavior |
| --- | --- | --- |
| Cursor ordering | Concurrent transactions allocate cursor ids before commit | Use a per-workspace transactional sync clock, not a non-transactional global sequence cursor. |
| Cursor serialization | `BigInt` cursor crosses JSON/browser boundaries | Serialize cursors as strings everywhere. Never emit cursor numbers in JSON. |
| Cursor retention | Client reconnects with a cursor older than retained events | Return `resetRequired: true`; client does scoped bootstrap and clears stale local events. |
| Duplicate delivery | SSE poke, pull retry, or reconnect delivers the same event twice | Event application must be idempotent by `workspaceId + workspaceSeq`. |
| Lost poke | API process restarts or `LISTEN/NOTIFY` wake-up is dropped | Client periodic/visibility/focus pull catches up by durable cursor. Correctness does not depend on pokes. |
| Own writes | Client receives stream poke for its own mutation before or after push ack | Match `clientId + mutationId`; advance cursor, merge canonical entity, avoid duplicate toasts. |
| Push response lost | Server applies mutation but client times out before ack | Retry returns duplicate ack with original `workspaceSeq` and canonical result from `ClientMutation`. |
| Batch partial failure | First mutation in batch succeeds, second fails | Process in client order. Return per-mutation result. Dependent later mutations stay queued or become blocked until the failed mutation is resolved. |
| Multi-tab flush | Two tabs flush the same outbox concurrently | Use Web Locks leader election. Server idempotency remains the backstop. |
| Multi-tab state | One tab receives stream events while another is visible | Use `BroadcastChannel` to publish local events, cursor updates, auth changes, and outbox status to same-origin tabs. |
| Native SSE limits | More than a few tabs exceed HTTP/1.1 connection limits | Keep one stream leader per browser profile and fan out to other tabs. HTTP/2 still needs backpressure and connection accounting. |
| Stream auth | Bearer token is stored in localStorage and native `EventSource` cannot set headers | Use fetch-based SSE with `Authorization`, or mint a short-lived stream token through authenticated HTTP. Do not use long-lived tokens in URLs. |
| Token expiry | Auth/session expires while stream is open | Server closes or sends auth-expired event; client stops syncing, clears sensitive local state for that user, and routes to login. |
| Workspace switch | Same browser profile switches workspaces | Local DB keys include `workspaceId + userId`. Stop stream, flush or pause old outbox, load the new workspace cursor and cache. |
| Logout/account switch | Different user logs in on same origin | Clear or namespace local cache/outbox by user id. Never show previous user's cached tasks. |
| Permission loss | User is removed from workspace/team while connected | Pull/stream returns 403 or a permission event; client removes inaccessible scoped data and stops pushing queued mutations for that scope. |
| Scope movement | Task moves into current team/my-issues/filter scope | Pull returns full `upsert` even if the task was not previously in the local store. |
| Scope exit | Task moves out of current scope but still exists elsewhere | Pull returns `removeFromScope`, not global delete, unless the client has a broader scope containing it. |
| Partial local cache | Client has only first page or current team cached | Selectors must know cache completeness per scope. Do not compute global counts from partial data unless the scope is complete. |
| Pagination | Existing `/tasks?limit=100` hides older tasks | Bootstrap/pull must either load all rows for the subscribed scope or include page cursors and count metadata. |
| Sidebar counts | My-issues and inbox counts currently come from separate fetches | Either derive counts from complete local scopes or add count events/summaries. Do not let task sync make sidebar badges stale. |
| Project/team changes | Task event references a project/team not in local cache | Event includes minimal project/team snapshot or triggers a resource pull before rendering. |
| User profile changes | Assignee/reporter name or avatar changes | Add user/resource sync events or tolerate stale user snapshots with periodic resource refresh. |
| Label creation | User adds a label name that does not exist | Server creates or resolves label id atomically and emits label metadata before or with the task label event. |
| Label concurrency | Two users edit labels concurrently | Use add/remove label operations, not full replacement arrays. |
| Same-field conflict | Two users edit `title` from the same base version | Server commit order wins unless product chooses conflict UI. Client should show a small conflict notice when its local same-field edit loses. |
| Disjoint conflict | One user edits `status`, another edits `priority` from stale base | Server accepts both by comparing changed fields since `baseVersion`. |
| Delete/update race | One client deletes while another has pending updates | Delete wins. Pending updates are rejected or transformed into no-ops with user-visible notice. |
| Project move | Task project changes and key is regenerated | Server emits canonical task with new key and old key alias so routes and optimistic rows remap cleanly. |
| Parent/subtask updates | Parent deletion or subtask creation changes counts | Emit affected parent task events or count delta events. Detail and list rows must update `_count.subtasks`. |
| Dependencies | Dependency add/remove affects blocked state and counts | Emit events for both tasks affected by the relationship, not just the dependency row. |
| Comments | Detail page adds comment while another client watches activity | Emit `task.comment.created` plus affected task count/activity event. Comments are append-only and sorted by server `createdAt`. |
| Activity timeline | Activity is currently loaded separately | Either sync activity events or invalidate only the activity stream for that task, not the whole task list. |
| Attachments | File upload succeeds but task attachment mutation ack is lost | Use upload/object idempotency keys and return duplicate ack with existing attachment. |
| Local crash | Browser closes after UI update but before outbox persists | Persist outbox and optimistic operation first; render after local transaction commits. |
| Storage unavailable | IndexedDB is blocked, private, quota-limited, or evicted | Fall back to memory/online-only mode, disable offline claims, and show sync status. Rebootstrap if persisted cache disappears. |
| Schema migration | IndexedDB schema changes while multiple tabs are open | Coordinate migration with Web Locks. Other tabs close/reopen DB and rebootstrap if needed. |
| Offline detection | `navigator.onLine` lies or network is captive | Treat failed requests as the source of truth. Retry with backoff and jitter. |
| Backpressure | Client falls far behind or event batch is huge | Pull supports `limit`, returns `hasMore`, and client loops without blocking the UI thread. |
| Server deploy | API restarts while push is in flight | Client retries idempotently. Stream reconnect then pulls from last durable cursor. |
| REST compatibility | Existing `/tasks` routes mutate tasks outside `/sync/push` | REST routes must insert sync events in the same transaction, or web clients will miss external writes. |
| Mattermost/agent writes | Integrations call task services directly | Shared task service must emit sync events for all write sources: web, API, Mattermost, Codex, agent, system. |
| Audit failure | Activity logging after task commit fails | Sync event must be in the task transaction. Consider moving activity logging into the same transaction too, or make activity failure non-fatal after the response. |
| Clock skew | Client optimistic timestamps differ from server time | Use client timestamps only for temporary rendering. Server timestamps replace them on ack. |
| Sorting jumps | Server canonical data changes optimistic sort position | Accept small movement after ack; preserve keyboard selection by task id/key remapping. |
| Search/filter | Optimistic edit causes row to stop matching current query | Apply the same selectors locally; optionally show pending mutation status in command/status UI. |
| Undo | User wants to undo a local optimistic change already pushed | Treat undo as a new mutation based on current canonical state, not cancellation unless still unflushed. |
| Security logging | Stream token in URL appears in logs | Prefer fetch-based SSE. If URL token is used, make it short-lived, scoped, single-purpose, and redact query logs. |
| Cross-origin/dev env | `WEB_ORIGIN` and allowed origins differ by environment | Stream CORS must match existing API auth behavior and must not allow arbitrary origins with credentials. |

## Replacing Full Refreshes

Short-term changes in `TasksView`:

- Remove `load()` calls from successful create/update/delete paths.
- Use local task mutators that patch the normalized store.
- Split task data from slow-moving resources. Projects, teams, users, and views should not refetch after every task update.
- Keep a manual "refresh" command for debugging and recovery.

Medium-term:

- `TasksView` boots from `sync/bootstrap`.
- Task rows are rendered from the local store.
- Realtime stream triggers `pull`, not `load`.
- `IssuePage` reads the same task entity from the shared store and subscribes to activity/comment events.

Full refresh remains allowed for:

- first visit;
- workspace/team scope switch before scope-specific cache exists;
- sync cursor too old;
- IndexedDB schema migration;
- auth change;
- explicit user refresh;
- unrecoverable parse/data corruption.

## Permissions And Privacy

- All sync endpoints must call `getRequestActor`.
- Cursor values are not authorization. Every pull response must filter by the actor's workspace and allowed scope.
- Stream tokens should be short-lived and bound to user/workspace/client id.
- Do not include full task payload in SSE pokes unless the stream is authenticated with the same strength as normal API calls.
- Validate client-generated ids as UUIDs and require workspace ownership.
- Idempotency is scoped by `workspaceId + clientId + mutationId`, not mutation id alone.

## Observability

Add structured logs and metrics:

- active stream connections by workspace;
- sync event insert rate;
- fan-out latency from commit to client poke;
- pull latency and event count;
- outbox pending count and oldest pending age;
- mutation retry count;
- mutation rejection/conflict count;
- cursor reset count;
- IndexedDB bootstrap duration;
- client event lag: latest server cursor minus local cursor;
- stream leader tab count and failover count;
- Postgres notification queue usage if using `LISTEN/NOTIFY`.

Add a small debug panel in development that shows:

- client id;
- cursor;
- stream state;
- pending mutations;
- last pull result;
- last sync error.

## Rollout Plan

### Phase 0: Guardrails

- Add tests that prove current create/update/delete behavior.
- Add task fixtures for two clients editing the same workspace.
- Add a feature flag: `VITE_TASKARA_TASK_SYNC_ENGINE`.

### Phase 1: Local Optimistic Store

- Create the normalized task store and selectors.
- Move `TasksView` reads/writes to the store.
- Keep existing REST APIs.
- On mutation success, reconcile with returned canonical task.
- On failure, rebuild visible state from canonical data plus remaining optimistic operations.
- Stop calling `load()` after successful task create/update/delete.

Deliverable: the current tab no longer full-refreshes on task writes.

### Phase 2: Persistent Outbox

- Add persistent `clientId`.
- Add IndexedDB-backed outbox.
- Queue mutations before network calls.
- Retry retryable failures with exponential backoff.
- Keep pending UI indicators.
- Flush on online/focus/visibility changes.
- Add Web Locks leader election so only one tab flushes the outbox and can later own the stream.
- Add BroadcastChannel fan-out so all same-origin tabs update from the leader.

Deliverable: user edits survive reload and short offline windows.

### Phase 3: Server Event Log And Idempotent Push

- Add `WorkspaceSyncState`, `SyncEvent`, and `ClientMutation` tables.
- Implement `/sync/bootstrap`, `/sync/pull`, and `/sync/push`.
- Make task service writes insert sync events inside the same transaction.
- Allocate `workspaceSeq` with a transactional workspace clock and test concurrent commit ordering.
- Update Mattermost/agent task writes to emit the same events.

Deliverable: every task write creates a durable, ordered event.

### Phase 4: Realtime Active Client Updates

- Implement `/sync/stream`.
- Implement in-memory `SyncHub`.
- Connect web clients after bootstrap.
- On poke, call pull from the last cursor and apply only returned events.
- Add reconnect and old-cursor reset behavior.
- Make pull scope-aware so tasks moving into or out of a user's active scope are represented correctly.

Deliverable: all active browser clients in the workspace see task create/update/delete without manual refresh.

### Phase 5: Multi-Instance Fan-Out

- Add PostgreSQL `LISTEN/NOTIFY` or Redis/NATS fan-out between API instances.
- Keep event table as durable truth.
- Add backpressure and connection limits.

Deliverable: realtime updates work across horizontally scaled API instances.

### Phase 6: Conflict Hardening

- Add field-level changed metadata to events.
- Add stale-base conflict tests.
- Convert labels to add/remove operations.
- Add delete-vs-update behavior.
- Add user-facing conflict copy for rare same-field collisions.

Deliverable: concurrent edits behave predictably and do not silently lose common updates.

## Test Plan

Unit tests:

- task reducer applies create/update/delete events;
- optimistic update snapshots and rollback;
- optimistic overlay replay preserves later pending edits when an earlier mutation fails;
- id remapping from temp id to canonical id;
- selectors preserve filters/grouping/sorting;
- outbox retry and idempotency state transitions;
- scope selectors distinguish complete and partial caches.

API tests:

- `POST /sync/push` applies mutations and writes events atomically;
- duplicate `clientId + mutationId` returns duplicate ack, not a second task;
- `GET /sync/pull` returns ordered events after cursor;
- pull filters by workspace and team scope;
- pull returns `upsert` for tasks that move into scope and `removeFromScope` for tasks that move out;
- stale cursor returns `resetRequired`;
- task REST routes still emit events while compatibility remains;
- concurrent transactions cannot produce a missed event when clients advance cursors;
- lost push response followed by retry returns the original canonical result.

Integration tests:

- two browser contexts on the task list: client A creates a task, client B sees it without refresh;
- two tabs in one browser profile: one stream/outbox leader, both tabs update;
- client A changes status, client B sees it move groups;
- client B edits a task while client A has a pending update;
- task reassignment makes it appear in another user's my-issues view and disappear from the old assignee's my-issues view;
- offline edit queues locally, reload preserves pending mutation, reconnect flushes it;
- reconnect uses last cursor and does not miss events;
- auth logout or workspace switch stops the stream and prevents old cached data from showing;
- deleted task disappears from list and detail page;
- issue detail and task list stay consistent;
- IndexedDB unavailable mode falls back without claiming offline support.

Performance tests:

- apply 1,000 task events without replacing whole arrays repeatedly;
- stream 500 connected clients in a workspace in staging;
- measure commit-to-render latency target under 500 ms on a healthy connection;
- measure local optimistic render target under 50 ms.

## Implementation Notes For This Repo

- Keep the API source of truth in `apps/api/src/services/tasks.ts`; do not duplicate task business rules in route handlers.
- Add a `services/sync.ts` module for event insertion and mutation acknowledgements.
- Add `routes/sync.ts` and register it in `apps/api/src/app.ts`.
- Use the existing `Task.version` field; do not introduce another task revision counter.
- Allocate `workspaceSeq` with a single transactional SQL update such as `UPDATE workspace_sync_state SET next_seq = next_seq + 1 WHERE workspace_id = $1 RETURNING next_seq - 1`, wrapped in the same Prisma transaction as the task write and sync event insert.
- Convert all `BigInt` cursor fields to strings at the API boundary.
- Keep current `/tasks` routes during migration, but make them emit sync events too.
- Move shared task response serialization behind one function so events, REST responses, and bootstrap use identical payload shape.
- Convert `TasksView` and `IssuePage` to the same shared task store before enabling realtime, otherwise remote events will fix one surface and leave the other stale.
- Avoid refetching projects/teams/users/views as a side effect of task mutations. Add separate sync event types for those resources later.
- Include enough related snapshots in task event payloads to render current rows: project/team, assignee, reporter, labels, and relevant counts.
- Decide early whether sidebar task counts are derived from complete local scopes or delivered as separate count summaries.

## Risks And Mitigations

- Risk: local store and server diverge.
  Mitigation: canonical ack always wins, periodic low-priority pull, manual reset, schema versioned IndexedDB.

- Risk: stale refetch overwrites optimistic changes.
  Mitigation: stop broad `load()` calls, track pending mutations separately, and replay pending operations after canonical pulls.

- Risk: duplicate task creation on retry.
  Mitigation: require `clientId + mutationId` idempotency.

- Risk: EventSource auth leaks long-lived tokens in URLs.
  Mitigation: short-lived stream tokens or fetch-based SSE with Authorization header.

- Risk: `LISTEN/NOTIFY` drops wake-ups during deploy/reconnect.
  Mitigation: durable `SyncEvent` table and pull by cursor; notifications only prompt clients to pull.

- Risk: local-first scope expands too far.
  Mitigation: start with task create/update/delete, then comments/labels/attachments, then projects/users/views.

## Acceptance Criteria

- Updating task status, priority, assignee, due date, title, or description changes the UI immediately.
- Successful task mutations do not call the broad `load()` path.
- Creating a task inserts a visible optimistic row before the server responds.
- Rejected mutations rollback only the affected optimistic change.
- Two active browser clients in the same workspace receive task create/update/delete changes without manual refresh.
- Reconnect after stream loss pulls missed events by cursor.
- Duplicate mutation retries are idempotent.
- Concurrent server commits cannot make a client miss an event after advancing its cursor.
- Multiple tabs in the same browser profile do not create duplicate streams or duplicate outbox flushes.
- Tasks moving into or out of team/my-issues/filter scopes are added or removed locally without a full refresh.
- Detail page and list page read the same local task entity.
- Full bootstrap is reserved for initial load and documented recovery cases.
