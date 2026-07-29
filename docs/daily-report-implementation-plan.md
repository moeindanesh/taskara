# Daily Report Implementation Plan

## Goal

Give every workspace member a lightweight end-of-day report — «گزارش روزانه» — with three sections:

1. **کارهایی که انجام دادم** — what I completed today (`completedText`)
2. **کارهای غیرمنتظره‌ای که پیش آمد** — unexpected/unplanned work that landed on me (`unplannedText`, new)
3. **برنامه‌ی بعدی من** — what I plan to do next (`planText`)

plus an optional blocker/ask section («کجا گیر کرده‌ام یا کمک می‌خواهم») reusing `blockersText`/`helpText`.

And give managers one clear morning artifact: a per-day digest that answers "who is blocked, what unexpected work is eating the team, who didn't report, and what should I focus on today" — feeding the existing attention lifecycle rather than creating a parallel one (per the guardrail in `docs/manager-operating-system-implementation-plan.md`: "Check-ins and project health must feed the same attention lifecycle, not create parallel alerting").

## Current State Findings

The backend for this feature is ~70% shipped under the name **check-ins**; what is missing is the submit UI, the read/digest UI, day semantics, the "unexpected work" field, and reminders.

**Already shipped (reuse, do not rebuild):**

- `CheckInResponse` model (`packages/db/prisma/schema.prisma:890–909`): `completedText/blockersText/planText/helpText`, `submittedFor`, `userId` (subject) vs `authorId` (writer), indexed by `[workspaceId, userId, submittedFor]`.
- API: `GET /check-ins`, `POST /check-ins`, `GET /check-ins/missing` (`apps/api/src/routes/check-ins.ts:34–51`; service `apps/api/src/services/check-ins.ts`). Members submit their own; OWNER/ADMIN can submit for others (`authorId` records the ghostwriter).
- Durable offline mutation `check_in.create` (`apps/api/src/routes/sync.ts:500–503`) with Persian label already registered in `apps/web/lib/task-sync.ts:135`; `check_in` sync events are scope-filtered (`sync.ts:860–862`) and already ingested into the client store (`apps/web/lib/workspace-data/store.ts:22`, `apps/web/lib/workspace-data/sync-events.ts:184`) — **no component reads them yet**.
- Manager plumbing: `missing_check_in` attention items (`apps/api/src/services/attention.ts:404–453`), missing-check-in badges in People view (`apps/web/components/taskara/people-workload-view.tsx`), 1:1 agenda candidates generated from latest check-ins (`check-ins.ts:572–666`).
- Auto-draft raw material: `ActivityLog` with `@@index([actorId, createdAt])` (`schema.prisma:1296`) recording task created/updated/commented with before/after snapshots; `POST /agent/daily-plan` (`apps/api/src/routes/agent.ts:61–99`) already computes per-user focus + blocked lists.
- Delivery channels: Kavenegar SMS (`apps/api/src/services/sms.ts`) with `SmsDelivery` audit rows; in-app `Notification` where `type` is a plain String (new types need **no migration**); Mattermost bot with a `daily-digest` command (`apps/mattermost-bot/src/index.ts`); OpenRouter AI-report plumbing (`apps/api/src/routes/ai-reports.ts`) for optional AI summaries.
- An idempotent daily-scheduler skeleton exists in git history: `git show 52062c4:apps/api/src/services/sms-reminders.ts` (60s tick, Tehran 10:00 window, unique-`dateKey` lock via `SmsDailyReminderRun`, run counters). It was deleted in `350684e`; the table survives, orphaned.

**Verified gaps this plan closes:**

1. No submission UI anywhere (web/menubar/bot/plugin). `POST /check-ins` and `check_in.create` have zero callers.
2. No digest/read view; `GET /check-ins` has zero consumers; managers can see *that* a report is missing, never *what* was submitted.
3. No "unexpected work" field — the spec's second question has no column.
4. No canonical "day": `submittedFor` is a raw timestamp, no unique per-day constraint, no timezone anywhere in the schema (Tehran logic lived only in the deleted SMS service), and `submittedFor` is client-supplied and unvalidated.
5. No edit path (POST only — no update endpoint or mutation).
6. No scheduler and no reminders on any channel; attention generation is pull-only (materializes only when an admin opens Cockpit).
7. No per-user "my activity today" endpoint for prefill (`GET /activity` is workspace-wide, take-50, unguarded — `apps/api/src/routes/system.ts:113–121`).
8. Sidebar "manager" gate is `role === 'OWNER'` (`apps/web/components/layout/sidebar/app-sidebar.tsx:81`) while the API's admin concept is OWNER∨ADMIN (`apps/api/src/services/actor.ts:18–19`) — the digest audience must pick one.

## Industry Research

### Formats: the three questions are a proven shape

- **Scrum classic** (Yesterday / Today / Blockers) and **PPP** (Progress / Plans / Problems — used at Skype, eBay, Facebook; discipline of 3–5 bullets per section) both map onto our sections 1 and 3. Martin Fowler's standup patterns warn against "reporting to the leader" and "storytelling" — center updates on work items, keep them short. <https://martinfowler.com/articles/itsNotJustStandingUp.html>, <https://en.wikipedia.org/wiki/Progress,_plans,_problems>
- **Basecamp automatic check-ins** are the strongest precedent for cadence and tone: "What did you work on today?" asked daily at ~4:30 PM, answers required only ~2×/week, freeform, compiled on one page visible to everyone (including founders' answers). "Loose accountability and strong reflection." <https://basecamp.com/guides/how-we-communicate>
- **iDoneThis / Google Snippets**: end-of-day submission, compiled **next-morning digest** — writes and reads each happen at their natural time. <https://blog.idonethis.com/google-snippets-internal-tool/>

### "Unexpected work" as a first-class question is our differentiator

No major standup format asks it (blockers ≠ interrupts), but the DevOps literature treats unplanned work as *the* team-health signal: The Phoenix Project's fourth type of work ("making it visible is the prerequisite to reducing it"), DORA's rework-rate metric, LinearB's planning-accuracy metric, Kanban interrupt swimlanes. Implications: the section should be explicitly OK to leave empty (empty = healthy), and its **frequency should be aggregated as a team trend** ("31٪ of days this month included unplanned work, up from 15٪"). <https://itrevolution.com/articles/10-minute-summary-of-the-phoenix-project/>, <https://dora.dev/guides/dora-metrics/>, <https://linearb.io/planning-accuracy/>

### What kills these features (and the counter-measures we adopt)

- **Write-only reports nobody reads** — the #1 failure mode in every retrospective (Zapier's Geekbot retro, HN threads). Counter: one compiled digest (not N threads), blockers pinned on top, and a norm that managers respond to asks quickly — "leadership follow-through is the biggest killer of async dailies when neglected." <https://zapier.com/blog/asynchronous-standups-geekbot/>, <https://ferderer.de/blog/tech/async-dailys-team-channel-instead-of-standup>
- **Answer friction / recall cost** — counter: **prefill from the activity log** (Steady auto-attaches commits/PRs; ClickUp drafts standups from task activity) and **carry-forward** of yesterday's plan (15Five's Priorities: each planned item is completed / carried / dropped next time). We own the task graph, so this is native. <https://runsteady.com/integrations/github/>, <https://success.15five.com/hc/en-us/articles/360002698971-Check-ins-Feature-Overview>
- **Surveillance smell** — counter: symmetric visibility (reports readable by teammates, not a private manager inbox), managers file reports too, soft participation floor (Basecamp's "answer ~2×/week against a daily prompt"), participation *rate* not streaks (streak mechanics demonstrably backfire into filler reports). <https://basecamp.com/guides/how-we-communicate>, <https://yukaichou.com/gamification-analysis/streak-design-gamification-motivation-burnout/>
- **Reminder bugs are rage-inducing** (Geekbot's top complaint category) — counter: one fixed, predictable Tehran-time schedule for v1; no adaptive cleverness.
- **Standalone standup tools die** (Friday.app, Height, Status Hero pivots): a status layer detached from the work is a feature, not a product. Building it *inside* the tool that owns the tasks — exactly our situation — is the surviving configuration. <https://news.ycombinator.com/item?id=30933379>

### Best-in-class mechanics worth copying

- **Range's flags**: mark any line as blocker / needs-attention / celebrate → batch-routed for discussion. Ours: blocker text feeds attention items. <https://www.range.co/product/flags>
- **Status Hero's plan-vs-done loop**: yesterday's stated plan is compared to today's report; the team sees a "goals met" rate. Ours: show yesterday's `planText` beside today's `completedText` in both the composer and the digest.
- **Linear Pulse**: digest-of-digests — ranked feed + AI daily summary in the inbox at ~6 AM local. Ours (later phase): AI summary of the day's reports via the existing OpenRouter plumbing. <https://linear.app/docs/pulse>

## Product Principles

1. **One model, one lifecycle.** The daily report *is* the check-in, extended — no parallel `DailyReport` table, no second alerting pipeline.
2. **Answering must cost under two minutes.** Prefill from the activity log, carry yesterday's plan forward, 3–5 bullets per section, all sections optional except that at least one must be non-empty.
3. **End-of-day write, next-morning read.** The report is a shutdown ritual (Tehran evening); the digest is the manager's morning artifact.
4. **Empty "unexpected work" is a healthy signal, not a missing answer.** Never nag about it; do trend it.
5. **Blockers and asks outrank everything.** They surface first in the digest and flow into the existing attention queue; an unanswered ask is a product failure.
6. **Peer-visible by default, managers report too.** This is team communication, not surveillance; participation is tracked as a soft weekly rate, never a streak.
7. **The system writes the boring parts.** Auto-drafted facts (completed tasks, task links) sit next to short human reflection — never force re-typing what the task graph already knows.

## Domain Model Changes

Extend `CheckInResponse` in place (migration `20260729…_daily_report_fields`):

```prisma
model CheckInResponse {
  id            String   @id @default(uuid()) @db.Uuid
  workspaceId   String   @db.Uuid
  userId        String   @db.Uuid
  authorId      String?  @db.Uuid
  completedText String?
  unplannedText String?  // NEW — unexpected work that came up today
  blockersText  String?
  planText      String?
  helpText      String?
  dateKey       String?  // NEW — "YYYY-MM-DD" computed server-side in Asia/Tehran
  submittedFor  DateTime @default(now())
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  // relations unchanged

  @@unique([workspaceId, userId, dateKey]) // one report per member per day (upsert)
  @@index([workspaceId, dateKey])
  @@index([workspaceId, userId, submittedFor])
  @@index([workspaceId, createdAt])
}

model ScheduledJobRun { // NEW — ships with Phase 4's migration, not Phase 1's (shown here for the full picture)
  id          String    @id @default(uuid()) @db.Uuid
  jobKey      String    // e.g. "daily_report_reminder"
  dateKey     String    // Tehran calendar date
  startedAt   DateTime  @default(now())
  completedAt DateTime?
  error       String?
  stats       Json?

  @@unique([jobKey, dateKey]) // cross-restart / multi-instance lock (P2002 = already ran)
}
```

Migration notes:

- Backfill `dateKey` for existing rows from `submittedFor` using `Asia/Tehran` (`Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' })` — same approach as the deleted `sms-reminders.ts`). Because no submit UI has ever existed, production rows are few; before adding the unique index, keep the newest row per `(workspaceId, userId, dateKey)` and delete older duplicates.
- `dateKey` stays nullable for one release; new writes always set it.
- Server computes `dateKey` — `submittedFor` from the client is clamped: members may only write today's report (admins writing on behalf of someone may backfill yesterday's).
- Phase 1's migration touches only `CheckInResponse`. `ScheduledJobRun` is created — and the orphaned `SmsDailyReminderRun` dropped — together in Phase 4's migration.
- Timezone is hardcoded `Asia/Tehran` for v1 in `apps/api/src/config.ts` (`TASKARA_WORKSPACE_TIMEZONE` env with default); per-user timezones are a non-goal.

## Endpoint Plan

```txt
POST  /check-ins                 (existing, changed) — becomes an UPSERT on (workspaceId, userId, dateKey);
                                  adds unplannedText; server computes dateKey; members restricted to today.
GET   /check-ins                 (existing, changed) — adds ?dateKey= and ?from=/&to= filters;
                                  visibility widens per the decision in Phase 1.
GET   /check-ins/missing         (existing, changed) — day-based: members without a report for a given dateKey
                                  (defaults to today), replacing the rolling-hours heuristic for digest use.
GET   /check-ins/draft           (new) — prefill payload for the composer:
                                  { completedCandidates, unplannedCandidates, blockedTasks,
                                    planCandidates, yesterday: CheckInResponse | null }
GET   /check-ins/digest?dateKey= (new, admin+) — one call for the manager view:
                                  { reports[], missing[], blockersFirst[], planVsDone[], trends }
```

Sync: add mutation `check_in.upsert` beside `check_in.create` in the dispatcher (`apps/api/src/routes/sync.ts:403–551`); emit `check_in` events with operation `updated` on upsert so open digests refresh live.

Draft-endpoint sources (all existing data):

- `completedCandidates`: today's `ActivityLog` rows for `actorId = me` — task `updated` with status→DONE in the after-snapshot, `commented`, `created`; render as `TSK-123 — title` lines.
- `unplannedCandidates`: tasks created today and assigned to me that were not in yesterday's plan text and carry today's `createdAt` — offered as suggestions only.
- `blockedTasks` and `planCandidates`: reuse the exact queries behind `POST /agent/daily-plan` (`apps/api/src/routes/agent.ts:61–99`).
- `yesterday`: my previous report, for carry-forward of `planText` and plan-vs-done display.

## Phase 1 — Day semantics + API completion

**Problem:** The storage layer has no notion of "a report for Tuesday", no unexpected-work field, no edit path, and visibility rules that contradict the peer-visible design.

**Implementation:**

1. Schema migration + backfill as specified above; regenerate the Prisma client.
2. `createCheckInResponse` → `upsertCheckInResponse`: compute `dateKey` server-side; clamp member-supplied `submittedFor` to today (Tehran); keep the admin submit-for-others rule; write ActivityLog `check_in`/`created|updated`; emit sync event with the right operation.
3. Add `unplannedText` to `createCheckInResponseSchema` (`packages/shared/src/index.ts:643–658`) and to the serializer.
4. **Visibility decision (recommended: workspace-visible).** Widen `listCheckIns` (drop the hard self-scope at `check-ins.ts:136` for MEMBER; keep GUEST/AGENT excluded) and `checkInEventVisible` (`sync.ts:860–862`) to match. If the team prefers reports private-to-admins for v1, skip this step only — everything else is unaffected.
5. Rework `listMissingCheckIns` to accept `dateKey` (keep the rolling-hours mode for the existing People-view call until Phase 3 migrates it).
6. New `GET /check-ins/draft` service + route as specced.
7. Register `check_in.upsert` in the sync dispatcher + args schema.

**Files:** `packages/db/prisma/schema.prisma`, new migration, `packages/shared/src/index.ts`, `apps/api/src/services/check-ins.ts`, `apps/api/src/routes/check-ins.ts`, `apps/api/src/routes/sync.ts`.

**Acceptance criteria:** Submitting twice on the same Tehran day yields one row (updated); a member cannot write yesterday's report; `unplannedText` round-trips; draft endpoint returns completed-task candidates referencing real task keys; non-member and GUEST access rejected.

**Tests:** extend `apps/api/src/services/check-ins.test.ts` (upsert, day-clamp, Tehran boundary at 20:30 UTC ≈ midnight Tehran, visibility matrix), `apps/api/src/routes/sync.test.ts` (`check_in.upsert` push/pull), `apps/api/src/routes/manager-access.test.ts` roles.

## Phase 2 — Member surface: the «امروز» page

**Problem:** There is no way to submit a report. The `/:orgId/today` route slot is already reserved (page meta `today` at `apps/web/src/App.tsx:91–94`, `'today'` in the `pageOwnsScroll` list at `apps/web/components/layout/main-layout.tsx:136`, copy keys `fa.nav.todayPlan`) but never registered.

**Implementation:**

1. Register `/:orgId/today` → new `components/taskara/daily-report-view.tsx`. Layout: **composer card on top, my-day context below** (my open/due tasks — the prefill sources made visible), following the `task-reports-view.tsx` card pattern.
2. Composer: three plain `Textarea`s (not Lexical — friction budget) titled «چه کارهایی انجام دادی؟» / «چه کار غیرمنتظره‌ای پیش آمد؟ (خالی یعنی روز خوب)» / «برنامه‌ی بعدی‌ات چیست؟», plus a collapsed «گیر کرده‌ام / کمک می‌خواهم» section for `blockersText`/`helpText`.
3. On mount, call `GET /check-ins/draft`: render completed/unplanned candidates as one-tap chips that append `TSK-123 — title` lines; show yesterday's plan beside the completed field («برنامه‌ی دیروزت این بود…») with a carry-forward button into today's plan.
4. Submit through `sendTaskSyncMutation('check_in.upsert', …)` so it is offline-durable; optimistic "submitted ✓ آخرین ویرایش …" state; editable all day (re-submits upsert).
5. Sidebar entry «گزارش روزانه» in the first group next to «کارهای من» (`app-sidebar.tsx:280–334`) with an evening dot-badge when today's report is empty; command-menu entry (`main-layout.tsx:211+`); copy in `fa.nav`/`fa.pages` (update the reserved `todayPlan*` copy to cover the report).
6. Jalali date header via `formatJalaliDate` (`apps/web/lib/jalali.ts:54`).

**Files:** `apps/web/src/App.tsx`, new `apps/web/components/taskara/daily-report-view.tsx`, `apps/web/components/layout/sidebar/app-sidebar.tsx`, `apps/web/components/layout/main-layout.tsx`, `apps/web/lib/fa-copy.ts`, `apps/web/lib/taskara-types.ts` (`unplannedText`, `dateKey`), `apps/web/lib/task-sync.ts` (mutation label), `apps/web/lib/workspace-data/pending.ts` (optimistic overlay).

**Acceptance criteria:** A member files a report in under two minutes with two taps + typed bullets; resubmission edits the same day's report; works offline (queued mutation); RTL/Persian rendering correct; chips insert real task keys.

**Tests:** `apps/web/lib/task-sync.test.ts` mutation shape; e2e scenario in `apps/web/e2e/` (submit → edit → reload shows same report); manual RTL/long-text QA.

## Phase 3 — Manager digest: «گزارش‌های روز»

**Problem:** Managers can't read reports at all today, and the pieces they do see (missing badges) don't answer "what should I focus on".

**Implementation:**

1. New route `/:orgId/daily-reports` → `components/taskara/daily-reports-digest-view.tsx`, Jalali day picker defaulting to today (before ~10:00, default to yesterday — the morning-read pattern).
2. Section order (fixed): **① Blockers & asks** (any report with `blockersText`/`helpText`, one card each, with "add to 1:1 agenda" and "create task" actions reusing cockpit patterns) → **② Unexpected work** (reports with `unplannedText` + day's interrupt share) → **③ Per-person cards** (done / unexpected / next, with yesterday-plan vs today-done shown side-by-side, task keys auto-linked to `/issue/:taskKey`) → **④ Missing** (from `GET /check-ins/missing?dateKey=`, with the existing copy-nudge action).
3. Data via new `GET /check-ins/digest`; live-refresh on `check_in` sync events (admins already receive all of them — `sync.ts:813`).
4. Cockpit integration: `missing_check_in` attention cards deep-link here; add a compact "today's reports: ۷/۹ submitted، ۲ blocker" summary row to the cockpit linking to the digest.
5. People view (`people-workload-view.tsx`) switches its missing-check-in call to day-based mode and links each person to their report history (digest view filtered by person).
6. Digest audience = OWNER∨ADMIN (align the sidebar manager-group gate at `app-sidebar.tsx:81` from `=== 'OWNER'` to the API's `isWorkspaceAdminRole` semantics — fixes the existing inconsistency).

**Files:** `apps/web/src/App.tsx`, new `apps/web/components/taskara/daily-reports-digest-view.tsx`, `apps/api/src/services/check-ins.ts` + `apps/api/src/routes/check-ins.ts` (digest endpoint), `apps/web/components/taskara/manager-cockpit-view.tsx`, `apps/web/components/taskara/people-workload-view.tsx`, `apps/web/components/layout/sidebar/app-sidebar.tsx`, `apps/web/lib/fa-copy.ts`.

**Acceptance criteria:** A manager opening the digest at 9 AM sees yesterday-evening reports with blockers on top, in one screen, and can act on each blocker without leaving the page; missing list matches reality across the Tehran midnight boundary; a member (if workspace-visible) can read teammates' reports but sees no missing/participation panel.

**Tests:** digest endpoint unit tests (ordering, missing computation, role gating); e2e `@manager-os` scenario: two members submit → manager digest shows both, blocker first.

## Phase 4 — Reminders & scheduler

**Problem:** Nothing prompts anyone; attention items materialize only when a manager happens to open Cockpit. The manager-OS plan deferred a scheduled worker "until Taskara promises background/push/inbox freshness" — a daily reminder is exactly that promise.

**Implementation:**

1. New `apps/api/src/services/scheduled-jobs.ts`, resurrecting the deleted skeleton's design (`git show 52062c4:apps/api/src/services/sms-reminders.ts`): 60-second `setInterval` started from `app.ts`, fire window per job, Tehran `dateKey`, `ScheduledJobRun` unique-constraint lock (P2002 ⇒ another instance already ran), stats + error recorded. Gated by env `TASKARA_SCHEDULED_JOBS_ENABLED`.
2. Job `daily_report_reminder` (~17:30 Tehran, workdays Sat–Wed by default, skipping a hardcoded v1 Iranian-holiday list in config): for each active MEMBER/ADMIN/OWNER without today's report, create in-app `Notification` type `daily_report_reminder` («یادت نره گزارش روزانه‌ات را بنویسی») linking to `/today`. `Notification.type` is a String — no migration.
3. Job `daily_report_digest_ready` (~09:00 Tehran next morning): notify OWNER/ADMIN with «گزارش‌های دیروز آماده است — ۷/۹ نفر، ۲ blocker» linking to the digest; also run `synchronizeAttention` so `missing_check_in` items exist before anyone opens Cockpit.
4. Optional SMS escalation (env-gated, off by default): members with a `phone` who ignored the in-app nudge by ~20:00 get one Kavenegar SMS via `sendMessageSimple`, audited in `SmsDelivery` (`kind: 'daily_report_reminder'`, masked receptor — same pattern as `announcements.ts:501`).
5. Replace the clipboard-only «درخواست چک‌این» button (People view) with a real action: `POST /check-ins/request` creating a `daily_report_requested` notification — closing the manager-OS plan's deferred item ("add first-class request-check-in delivery only after… a durable notification/action model").

**Files:** new `apps/api/src/services/scheduled-jobs.ts`, `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/services/notifications.ts` (type constants), `apps/api/src/routes/check-ins.ts` (+request), schema migration (`ScheduledJobRun`, drop `SmsDailyReminderRun`), `apps/web/components/taskara/people-workload-view.tsx`, `apps/web/components/taskara/inbox-view.tsx` (render new notification types).

**Acceptance criteria:** Restarting the API mid-window does not double-send (unique lock); people who already submitted are never nagged; weekend/holiday days send nothing; the reminder notification deep-links to the composer; SMS path stays dark unless explicitly enabled.

**Tests:** scheduler unit tests with injected clock (window edges, P2002 path, holiday skip); notification-creation assertions; digest-ready job creates attention items without a Cockpit visit.

## Phase 5 — Insights, AI summary, and channels (post-MVP)

Ordered candidates, each independently shippable:

1. **Trends in Team Health** (`team-health-view.tsx`): participation rate per person as a soft weekly measure («۴ از ۵ روز» — never streaks), unplanned-work share trend per team (the Phoenix-Project/DORA metric), blocker frequency. Backing aggregation in the digest endpoint.
2. **AI morning summary**: reuse the OpenRouter plumbing and Persian-prompt pattern of `apps/api/src/routes/ai-reports.ts` (`buildReportPrompt`) — one paragraph: main progress, blockers needing the manager today, unplanned-work sources, suggested focus. Rendered atop the digest with a "generated" label; never blocks the raw reports (Linear-Pulse pattern).
3. **Mattermost delivery**: extend `apps/mattermost-bot` with `daily-report-digest <channelId>` posting the compiled digest, and per-user DM prompts at reminder time (external cron, consistent with the existing bot model).
4. **Agent tools**: add `submit_daily_report` and `get_daily_report_draft` MCP tools to `plugins/taskara-agent/scripts/mcp-server.ts` so an agent can draft (never auto-submit — draft-then-confirm per the repo's AI posture) a member's report from their activity.
5. **Plan-vs-done task diffing**: parse task keys out of `planText`; next day mark each as done/slipped/carried automatically; repeated carries feed an attention candidate.

## Edge-Case Matrix

| Case | Behavior |
|---|---|
| Two submissions same Tehran day | Upsert — second edit updates the row; sync event op `updated` |
| Submission at 23:58 vs 00:03 Tehran | `dateKey` computed server-side in Asia/Tehran; belongs to the respective day |
| Member tries to file for yesterday | 400 — members write today only; admins may backfill for others (audited via `authorId` + ActivityLog) |
| Nothing to report / day off | No report; missing-list shows it; reminder skips weekends/holidays; no guilt UI |
| Empty unexpected-work section | Normal and healthy; digest shows «بدون کار غیرمنتظره» aggregate, no per-person nag |
| GUEST / AGENT roles | Never prompted, never listed as missing (existing exclusion), cannot read others' reports |
| Offline submit | `check_in.upsert` queued in IndexedDB; replays with idempotent `mutationId`; server upsert keeps it convergent |
| API restart during reminder window | `ScheduledJobRun` unique lock prevents re-send |
| All-hands vacation day | Digest for that `dateKey` shows empty state, not a wall of "missing" |
| 500+ historical reports | Digest queries by `[workspaceId, dateKey]` index; history views paginate (existing `listCheckIns` pagination) |

## Non-Goals (v1)

- No streaks, XP, or public participation shaming.
- No mood/sentiment question (can join later as an optional field).
- No per-user timezones — Asia/Tehran is the workspace clock.
- No separate `DailyReport` model, table, or alerting pipeline.
- No rich-text composer; plain text with task-key autolinking.
- No adaptive/smart reminder timing.
- No forced daily compliance — the missing list and soft weekly rate are the only pressure.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Reports become write-only ritual | Single morning digest, blockers pinned, cockpit summary row; manager-response norm stated in the digest empty state («به درخواست‌های کمک امروز پاسخ بده») |
| Surveillance perception kills honesty | Peer visibility default, managers/owners file reports too, unexpected-work framed as system-health not personal-failure |
| Noisy prefill destroys trust (Range's failure) | Candidates are opt-in chips, never auto-inserted; only high-precision signals (status→DONE, created, commented today) |
| Tehran-midnight bugs | All `dateKey` computation in one server-side helper with unit tests at the boundary; client never computes the day |
| Scheduler double-fires on multi-instance deploys | DB unique-constraint lock (proven pattern from the deleted service) |
| Reserved `today` copy conflicts with weight-based "today plan" concept | This plan takes over the slot and updates the copy; the weight-based personal plan (heartbeat's member-side twin) lives below the composer on the same page |

## Remaining Product Decisions

1. **Visibility default** — recommended: all non-GUEST members read all reports (Basecamp model). Alternative: admins-only for v1 (skip Phase 1 step 4).
2. **Workdays & holidays** — recommended v1: Sat–Wed constant + a small holiday list in config; a per-workspace settings model is deliberately out of scope (no settings JSON exists in the schema yet).
3. **SMS escalation on/off at launch** — plumbing lands env-gated; decide per-workspace appetite (Kavenegar template registration required if a lookup template is preferred over `sendMessageSimple`).
4. **Soft participation floor** — the digest shows a weekly rate; decide whether any threshold (e.g. <2/5 days) should generate an attention item or stay informational.

## Recommended Pull Request Sequence

1. **PR 1 — Phase 1**: migration + upsert/day semantics + draft endpoint + sync mutation (`bun run test:api` green; no UI change).
2. **PR 2 — Phase 2**: `/today` composer + sidebar/command entries.
3. **PR 3 — Phase 3**: digest view + digest endpoint + cockpit/people integration.
4. **PR 4 — Phase 4**: scheduler + notifications (+env-gated SMS) + real request-check-in.
5. **PR 5+ — Phase 5 items** as independent follow-ups.

Verification per PR (repo standard):

```bash
bun run test:api
bun run --filter @taskara/web typecheck
bun run --filter @taskara/web lint
bun run --filter @taskara/web build
git diff --check
```

Plus Playwright `@manager-os` e2e for PRs 2–4 and manual RTL/Jalali QA on the composer and digest.

## Research Sources

Formats & practices: <https://martinfowler.com/articles/itsNotJustStandingUp.html> · <https://basecamp.com/guides/how-we-communicate> · <https://en.wikipedia.org/wiki/Progress,_plans,_problems> · <https://handbook.gitlab.com/handbook/company/culture/all-remote/asynchronous/> · <https://blog.idonethis.com/google-snippets-internal-tool/> · <https://mtlynch.io/status-updates-to-nobody/> · <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2414478> (end-of-day reflection improves performance) · <https://www.sciencedirect.com/science/article/abs/pii/S0164121216000066> (Stray et al., standup attitudes)

Unplanned work as a health metric: <https://itrevolution.com/articles/10-minute-summary-of-the-phoenix-project/> · <https://dora.dev/guides/dora-metrics/> · <https://linearb.io/planning-accuracy/> · <https://kanbantool.com/blog/handling-unplanned-work-with-kanban>

Products: <https://linear.app/docs/pulse> · <https://linear.app/docs/initiative-and-project-updates> · <https://runsteady.com/> (Status Hero/Steady) · <https://www.range.co/product/flags> · <https://help.geekbot.com/en/articles/14007711-geekbot-features> · <https://www.dailybot.com/product/check-ins/> · <https://success.15five.com/hc/en-us/articles/360002698971-Check-ins-Feature-Overview> · <https://5.basecamp-help.com/article/1051-automatic-check-ins> · <https://clickup.com/blog/ai-powered-status-updates-standups/> · <https://zapier.com/blog/asynchronous-standups-geekbot/> · <https://news.ycombinator.com/item?id=30933379> (Friday.app post-mortem)
