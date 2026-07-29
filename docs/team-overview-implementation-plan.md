# Team Overview (Obsidian-style graph) — Implementation Plan

Make the workspace's main page a force-directed **Team Overview** graph: the workspace at the center, every member connected to it, and each member's **Today Load** (بار امروز) orbiting them as task nodes — color = status, size = weight. Clicking a task opens the issue overlay; clicking a person opens the composer preloaded for them.

Vocabulary is pinned in [`CONTEXT.md`](../CONTEXT.md) (Today Load, Plan, Today, Team Overview). The engine decision is recorded in [ADR-0001](./adr/0001-hand-rolled-svg-force-graph.md).

## Decisions (settled)

| Decision | Resolution |
|---|---|
| Placement | New route `/:orgId/overview`; the `/` redirect sends **all roles** there (`defaultWorkspacePath` in `apps/web/src/App.tsx:239` no longer branches on role). Cockpit stays at `/cockpit`, personal list stays reachable — both in the sidebar. |
| Today Load | Active tasks (`BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`) with `dueAt` ≤ end of today, **all overdue included (no age cap)**, plus `DONE` tasks with `completedAt` today. `CANCELED` and stale `DONE` excluded. "Today" = Tehran `dateKey`, consistent with the daily-report convention. |
| Unassigned tasks | **Excluded** from the graph (deliberate; the cockpit attention queue remains their surface). Reversible later via a synthetic «بدون مسئول» hub. |
| Person nodes | `OWNER`/`ADMIN`/`MEMBER` always shown, even with an empty Today Load (bare node = visible free capacity). `GUEST`/`AGENT` shown only when their Today Load is non-empty. |
| Task color | Reuse the exact per-status colors from `apps/web/components/taskara/linear-ui.tsx` — one status-color language app-wide. Overdue (`dueAt` before start of today) additionally gets a red halo ring. |
| Task size | radius ∝ `√weight` over the legal weights {1, 2, 3, 4, 8} (area tracks weight). `weight = null` → smallest radius with a **dashed outline** ("unestimated", visibly distinct from weight 1). |
| Task click | Embedded `IssuePage` overlay (`taskKey` + `onClose` props — same pattern as `manager-cockpit-view.tsx:340`). Graph pan/zoom/layout survives underneath. |
| Person click | Dispatch `'taskara:create-issue'` CustomEvent with `detail: { assigneeId, dueAt: <today> }` so the created task appears on the graph immediately. Both fields remain editable in the composer. |
| Engine | `d3-force` (only new dependency) + React-managed SVG. See ADR-0001. |
| Interactions v1 | "Obsidian core": pan, wheel zoom, node drag with live physics, hover spotlight (dim non-neighbors), person labels always on, task titles on hover and past a zoom threshold. |
| Data | Pure client-side selector over `useWorkspaceTaskSync()` — no new API endpoint. Live updates arrive via the existing sync SSE stream for free. |

## Non-goals (v1)

- No new API endpoints or schema changes. The graph is a read-only projection of already-synced data.
- No per-user timezones (workspace is Tehran, matching the daily-report plan).
- No mobile-specific layout — pan/zoom must merely remain usable on small screens.
- No search, filter chips, or animated entry/exit (phase 2 — see Ideas).
- Unassigned tasks are not rendered (decided above).

## Architecture

```
apps/web/components/taskara/team-overview-view.tsx   ← route component (naming matches *-view.tsx siblings)
apps/web/components/taskara/team-overview/
  use-team-overview-graph.ts    ← selector: sync store → { nodes, links } (pure core, unit-testable)
  use-force-simulation.ts       ← d3-force lifecycle: tick loop, drag reheat, node identity
  graph-canvas.tsx              ← SVG rendering: <g> per node/link, pan/zoom transform, spotlight
  graph-nodes.tsx               ← WorkspaceNode / PersonNode (avatar) / TaskNode (status fill, halo, dashed)
  today-load.ts                 ← pure Today Load predicate + dateKey helpers (unit-testable)
```

### 1. Data selector (`today-load.ts`, `use-team-overview-graph.ts`)

Input: `tasks`, `users` from `useWorkspaceTaskSync()` (scope is already workspace-wide: `{ teamId: 'all', mine: false }`).

Pure functions:

- `workspaceDateKey(now: Date): string` — Tehran `YYYY-MM-DD` via `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' })`. Mirrors the server's `apps/api/src/services/workspace-time.ts`; keep the constant/timezone aligned. (The daily-report rule "client never computes the day" exists to protect report *writes*; a read-only view filter computed client-side is acceptable and self-corrects at midnight.)
- `isInTodayLoad(task, todayKey): boolean` — implements the settled definition (active + due ≤ end of today Tehran, or DONE with `completedAt` in today).
- `buildGraph(tasks, users, todayKey): { nodes, links }` — one workspace node, person nodes per the people rule, task nodes per person. Node ids are stable (`workspace`, `user:<id>`, `task:<id>`) so d3-force preserves positions across live sync updates.

**Verification step before building:** confirm the sync `users` objects carry the workspace `role` (needed for the GUEST/AGENT rule). If they don't, extend the sync bootstrap user payload in `apps/api/src/routes/sync.ts` (additive field) rather than adding a members fetch to the view.

Memoize on `(tasks, users, todayKey)`; recompute `todayKey` on a minute-level interval so the graph rolls over at Tehran midnight without a reload.

### 2. Simulation (`use-force-simulation.ts`)

- `pnpm add d3-force` (+ `@types/d3-force`) in `apps/web` — the only new packages.
- Forces: `forceLink` (long links workspace→person, short links person→task), `forceManyBody` (mild repulsion), `forceCollide` (radius-aware so big tasks don't overlap), `forceRadial` on person nodes for an even ring; workspace node pinned via `fx/fy` at origin.
- Tick → write positions into a ref, render via `requestAnimationFrame`; stop at `alphaMin`, reheat (`alphaTarget(0.3)`) on drag and on data changes.
- On data change, diff by node id: existing nodes keep `x/y`; new nodes spawn at their parent's position (they visibly "bud off" the person).

### 3. Rendering & interactions (`graph-canvas.tsx`, `graph-nodes.tsx`)

- Single `<svg>` with a `<g transform={translate/scale}>` root. Pan = pointer-drag on the background; zoom = wheel, scaling around the cursor. (Hand-rolled transform state; `d3-zoom` is an acceptable drop-in if pinch support is wanted.)
- Node drag: pointer events set `fx/fy` + reheat; release clears them.
- Hover spotlight: adjacency map; on hover set `data-dimmed` on non-neighbors, styled with token-based opacity transitions.
- Labels: person names always visible under the avatar; task titles render on hover and when `scale > threshold`. SVG `<text>` inherits the app's Persian fonts; the page is already `dir="rtl"`.
- Colors exclusively via CSS variables/Tailwind tokens → dark mode (the default) works untouched. Extract the status→color mapping from `linear-ui.tsx` into a shared constant if it isn't already exported.
- Person node: avatar image in a `clipPath` circle (`avatarUrl`, fallback to initials), workspace node larger at center with the workspace name.

### 4. Click wiring (inside `team-overview-view.tsx`)

- Task node click → local state `openTaskKey`; render `<IssuePage taskKey={openTaskKey} onClose={() => setOpenTaskKey(null)} />` above the graph — copy the cockpit's overlay usage.
- Person node click → `window.dispatchEvent(new CustomEvent('taskara:create-issue', { detail: { assigneeId, dueAt } }))` with `dueAt` = end of today. Match the `TaskComposerOpenDetail` type (`workspace-task-composer.tsx:70`) for the exact `dueAt` format.
- Created/updated tasks flow back through the sync store optimistically → graph updates itself; no imperative refresh.

### 5. Routing, nav, copy (`App.tsx`, `app-sidebar.tsx`, `fa-copy.ts`)

- Add `<Route path="overview" element={<TeamOverviewView />} />` under the `/:orgId` shell in `apps/web/src/App.tsx`.
- Change `defaultWorkspacePath` (`App.tsx:239-241`) to return `/${orgId}/overview` for every role.
- Sidebar entry (all roles) in `apps/web/components/layout/app-sidebar.tsx`; Farsi label in `lib/fa-copy.ts` — proposal: «نمای تیم» for Team Overview.
- Keep existing cockpit/team routes untouched.

## Edge cases

- **Empty workspace / lone owner** — center node + bare person ring renders fine; show a subtle hint («امروز باری ثبت نشده») when zero task nodes exist.
- **Midnight rollover** — `todayKey` interval tick re-filters; yesterday's DONE nodes age out live.
- **`dueAt` boundaries** — "due ≤ end of today" and "overdue = before start of today" are both computed against Tehran day boundaries, not the browser's local midnight.
- **Removed member / reassigned task** — sync store updates propagate; node-id diffing removes or re-parents nodes without a full re-layout.
- **Large overdue backlog** — no age cap by decision; `forceCollide` + √weight sizing keeps clusters readable. If a person's cluster exceeds ~50 nodes, that's a management signal, not a rendering bug.
- **Simulation cost while hidden** — pause the tick loop when the tab is hidden (`visibilitychange`) and when settled.

## Testing

- Unit-test the pure core (`today-load.ts`, `buildGraph`): status/date matrix for the Today Load predicate (each of the 7 statuses × overdue/today/future/null `dueAt`, DONE-today vs stale DONE), people rules (bare humans, loaded vs unloaded GUEST/AGENT), Tehran boundary cases.
- Playwright (already in `apps/web` devDeps): smoke — `/` lands on `/overview` for both an admin and a member session; task-node click shows the issue overlay; person-node click opens the composer with assignee and today preset.

## Build order

1. **Pure core + tests** — `today-load.ts`, `buildGraph`, role-field verification against sync payload.
2. **Static render** — selector → SVG nodes/links with a settled one-shot layout; colors, sizing, halo, dashed outline.
3. **Physics + Obsidian interactions** — live simulation, drag, pan/zoom, spotlight, labels.
4. **Click wiring** — IssuePage overlay + composer event.
5. **Routing/nav/copy** — route, default landing for all roles, sidebar, Farsi labels.
6. Playwright smoke, then ship.

## Ideas backlog (phase 2+ — not in v1)

Each of these builds on models that already exist; none block v1.

1. **Capacity ring on person nodes** — `UserCapacity.dailyWeightLimit` (default 8) already exists per member. Render each person's node with a progress ring of `sum(Today Load weights) / dailyWeightLimit`; over-capacity turns the ring red. Turns the graph into a live workload balancer — the strongest candidate for phase 2.
2. **Dependency edges** — `TaskDependency` (`blockedByTaskId`) is already modeled. Draw edges between task nodes when both ends are on screen; a `BLOCKED` node then shows *what* blocks it, across people.
3. **Daily-report glow** — person node gets a subtle glow/badge once their `CheckInResponse` for today's `dateKey` exists (the sync store's `workspaceData.checkIns` already carries these). Merges the daily-report initiative into the overview at a glance.
4. **Full-fidelity interactions** — search-to-highlight, status/project filter chips, animated node entry/exit, collapsible legend (the deferred interaction tier).
5. **Synthetic «بدون مسئول» hub** — revisit the excluded-unassigned decision by adding an opt-in unassigned hub node whose click opens the composer with no assignee.
6. **Time scrubber** — pick a past `dateKey` and replay that day's load (needs a small history endpoint over `ActivityLog`; server work).
7. **Project constellation mode** — toggle regrouping: projects as hubs instead of people, for a "what's moving where" view.
8. **Cockpit cross-link** — attention-queue items pulse their corresponding task node; clicking an attention card pans/zooms the graph to it.
9. **Menubar mini-graph** — the Electron menubar companion renders a tiny read-only version of the user's own Today Load cluster.
