# Taskara

Agentic work manager for Team delivery and Support operations, optimized for Mattermost and Codex
workflows and backed by PostgreSQL/Prisma. The UI is RTL-first, Jalali date-time aware, and keeps a
Linear-like Task experience alongside an assignment-private Support Case experience.

![Taskara dashboard](assets/taskara.png)

## Highlights

- Linear-like workflow states: backlog, todo, in progress, review, blocked, done, canceled
- Jalali timer/date-time support for due scheduling (example: `1405/02/04 14:30`)
- RTL-first Persian UI with workspace/project/task hierarchy
- Team and Support workspace modes with private Department-scoped Case queues
- API/call intake, SLA clocks, recovery queues, and explicit Support Case–Team Task handoff
- Mattermost slash-command integration for task creation and updates
- Native Codex plugin for MCP-based task operations and agent workflows

## Stack

- Runtime/package manager: Bun
- API: Fastify + TypeScript
- Database: PostgreSQL + Prisma
- Web: Vite + React (Circle-based UI, adapted for RTL/Jalali)
- Integrations: Mattermost slash commands/API, repo-local Codex plugin
- Agent workflows: auditable proposals and daily planning endpoints

## Quick Start

```bash
cp .env.example .env
bun install
docker compose up -d postgres redis
bun run db:generate
bun run db:migrate
bun run dev
```

API: the `TASKARA_API_URL` value from `.env.example`

Web: the Vite dev server URL printed by `bun run dev:web`

The web UI runs on Vite and talks directly to the API using:

```txt
VITE_TASKARA_API_URL=<api-url>
```

Create the first account and workspace through `/signup` and `/onboarding`. Workspace routing in the browser is slug-based, e.g. `/<workspace-slug>/projects`.

Choose `TEAM` for the existing project/Task workflow or `SUPPORT` for Cases, Departments, Triage,
Department Inbox, My Cases, and Needs Attention. A workspace mode is immutable in v1; switching the
active workspace switches the product shell, while converting populated data is intentionally not
an in-place toggle.

## Docker / Coolify Deployment

The repo includes production Dockerfiles for the API and web UI:

```txt
Dockerfile.api
Dockerfile.web
docker-compose.coolify.yml
```

Recommended Coolify setup for one Compose application:

1. Create a Docker Compose resource from the repository root.
2. Use `docker-compose.coolify.yml` as the compose file.
3. Let Coolify generate the service URLs and Postgres password from:

```txt
SERVICE_URL_WEB
SERVICE_URL_API
SERVICE_PASSWORD_POSTGRES
```

The API and web UI both listen on internal container port `80` in the Coolify compose deployment, so Coolify can generate clean public URLs without `:4000` or `:80`. The compose file wires `WEB_ORIGIN` to the generated web URL and writes `TASKARA_API_URL` into the web container at startup, so the same web image can be reused across environments.

You can also deploy them as two separate Dockerfile resources:

```txt
API Dockerfile: Dockerfile.api, port 80
Web Dockerfile: Dockerfile.web, port 80
```

For the API resource, set:

```txt
DATABASE_URL=postgresql://...
WEB_ORIGIN=https://your-web-domain.example
API_HOST=0.0.0.0
API_PORT=80
TASKARA_RUN_MIGRATIONS=true
TASKARA_SUPPORT_DATA_SECRET=<at-least-32-bytes-of-deployment-secret-material>
TASKARA_SUPPORT_INTAKE_WORKER_ENABLED=true
TASKARA_SUPPORT_RECOVERY_WORKER_ENABLED=true
```

`TASKARA_SUPPORT_DATA_SECRET` is required before configuring Support intake connectors or storing
sensitive Support interaction content. Keep the value in the deployment secret store; only its
environment-variable name belongs in repository configuration. The intake worker leases and
processes accepted connector receipts. The recovery worker evaluates SLA clocks, expired snoozes,
and reason-coded Needs Attention projections. Both workers default to enabled and release their
leases during graceful API shutdown; disable a worker only when another API/worker instance owns
that responsibility.

For the web resource, set:

```txt
TASKARA_API_URL=https://your-api-domain.example
```

`Dockerfile.api` generates the Prisma client during build and runs `prisma migrate deploy` on startup by default. Set `TASKARA_RUN_MIGRATIONS=false` if migrations are handled elsewhere.

## Core API

```txt
GET  /health
GET  /me
GET  /users
POST /users
PATCH /users/:id
PATCH /users/:id/role
DELETE /users/:id/membership
GET  /projects
POST /projects
GET  /tasks
POST /tasks
GET  /tasks/:idOrKey
PATCH /tasks/:idOrKey
POST /tasks/:idOrKey/comments
POST /integrations/mattermost/command
POST /agent/thread-to-tasks
POST /agent/daily-plan
POST /agent/actions/:id/apply
```

## Support Workspaces

A Support Workspace uses **Support Cases** rather than Tasks. Its RTL web shell provides Triage,
Department Inbox, My Cases, Needs Attention, Departments, operational reports, intake health,
routing controls, saved queues, a dedicated enablement-and-quality workspace, Case-level
assistance/KCS/CSAT, and Case-to-Team handoff. A Case remains the customer-service source of truth
even when it creates or links delivery work in a Team Workspace.

Visibility is assignment-scoped on the server. An ordinary Department member sees only Cases
assigned to their own active membership; Department managers see their Department, users whose
only Support grant is `TRIAGER` see only unrouted Cases, and supervisors/Workspace administrators
see the wider Support operation. Current Department memberships and explicit Support grants compose.
Department membership alone does not reveal a peer's Case, workload, contact, count, notification,
search result, sync event, report row, cluster membership, or linked record.

The Support API is grouped by responsibility:

```txt
/support/cases, /support/calls                    queues, lifecycle, interactions and call entry
/support/sync                                      audience-scoped bootstrap, pull, push and stream
/support/departments, /support/permission-grants    Departments, membership and human grants
/support/credential-grants                          explicit automation credential scopes
/support/intake-connectors                         connector configuration and secret rotation
/support/intake/:lookupId                           signed asynchronous intake and receipt status
/support/intake-admin                               receipt health, dead letters and retry
/support/config                                     business calendars and versioned SLA policies
/support/reports/overview                           access-scoped operational overview
/support/routing                                    rules, simulation, capacity and priority decisions
/support/saved-views                                private/shared Support queue definitions
/support/cases/:idOrKey/presence                    short-lived collision warnings
/support/enablement                                 versioned macros, templates and approved automation
/support/problem-clusters                           privacy-filtered recurring-problem clusters
/support/cases/:idOrKey/knowledge/*                 KCS search, reuse and gap feedback
/support/cases/:idOrKey/assistance                  persisted suggestions with human accept/reject
/support/cases/:idOrKey/csat, /support/csat/respond opaque single-use satisfaction invitations
/support/quality                                    rubrics and completed quality reviews
/support/workspace-connections, /workspace-connections  Support-to-Team approval and Task handoff
```

Connector receipts are idempotent, payload-bound, leased, retried and dead-lettered. SLA and
recovery evaluation use frozen policy/calendar versions and business time; queue urgency comes from
derived reason codes rather than a mutable “stale” status. Routing decisions and automation are
previewable, version-checked, explainable and audited. Suggestions never apply themselves.
Case lists and saved queues currently paginate by newest receipt, while Needs Attention supplies
the reason-coded recovery view. The shipped report is a scoped overview with sample counts and
P50/P90 durations, not a free-form analytics or export surface. Collision presence is best-effort
and process-local; optimistic Case versions remain the authoritative conflict guard.

Deliberate boundaries remain: there is no customer portal, vendor-specific channel adapter or
outbound email/messaging/telephony delivery; no Support recording/attachment storage on the current
permanent-capability media path; no offline Case cache or mutation queue; no generic custom-field,
report-builder or bulk-export surface; and no in-place Workspace mode conversion. The generic
signed intake contract can label accepted events by configured channel, but it does not deliver a
reply. Cross-Workspace handoff requires one human who is independently authorized on both sides; a
connection never grants source-record access.

## Web UI

The frontend now uses the Circle interface shell as the base UI and is wired to the implemented Taskara APIs:

- `/{workspace}/team/all/all`: task board
- `/{workspace}/projects`: projects and subprojects
- `/{workspace}/members`: workspace members
- `/{workspace}/teams`: teams
- `/{workspace}/settings`: admin user management
- `/{workspace}/inbox`: notifications and activity

Support-mode routes use the same workspace prefix:

- `/{workspace}/support/triage`: unrouted actionable Cases
- `/{workspace}/support/my-cases`: the current member's private queue
- `/{workspace}/support/department-inbox`: manager dispatch queue
- `/{workspace}/support/attention`: reason-coded recovery queue
- `/{workspace}/support/saved-queues`: access-rechecked saved filters
- `/{workspace}/support/cases/{caseKey}`: Case detail, presence, assistance, KCS, CSAT and handoff
- `/{workspace}/support/departments`: Department setup and workspace connections
- `/{workspace}/support/routing`: routing policies and member capacity
- `/{workspace}/support/maturity`: macros/automation, problem clusters, knowledge gaps and quality
- `/{workspace}/support/reports`: scoped operational overview
- `/{workspace}/support/operations`: calendars and SLA policy versions
- `/{workspace}/support/intake-admin`: connector health and dead-letter retry

Common Inbox, Knowledge, member and settings routes remain capability-gated in either mode. Support
users without an operational grant or Department membership land on the setup/no-access screen
instead of an empty queue.

UI details:

- RTL layout by default
- Sidebar anchored on the right
- Jalali date display everywhere
- Jalali due-date input for task creation, format: `1405/02/04 14:30`

Authenticated API requests use a session bearer token plus an explicit workspace slug:

```txt
authorization: Bearer <session-token>
x-workspace-slug: <workspace-slug>
```

Create users and workspaces through signup, onboarding, invitations, or admin screens. User-management endpoints require `OWNER` or `ADMIN`.

Create a user:

```bash
curl -X POST "$TASKARA_API_URL/users" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <session-token>" \
  -H "x-workspace-slug: <workspace-slug>" \
  -d '{"email":"sara@example.com","name":"Sara","role":"MEMBER","mattermostUsername":"sara"}'
```

Change a workspace role:

```bash
curl -X PATCH "$TASKARA_API_URL/users/<user-id>/role" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <session-token>" \
  -H "x-workspace-slug: <workspace-slug>" \
  -d '{"role":"ADMIN"}'
```

## Mattermost Slash Command

Create a slash command in Mattermost that posts to:

```txt
<TASKARA_API_URL>/integrations/mattermost/command
```

Set the slash token in `.env`:

```txt
MATTERMOST_SLASH_TOKEN="your-slash-token"
MATTERMOST_SYNTHETIC_EMAIL_DOMAIN="mattermost.example.invalid"
```

Taskara resolves the workspace from `MATTERMOST_WORKSPACE_SLUG` when set, otherwise from Mattermost `team_domain`/`team_id`. The workspace must already exist through onboarding.

Commands:

```txt
/task create Fix checkout bug
/task list mine
/task status CORE-123 in-review
/task assign CORE-123 @sara
/task due CORE-123 فردا
/task bind CORE
```

## Codex Plugin

Repo-local plugin scaffold:

```txt
plugins/taskara-agent
```

Use the CLI. It is `taskara <noun> <verb>`, and it is the surface an agent drives — the MCP server is
the same operations wearing a different shell, for conversation rather than for a script.

```bash
cd plugins/taskara-agent
export TASKARA_API_URL="<api-url>" TASKARA_WORKSPACE_SLUG="<workspace-slug>" TASKARA_AGENT_TOKEN="<agent-credential>"
bun src/cli.ts task list --assignee me
bun src/cli.ts task list --query "blocked"
bun src/cli.ts task create --project "<uuid>" --title "Implement audit trail"
```

Run it with no arguments for the full grammar. It exits `0` on success and uses distinct codes for the
ways a command can fail — `1` usage, `2` config, `3` auth, `4` not found, `5` conflict, `6` rejected,
`7` server error, `8` unreachable — so a script can branch on the reason rather than on stderr.

An agent authenticates with an agent credential (`TASKARA_AGENT_TOKEN`), not with `TASKARA_USER_EMAIL`:
a User whose kind is `AGENT` is refused on the email path.

## Data Model Highlights

- Workspaces, teams, projects, subprojects, and project-scoped feature/phase milestones
- Linear-style task workflow: backlog, todo, in progress, review, blocked, done, canceled
- Human-readable task keys, e.g. `CORE-123`
- Comments, labels, dependencies, activity logs, notifications
- Support Workspaces, Departments, private Support Cases, interactions, audit events and SLA clocks
- durable connector receipts, routing policies, saved Support views, quality/KCS records and
  minimized cross-Workspace Case–Task links
- Mattermost channel-to-project bindings
- Agent runs and proposed actions with explicit apply step

## Implementation Notes

- All timestamps are stored in UTC; milestone start and target values are date-only `YYYY-MM-DD` fields.
- The UI formats and accepts dates in Jalali; the API still stores UTC timestamps.
- Agent endpoints persist inputs, outputs, and proposed actions.
- Bulk/destructive agent work should stay proposal-based until explicitly applied.

## Native Codex Tools

The repo includes a native MCP-backed Codex plugin at:

```txt
plugins/taskara-agent
```

The repo-local marketplace entry is:

```txt
.agents/plugins/marketplace.json
```

The plugin MCP config is:

```txt
plugins/taskara-agent/.mcp.json
```

Configure the plugin with an existing onboarded workspace and member:

```txt
TASKARA_API_URL=<api-url>
TASKARA_USER_EMAIL=<user-email>
TASKARA_WORKSPACE_SLUG=<workspace-slug>
```

After restarting Codex, install/enable `Taskara Agent` from the local marketplace. The plugin exposes native tools such as `list_milestones`, `create_milestone`, `update_milestone`, `summarize_milestone`, `assign_task_to_milestone`, `create_task`, `search_tasks`, `update_task`, `comment_on_task`, `generate_daily_plan`, `triage_backlog`, `generate_weekly_report`, `create_user`, and `update_user_role`.

Smoke-test MCP discovery without Codex:

```bash
bun -e 'import { Client } from "@modelcontextprotocol/sdk/client/index.js"; import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"; const t = new StdioClientTransport({ command: "bun", args: ["src/mcp-server.ts"], cwd: "plugins/taskara-agent", env: { TASKARA_API_URL: process.env.TASKARA_API_URL, TASKARA_USER_EMAIL: process.env.TASKARA_USER_EMAIL, TASKARA_WORKSPACE_SLUG: process.env.TASKARA_WORKSPACE_SLUG } }); const c = new Client({ name: "smoke", version: "0.1.0" }, { capabilities: {} }); await c.connect(t); console.log((await c.listTools()).tools.map((tool) => tool.name)); await c.close();'
```
