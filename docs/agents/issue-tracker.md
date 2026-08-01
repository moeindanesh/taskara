# Issue tracker: Taskara

Issues and PRDs for this repo live in **Taskara** — this team's own task manager, which is also its
issue tracker. Use the `taskara` CLI for all operations.

**One translation, made once.** The skills say *issue* and *ticket*; Taskara says **Task**, with a key
like `CORE-123`. The skills say *map*; Taskara says **Effort** — a Task with `kind = EFFORT`, holding a
destination, notes and decisions, and owning its tickets as ordinary child Tasks. `CONTEXT.md` lists
"issue" and "ticket" under _Avoid_, so use Taskara's words in anything a human reads. Everything below
says Task and Effort.

## Setup

The CLI is `plugins/taskara-agent/src/cli.ts`. Run it as `bun plugins/taskara-agent/src/cli.ts …`, or
as `taskara …` once it is on `$PATH`. Every command in this file is written as `taskara`.

| Variable | |
|---|---|
| `TASKARA_API_URL` | Required. The API base URL. |
| `TASKARA_WORKSPACE_SLUG` | Required. One workspace holds the whole team; every read and write is scoped by it. |
| `TASKARA_AGENT_TOKEN` | The agent credential, presented as a bearer token. **This is how an agent authenticates.** Referenced by name only — never paste a token into a file, an issue or a commit. |
| `TASKARA_USER_EMAIL` | The header path, for a **human** driving the MCP tools in conversation. Ignored when a token is set, and refused for an agent User. |
| `TASKARA_AGENT_RUNTIME` | Optional: `CLAUDE_CODE`, `CODEX`, `OPENCLAW` or `HERMES`. One binary serves all four, so each runtime's config declares which it is. Anything else is a configuration error rather than a silent omission. |

Missing or unusable configuration exits **2** before anything is sent.

## Identifying a task

- **A key**, `CORE-123` — the project's key prefix and a per-project sequence number. This is the
  identity to write in prose, in commit messages, and in another Task's body.
- **A UUID**, which every command accepts wherever it accepts a key. Some filters take only a UUID —
  `--project`, `--milestone`, and `--assignee` (which also takes `none` or `me`). `--parent` takes
  either, and resolves a key for you.
- **A URL**, `<web-origin>/<workspace-slug>/issue/CORE-123`. The `/issue/` segment is a naming
  leftover in the web app; the concept is still Task.

**A URL is not a task reference.** `taskara task view <url>` exits **4**. Take the key off the end
first — `KEY="${URL##*/}"` — then pass the key.

## Conventions

- **Create a task**: `taskara task create --project <projectId> --title "..." --body "..."`. Use
  `--body-file -` for anything multi-line; see [Bodies](#bodies-longer-than-a-line).
- **Create a task as a child of another**:
  `taskara task create --project <projectId> --title "..." --parent CORE-1`
- **Read a task**: `taskara task view CORE-123 --comments`
- **List tasks**: `taskara task list --status unfinished --sort createdAt:asc`
- **Search by label and state**:
  `taskara task list --label wayfinder:task --status unfinished --sort createdAt:asc`
- **Comment on a task**: `taskara task comment CORE-123 --body "..."`
- **Apply / remove labels**:
  `taskara task edit CORE-123 --add-label "wayfinder:task" --remove-label "needs-triage"`
- **Set a blocker** (`CORE-9` blocks `CORE-123`): `taskara task edit CORE-123 --add-blocker CORE-9`
- **Remove a blocker**: `taskara task edit CORE-123 --remove-blocker CORE-9`
- **Claim**: `taskara task claim CORE-123` — atomic; see [Claiming](#claiming).
- **Assign to someone**: `taskara task edit CORE-123 --add-assignee <userId>`
- **Re-parent**: `taskara task edit CORE-123 --parent CORE-1`, or `--parent none` to detach.
- **Close**: `taskara task close CORE-123 --reason completed` (or `--reason canceled`).
  `completed` → `DONE`, `canceled` → `CANCELED`. Taskara has no "not planned".

Run `taskara` with no arguments for the whole grammar.

**stdout is always JSON** — the result on success, `{ "error": { code, message, … } }` on failure.
**stderr is always the human line.** So `$(taskara task view CORE-123)` always parses, and
`taskara task list … | jq -r '.tasks[0].key'` is the way to pick the next ticket.

### Exit codes

Branch on the exit code, never on stderr. All are below 9, so none collides with the shell's own
126/127/128+N.

| Code | Meaning | What to do next |
|---|---|---|
| 0 | Succeeded | Continue |
| 1 | Usage — bad noun, verb or flag. **Nothing was sent.** | Fix the command; retrying is pointless |
| 2 | Config — required environment missing or unusable. **Nothing was sent.** | A human fixes the config |
| 3 | Auth — credential absent, wrong, revoked or not permitted | A human fixes the credential |
| 4 | Not found — no such task, project or workspace | Check the key |
| 5 | Conflict — **includes losing a `task claim`** | Someone else has it; take another ticket |
| 6 | Rejected — the server understood the request and refused it | Fix the request |
| 7 | Server error — whether the work happened is **unknown** | Retry, then escalate |
| 8 | Unreachable — no HTTP response at all | Retry; check the API is up |

A mistyped flag exits 1 rather than being ignored, so a command that reports success did what it said.

### Bodies longer than a line

`--body-file -` reads the body from stdin, on `task create`, `task edit` and `task comment`. Use it
for anything longer than a phrase: an Effort body is tens of kilobytes of markdown, and inline shell
quoting of that is exactly where a paste breaks.

```bash
taskara task comment CORE-123 --body-file - <<'EOF'
## Resolution

…
EOF
```

The ceiling is the server's, and the shell carries none of its own: **15,000 characters for a work
Task, 60,000 for an Effort.** A refusal names the field and the limit and exits 6.

The 60,000 ceiling is reachable only through `task edit`, not through `task create`, because every
row `task create` mints today is `WORK` — see the note under [Map](#wayfinding-operations).

### Labels

Taskara **creates a label on first use** — the write upserts on `(workspace, name)` — so there is no
pre-seeding step and no "label does not exist" failure. See `triage-labels.md`.

`--add-label` and `--remove-label` are applied **server-side** against whatever the row holds at that
moment, so two agents relabelling one Task do not overwrite each other. Both flags repeat and both
accept comma-separated lists. A Task carries at most 12 labels and a name is at most 40 characters;
either is a 6.

Because creation is implicit, a typo mints a new label rather than failing. There is no
"list the labels" command; the check is that `taskara task list --label <name>` returns `total: 0`.

### Claiming

```bash
taskara task claim CORE-123
```

Conditional server-side: it takes the Task only if nobody holds it. If somebody does, it **exits 5**
and names the holder on stderr *and* in the JSON on stdout. This is not a read-then-write — there is
no window in which two agents both believe they claimed it.

Treat exit 5 as "take a different ticket", never as "the claim looked stale". It is deliberately
**not idempotent**: re-claiming a Task you already hold also exits 5, because "you hold this" and
"you just took this" are different answers.

Claiming an Effort exits 6 — an Effort is not a unit of work and holds no assignee.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Not a default left unexamined: Taskara has no pull-request surface at all. It is a task manager, not a
code host, so there is nothing for this flag to turn on and no `taskara pr` equivalent to reach for.
Code review for this repo happens on GitHub; GitHub PRs are not in Taskara's triage queue and `/triage`
should not go looking for them.

## When a skill says "publish to the issue tracker"

Create a Taskara Task in the project the work concerns:

```bash
taskara task create --project <projectId> --title "..." --body-file -
```

`--project` is required and takes a UUID, not a key prefix. Every listed Task carries its project, so
resolve one once per session:

```bash
taskara task list --limit 1 | jq -r '.tasks[0].project.id'
```

`task` is the CLI's only noun today — there is no `taskara project list` — so that trick needs the
workspace to hold at least one Task already. In an empty workspace, get the project id from the web
UI or from whoever set the workspace up. The MCP surface has `project_list` if you are in
conversation rather than in a script.

## When a skill says "fetch the relevant ticket"

```bash
taskara task view CORE-123 --comments
```

## Wayfinding operations

Used by `/wayfinder`. The **map** is an **Effort** — one Task with `kind = EFFORT` — and its tickets
are its **child** Tasks.

- **Map**:
  ```bash
  taskara task create --project <projectId> --title "<effort name>" --kind EFFORT --body-file -
  ```
  The body holds Destination / Notes / Decisions-so-far / Not-yet-specified / Out-of-scope. An Effort
  lives in the project it concerns, carries no assignee, due date, weight, milestone or parent, and
  only ever sits in `IN_PROGRESS`, `DONE` or `CANCELED`. It is excluded from every list, count and
  metric about work — that is the point of the kind — so reach it deliberately by name:
  `taskara task list --kind EFFORT --query "<effort name>"`.

  **Not yet true, and check rather than assume: `--kind EFFORT` is accepted on create and silently
  produces a `WORK` row.** `POST /tasks` has no `kind` field, so the server strips it and the command
  exits 0 on a Task that is not an Effort. That is
  [The API cannot create an Effort](https://github.com/moeindanesh/taskara/issues/46). The command
  above is the settled grammar and starts minting Efforts when that lands, with no change to this
  file — until then, read `kind` out of the JSON you get back. Two consequences follow while it is
  open: a map body over 15,000 characters is refused on create (the work ceiling binds), and the row
  is visible in ordinary task lists and counts.

  **No `wayfinder:map` label.** `kind = EFFORT` is the marker, enforced by database constraints
  rather than by convention, and a second marker that nothing checks is a second marker that can go
  wrong. Tickets still carry `wayfinder:<type>`.
- **Child ticket**: `taskara task create --project <projectId> --title "..." --parent <effortKey> --label wayfinder:task --body-file -`.
  `--parent` takes the Effort's key and resolves it. The label is `wayfinder:<type>` — one of
  `research`, `prototype`, `grilling`, `task`. A ticket already created can be wired afterwards with
  `taskara task edit CORE-123 --parent <effortKey>`.
- **Blocking**: Taskara's **native dependency edge** — the canonical, UI-visible representation, so
  the human sees what is takeable without opening the Effort.
  `taskara task edit CORE-123 --add-blocker CORE-9` means *CORE-9 blocks CORE-123*; remove with
  `--remove-blocker`. A blocker is **open** while it is unfinished, so a ticket is unblocked when
  every blocker is `DONE` or `CANCELED` — blockedness is a question about the blocker's status, never
  about how many edges exist. (Unrelated to the `BLOCKED` status, which a person sets by hand.)
- **Frontier query**: one request, no client-side filtering:
  ```bash
  taskara task list --parent <effortKey> --status unfinished --assignee none \
                    --blockers none --sort createdAt:asc
  ```
  `unfinished` means neither `DONE` nor `CANCELED`; `none` is the absence sentinel throughout. First
  in the list wins. The same predicate is available to a human as filters on Taskara's own task list.
- **Claim**: `taskara task claim <key>` — the session's first write, before any work. Exit 5 means
  somebody else holds it; move to the next frontier ticket.
- **Resolve**: `taskara task comment <key> --body-file -` with the answer, then
  `taskara task close <key> --reason completed`, then append a context pointer to the Effort's
  Decisions-so-far. The Effort body is rewritten whole, from stdin:
  ```bash
  taskara task edit <effortKey> --body-file - < /tmp/effort-body.md
  ```
  There is no append operation and no optimistic-concurrency flag on this path, so read the body,
  edit it, and write it back in one session rather than holding it across a long pause.

Ruling a ticket out of scope is `taskara task close <key> --reason canceled` plus the line on the
Effort's Out of scope section.

## Three unrelated `AGENT` tokens

They coexist and mean different things. Do not reason from one to another.

- **`WorkspaceRole.AGENT`** — a permission profile on a workspace membership. It says what an identity
  may do. Nothing may infer agent-ness from it: role is per-workspace, carries no history, and a role
  change would silently reinterpret past work.
- **`ActorType.AGENT`** — derived **server-side** from the authenticated `User.kind`, never from a
  client header. This is the one that means "an agent did this".
- **`TaskSource.AGENT`** — set when a **human** uses the in-app assistant dock. It describes the
  surface a row came through, not who wrote it.
