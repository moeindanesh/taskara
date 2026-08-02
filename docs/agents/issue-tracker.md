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

- **A key**, `CORE-123` — the project's key prefix and a sequence number. This is the identity to
  write in prose, in commit messages, and in another Task's body.

  **A key is permanent.** It is issued once, when the Task is created, and no later change can
  revoke it — not a move to another project, not a project merge. So a key written into a commit
  message today still resolves next year, and that is the whole reason to prefer it over a UUID.

  The consequence to expect rather than report as a bug: the prefix records where a Task was
  **created**, not where it lives now. `CORE-42` may sit in project `PLAT` after a move, and its
  sequence within `PLAT` will not be 42 — the sequence is re-assigned on a move because a project
  cannot hold two of the same, while the key is not. Read the prefix as part of a name, never as a
  claim about the current project. To learn a Task's project, read it: `taskara task view CORE-42`.
- **A UUID**, which every command accepts wherever it accepts a key. `--parent` takes either, and
  resolves a key for you. One flag still takes **only** a UUID: `--milestone`, which exists on
  `task create` and `task edit` and **not** on `task list` — asking for it there is exit 1,
  `Unknown flag`, and anything but a UUID on it is exit 6, `Validation failed`, with no clue which
  field it meant. For `--assignee`, see [Identifying a person](#identifying-a-person).
- **A URL**, `<web-origin>/<workspace-slug>/issue/CORE-123`. The `/issue/` segment is a naming
  leftover in the web app; the concept is still Task.

**A URL is not a task reference.** `taskara task view <url>` exits **4**. Take the key off the end
first — `KEY="${URL##*/}"` — then pass the key.

## Identifying a project

`--project` takes a **key prefix** — `CORE`, the front half of every key in that project — or the
project's UUID. The two can never be confused: a prefix is letters and digits with no hyphen in it,
and every UUID has four. Case does not matter, so `--project core` is the same request.

So a Task key answers the question on its own: anything in `CORE-123` belongs in `--project CORE`.
Pass the whole key by mistake and it is exit **4** — and because the message names the prefixes that
do exist, `No project with key prefix "CORE-3". Known prefixes: BILL, CORE.` tells you what to type
without a second command.

## Identifying a person

Tasks are assignable to people as well as to agents, and work that a session surfaces routinely lands
on a colleague. Two handles reach one, and a third deliberately does not:

- **A UUID.** Accepted everywhere, and printed beside every assignee.
- **An email address.** Accepted by `--assignee` and `--add-assignee`. It is the only handle that is
  both unique in Taskara and the kind of thing a human writes in prose.
- **A name — never.** `User.name` carries no unique constraint, so two colleagues may share one.
  Passing one is exit **1**, before anything is sent, and the message says to look the person up.

`taskara user list` is the roster, and the only way to reach somebody who **holds no Task**: their
UUID appears in no key, no URL and no prose, and the only other place the shell prints one is beside
an assignee on work they already have.

```bash
taskara user list
taskara user list --query "Robin"
taskara user list --kind HUMAN
```

Each row is `id`, `name`, `email`, `kind`, `operatorId` and `role` — enough to address somebody and
no more. The answer is always a list with a `total`, however specific the query, because a name can
match more than one person. Pick the row by **email**, never by position:

```bash
taskara user list --query "Robin" | jq -r '.users[] | "\(.email)\t\(.kind)\t\(.id)"'
```

Then hand the work over, by email or by the id you just read:

```bash
taskara task edit CORE-123 --add-assignee robin.example@example.test
```

An email nobody in this workspace holds is exit **4**. The match is exact, so an address that is a
substring of a colleague's does not resolve to theirs.

**Agents are in the roster, and marked.** They are teammates here, not hidden machinery, so they are
listed and they are assignable — but `kind` is `"AGENT"` and `operatorId` names the human they act
for, and a human reading your summary should be told when work went to a machine. `--kind HUMAN`
narrows the roster to people; `--kind AGENT` to agents.

`user list` is the whole noun. Creating a person and changing their role are workspace-admin
operations, and an agent credential can never perform one whatever role its agent holds — so those
have no command here rather than a command that always exits 3.

**To take a task yourself, use `taskara task claim`**, not an assignee flag. `--add-assignee me` is
exit 1: a credential never learns its own user id, and claiming is atomic where assigning is not.
`taskara task list --assignee me` does work — the server answers "mine" without needing an id.

### An @-mention in a body reaches nobody

Writing `@Robin please look at this` into a task body, an effort body or a comment notifies **no
one**. A mention in Taskara is a rich-text node, and every body you send from here is markdown, which
carries no nodes. There is no text spelling that works — not a name, not an email, not a UUID.

**Who *can* write one differs by body, and it matters when you decide what to do instead.** In a
**description** the web editor writes the node, when a human picks a colleague out of an
autocomplete — so asking a person to add the mention is a real thing to ask. In a **comment** nothing
writes one. The web's comment box is a plain textarea and the mention-capable editor is mounted on
descriptions only, so a comment mention is a rule with no writer, in any client. Do not route around
it by asking a human; they cannot either.

So a person is reached by a **flag**, never in prose:

```bash
taskara task edit CORE-123 --add-assignee robin.example@example.test
```

The body still lands exactly as written — a sentence naming somebody is worth keeping for whoever
reads the task — and the CLI prints one line to stderr naming the handles it found and did not
reach. **Exit stays 0.** That line is not a failure; it is the write telling you which part of your
intent it could not carry.

```
$ taskara task create --project CORE --title "Rework the parser" --body "@Robin please look"
Created CORE-124
@Robin looks like a mention and notified nobody: a mention is a node the web editor writes, and a
markdown body carries none. Hand work over with task edit --add-assignee <email>; taskara user list
finds the address.
```

`task comment` says the other half, because the answer to "then who can?" is nobody:

```
$ taskara task comment CORE-124 --body "thanks @Robin"
Commented on CORE-124
@Robin looks like a mention and notified nobody: a mention is a node and no comment box writes one —
the web's is plain text too, so a human cannot make one for you. Hand work over with task edit
--add-assignee <email>; taskara user list finds the address.
```

Two consequences worth knowing before you rely on the alternative:

- **A comment is a body like any other, and it is the one nobody can write a mention into.** The
  rule is real: a mention node in a comment notifies the person it names, puts them on the watch
  list so they hear the reply, and replaces the ambient "commented" row they would otherwise have
  got — one comment is one notification. But `TaskComment.body` is plain text and stays plain text
  (`docs/adr/0003`), so no client produces such a node — not this one, whose bodies are markdown,
  and not the web, whose comment box is a plain textarea. What a comment *does* reach is the task's
  **subscribers** — the reporter, the assignee, anyone already named in the description — so
  commenting still reaches people attached to the work, and only them.
- **An Effort body can never @-notify.** A map's body is markdown by design, and the inbox filters
  efforts out of every read besides — which is also true of a comment on an effort. Say who should
  look in the ticket you hand them, not in the map.

## Conventions

- **List people**: `taskara user list` — see [Identifying a person](#identifying-a-person).
- **List projects**: `taskara project list` — the one read that works in an empty workspace.
- **Create a task**: `taskara task create --project CORE --title "..." --body "..."`. Use
  `--body-file -` for anything multi-line; see [Bodies](#bodies-longer-than-a-line).
- **Create a task as a child of another**:
  `taskara task create --project CORE --title "..." --parent CORE-1`
- **Read a task**: `taskara task view CORE-123`. The body always comes back; add `--comments` for the
  thread as well.
- **List tasks**: `taskara task list --status unfinished --sort createdAt:asc`
- **Search by label and state**:
  `taskara task list --label wayfinder:task --status unfinished --sort createdAt:asc`
- **Comment on a task**: `taskara task comment CORE-123 --body "..."`
- **Apply / remove labels**:
  `taskara task edit CORE-123 --add-label "wayfinder:task" --remove-label "needs-triage"`
- **Set a blocker** (`CORE-9` blocks `CORE-123`): `taskara task edit CORE-123 --add-blocker CORE-9`
- **Remove a blocker**: `taskara task edit CORE-123 --remove-blocker CORE-9`
- **Claim**: `taskara task claim CORE-123` — atomic; see [Claiming](#claiming).
- **Assign to someone**: `taskara task edit CORE-123 --add-assignee robin.example@example.test`
  (a UUID works too; a name does not — see [Identifying a person](#identifying-a-person)).
- **Tell someone about a task**: assign it, or comment and let its subscribers hear. Writing
  `@Robin` in the body notifies nobody — see
  [An @-mention in a body reaches nobody](#an--mention-in-a-body-reaches-nobody).
- **Re-parent**: `taskara task edit CORE-123 --parent CORE-1`, or `--parent none` to detach.
- **Close**: `taskara task close CORE-123 --reason completed` (or `--reason canceled`).
  `completed` → `DONE`, `canceled` → `CANCELED`. Taskara has no "not planned".
- **Stop watching a task**: `taskara task unsubscribe CORE-123` — sticky; see
  [Watching](#watching).
- **Start watching again**: `taskara task subscribe CORE-123`

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
| 5 | Conflict — **includes losing a `task claim`, and a body rewrite another session got in ahead of** | Someone else has it; take another ticket, or re-apply your edit and retry |
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
Task, 60,000 for an Effort.** A refusal names the count, the limit and the kind, and exits 6.

Rewriting an **Effort** body additionally requires `--base-version`, because several sessions append
to it at once — see [Rewriting an Effort body](#rewriting-an-effort-body).

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

### Watching

Reporting a Task, being assigned one, or being `@`-mentioned in its description or in a comment on
it subscribes you to it, and every later comment, status change and description edit then reaches
your inbox. In practice only the description half of that puts anyone on the list, because nothing
writes a mention into a comment — see
[An @-mention in a body reaches nobody](#an--mention-in-a-body-reaches-nobody).

```bash
taskara task unsubscribe CORE-123           # stop hearing about it
taskara task subscribe CORE-123             # start again
taskara task list --subscription watching   # what reaches your inbox
taskara task list --subscription muted      # what you silenced, when you cannot remember why
```

`task unsubscribe` **sticks**: being mentioned or assigned again will not put you back on the list.
That is the difference between a decision and merely deleting a row, and it is what stops the verb
quietly reverting an hour after you use it. `task subscribe` withdraws the decision.

`--subscription` has no third value. A Task nobody has decided anything about is almost every Task in
the workspace, which is the list you already get without the flag.

**Unsubscribing stops the ambient stream, not being spoken to.** Comments, status changes and body
edits on a Task you merely watch stop reaching you. Being assigned it, being asked to review it, or
being `@`-mentioned in it still does — those are addressed to you by name, and none of them puts you
back on the list either.

**An agent may unsubscribe and may not subscribe.** Unsubscribing succeeds and changes nothing —
agents receive no notifications at all — so a cleanup script need not know who is running it.
`task subscribe` under an agent credential **exits 6** and names the reason. Find work with the
frontier query, which is a pull; there is no inbox to watch.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Not a default left unexamined: Taskara has no pull-request surface at all. It is a task manager, not a
code host, so there is nothing for this flag to turn on and no `taskara pr` equivalent to reach for.
Code review for this repo happens on GitHub; GitHub PRs are not in Taskara's triage queue and `/triage`
should not go looking for them.

## When a skill says "publish to the issue tracker"

Create a Taskara Task in the project the work concerns:

```bash
taskara task create --project CORE --title "..." --body-file -
```

`--project` is required. If you already hold a Task key, you already hold the answer — the prefix of
`CORE-123` is `CORE`. Otherwise ask:

```bash
taskara project list | jq -r '.projects[].keyPrefix'
```

### Starting a workspace that holds nothing

`project list` answers in an empty workspace, and `project create` fills one. Three commands take a
workspace from nothing to a charted effort:

```bash
taskara project list
taskara project create --name "Core platform" --key-prefix CORE
taskara task create --project CORE --title "..." --kind EFFORT --status IN_PROGRESS --body-file -
```

A key prefix is 2–12 characters, starts with a letter, and holds only letters and digits; write it in
any case and it is stored uppercase. A malformed one is exit **6**, `Validation failed` — the server
does not say which rule you broke, so check it against that sentence. It must be unique in the
workspace, and a prefix already taken is exit **5** — a conflict, not a rejection, because the
request was well-formed and somebody else has the name.

`project create` also takes `--parent <keyPrefix|id>` for a subproject and `--body`/`--body-file` for
a description. It does **not** take a team or a lead: `--team` means a slug on `task list` and would
have to mean a UUID here, and one flag with two meanings is worse than a missing one. A project
created without a team is visible workspace-wide, which is what an agent bootstrapping one wants. Set
a team or a lead in the web UI, or through MCP's `project_create`, which carries both.

## When a skill says "fetch the relevant ticket"

```bash
taskara task view CORE-123
```

## Wayfinding operations

Used by `/wayfinder`. The **map** is an **Effort** — one Task with `kind = EFFORT` — and its tickets
are its **child** Tasks.

- **Map**:
  ```bash
  taskara task create --project CORE --title "<effort name>" \
                      --kind EFFORT --status IN_PROGRESS --body-file -
  ```
  **`--status IN_PROGRESS` is not optional.** `status` defaults to `TODO` for every Task, and an
  Effort may never be `TODO` — a charted effort has already begun. Omit it and every create fails
  with a 400 that names the fix, exit 6. Pass `DONE` or `CANCELED` instead for an effort that is
  already over.

  The body holds Destination / Notes / Decisions-so-far / Not-yet-specified / Out-of-scope, and may
  run to 60,000 characters. An Effort lives in the project it concerns and carries **no assignee, due
  date, weight, milestone, cycle or parent** — passing any of them is a 400 naming the field. It is
  excluded from every list, count and metric about work — that is the point of the kind — so reach it
  deliberately by name:
  `taskara task list --kind EFFORT --query "<effort name>"`.

  Those readable refusals cover **create**. A `task edit` that pushes an existing Effort into an
  illegal shape — giving it an assignee, or a status of `TODO` — still hits the database constraint
  directly and comes back as a 500, exit 7. Do not expect the error to tell you which field was
  wrong on that path; do not do it.

  **No `wayfinder:map` label.** `kind = EFFORT` is the marker, enforced by database constraints
  rather than by convention, and a second marker that nothing checks is a second marker that can go
  wrong. Tickets still carry `wayfinder:<type>`.
- **Child ticket**:
  ```bash
  taskara task create --project CORE --title "..." \
                      --parent <effortKey> --label wayfinder:task --body-file -
  ```
  `--parent` takes the Effort's key and resolves it. The label is `wayfinder:<type>` — one of
  `research`, `prototype`, `grilling`, `task`. A ticket already created can be wired afterwards with
  `taskara task edit CORE-123 --parent <effortKey>`.

  **A ticket must be in the same project as its map.** The parent is resolved within the child's
  project, so a mismatch is `Parent task not found in this project`, exit 6 — which reads like a bad
  key and is usually a wrong `--project`. A whole effort therefore lands in one project, and the
  cheapest way to get that right is to take `--project` from the Effort's own key: the map `CORE-1`
  puts its tickets in `--project CORE`.
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
  Decisions-so-far. The Effort body is rewritten whole, and the rewrite must say which version it is
  based on — see [Rewriting an Effort body](#rewriting-an-effort-body).

Ruling a ticket out of scope is `taskara task close <key> --reason canceled` plus the line on the
Effort's Out of scope section.

### Rewriting an Effort body

There is no append operation. Decisions-so-far sits **in the middle** of the body — between Notes and
Not-yet-specified — so a line appended at the end lands in the wrong section, and teaching Taskara to
find the right one would put wayfinder's document format inside the API. The whole body is rewritten
every time.

Several sessions resolve tickets against one Effort at once, so a rewrite has to say what it was
based on. **`--base-version` is required when the body being rewritten belongs to an Effort**, and it
must be the version that came back with the body you edited:

```bash
# --comments is what makes `task view` return the body; the plain view is a summary.
taskara task view "$EFFORT" > /tmp/effort.json
jq -r .description /tmp/effort.json > /tmp/effort-body.md
VERSION=$(jq -r .version /tmp/effort.json)

# ...edit /tmp/effort-body.md, adding one line to Decisions so far...

taskara task edit "$EFFORT" --body-file - --base-version "$VERSION" < /tmp/effort-body.md
```

Do not re-read the version just before writing. The point of the flag is that the version and the
body come from the same read; a fresher one waves through exactly the write it exists to catch.

**Exit 5 means another session wrote first and your line is not in the body.** It is not a warning,
and nothing was written. The current body and its version come back on stdout under `error.task`, so
the retry costs no extra read:

```bash
if ! taskara task edit "$EFFORT" --body-file - --base-version "$VERSION" \
       < /tmp/effort-body.md > /tmp/edit-result.json; then
  # Exit 5: error.task is the row as it is now, including the other session's line.
  jq -r .error.task.description /tmp/edit-result.json > /tmp/effort-body.md
  VERSION=$(jq -r .error.task.version /tmp/edit-result.json)
  # ...re-apply your own line to /tmp/effort-body.md, then send it with this VERSION.
fi
```

Re-apply **your own line** to the body that came back. Do not resend the body you had: it is missing
the other session's line, and sending it would lose exactly what the refusal saved.

Omitting `--base-version` on an Effort is a 400, exit 6, and nothing is written. A work Task's body
is a value one caller sets rather than an index several append to, so `taskara task edit <key> --body`
needs no version — and gets no protection.

## Three unrelated `AGENT` tokens

They coexist and mean different things. Do not reason from one to another.

- **`WorkspaceRole.AGENT`** — a permission profile on a workspace membership. It says what an identity
  may do. Nothing may infer agent-ness from it: role is per-workspace, carries no history, and a role
  change would silently reinterpret past work.
- **`ActorType.AGENT`** — derived **server-side** from the authenticated `User.kind`, never from a
  client header. This is the one that means "an agent did this".
- **`TaskSource.AGENT`** — set when a **human** uses the in-app assistant dock. It describes the
  surface a row came through, not who wrote it.

## Pointing another repo at Taskara

This file is Taskara's own copy. To make a *different* repository's skills read Taskara instead of
GitHub, five things have to be true in that repo.

**1. `taskara` is on `$PATH`.** One command, from the plugin directory:

```bash
cd /path/to/taskara/plugins/taskara-agent && bun link
```

That symlinks the `bin` this package already declares into `~/.bun/bin`, so plain `taskara` works
from any directory. It points at the source rather than a copy, so a `git pull` updates the command
with no reinstall — which matters while this surface is still moving.

An **alias** works too and is worth knowing about, because a skill pastes `taskara …` into a
**non-interactive** shell, and a shell alias defined in an interactive profile is not there. `bun
link` is a real file on `$PATH` and does not have that problem.

`bun build --compile` produces a standalone binary and is the wrong tool here: it is 58 MB, it is
*slower* to start than the linked source (210 ms against 104 ms, because that much binary has to be
paged in), and on Apple Silicon an unsigned one is killed by the kernel with **exit 137** and no
message — which reads as a crash in your own code. It earns its place only where Bun cannot be
installed at all; then build it in CI and `codesign -s -` it.

**2. The agent has a credential.** One agent User per human operator, shared across every runtime.
Minting the first one is an admin act and is not self-service — a workspace owner runs:

```bash
taskara user list --kind AGENT     # find or confirm the agent User
# then POST /agent-credentials as an admin; the plaintext is returned exactly once.
```

Put it in the environment, never in a file the repo tracks:

```bash
export TASKARA_API_URL=https://taskara.example
export TASKARA_WORKSPACE_SLUG=<slug>
export TASKARA_AGENT_TOKEN=<the token, shown once>
export TASKARA_AGENT_RUNTIME=CLAUDE_CODE   # or CODEX / OPENCLAW / HERMES
```

**3. The agent is on the team that owns the work.** Workspace membership is not enough. Projects are
team-scoped, and an agent that is a workspace member but on no team reads an **empty workspace** —
`taskara project list` answers `[]` and `task list` answers `0`. That looks exactly like a broken
credential and is not one: it is the access rule working. Add the agent to the team the same way you
would a colleague, and the same projects appear.

**4. The repo has a project to write into.** `taskara project list`, or `taskara project create`
if it is a fresh workspace. Its **key prefix** — not its UUID — is what every later command takes.

**5. The repo has these three files and an `## Agent skills` block.** Copy `docs/agents/` from here
into the new repo and change only what is repo-specific: the project key prefix in the examples, and
`domain.md`, which points at *that* repo's own vocabulary. Then add the `## Agent skills` block to
its `AGENTS.md` — `CLAUDE.md` names one runtime in a filename the other three have to read.

A repo is correctly pointed when `taskara task list --parent <effortKey> --status unfinished
--assignee none --blockers none --sort createdAt:asc` returns that effort's frontier, and
`taskara task claim <key>` exits **5** when somebody already holds it.
