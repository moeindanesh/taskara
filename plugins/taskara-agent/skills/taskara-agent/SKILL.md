---
name: taskara-agent
description: Work Taskara tasks, efforts, projects, milestones and daily reports — create, search, claim, edit, comment, close, plan and report — through the Taskara CLI or its MCP tools.
---

# Taskara Agent

Taskara is a team task manager that is also this team's issue tracker. Its word for a unit of work is
a **Task** (key `CORE-123`), and its word for the root of a piece of exploratory work — what the
wayfinder skills call a *map* — is an **Effort**, a Task with `kind = EFFORT`.

Two surfaces over one core:

- **The CLI**, `taskara <noun> <verb>`, for anything running in a shell. This is the whole tracker
  contract and the only surface a skill file can reach, because a skill's instructions are strings
  pasted into Bash.
- **The MCP tools**, for a person in conversation.

## Environment

Both surfaces read:

- `TASKARA_API_URL`
- `TASKARA_WORKSPACE_SLUG`
- `TASKARA_AGENT_TOKEN` — an agent credential, presented as a bearer token. This is how an agent
  authenticates; an agent User is refused on the email path.
- `TASKARA_USER_EMAIL` — the legacy header path, for a **human** driving the MCP tools. Ignored when
  a token is set.
- `TASKARA_AGENT_RUNTIME` (optional) — `CLAUDE_CODE`, `CODEX`, `OPENCLAW` or `HERMES`. Set it in the
  per-runtime config, since one binary serves all four. It is recorded on the rows an agent writes
  and ignored when the configured identity is a human. A value that is not one of the four is a
  configuration error rather than a silent omission.

## CLI

```
taskara task create   --project <keyPrefix|id> --title <s> [--body <s> | --body-file <path|->]
                      [--kind WORK|EFFORT] [--parent <key|id>] [--status S] [--priority P]
                      [--label a,b] [--assignee <id|email>] [--due-at <iso>] [--milestone <id>]
taskara task view     <key|id> [--comments]   # body always; --comments adds the thread
taskara task list     [--parent <key|id|none>] [--status unfinished|S,S]
                      [--assignee <id|email>|none|me]
                      [--blockers none|any] [--label <name>|none] [--project <keyPrefix|id>]
                      [--kind WORK|EFFORT] [--subscription watching|muted]
                      [--sort createdAt:asc] [--query <s>] [--limit n]
taskara task edit     <key|id> [--add-label L] [--remove-label L]
                      [--add-blocker K] [--remove-blocker K] [--add-assignee <id|email>]
                      [...fields] [--base-version n]
taskara task claim    <key|id>
taskara task comment  <key|id> [--body <s> | --body-file <path|->]
taskara task close    <key|id> [--reason completed|canceled]
taskara task subscribe   <key|id>
taskara task unsubscribe <key|id>

taskara project list  [--include-archived]
taskara project create --name <s> --key-prefix <CORE> [--body <s> | --body-file <path|->]
                      [--parent <keyPrefix|id>]

taskara user list     [--query <s>] [--kind HUMAN|AGENT] [--role R] [--limit n] [--offset n]
```

`--project` takes a **key prefix** — `CORE`, the front half of every key in that project — or a UUID.
A prefix has no hyphen and a UUID always does, so the two never collide. `project list` is the read
that works in a workspace holding nothing at all; without it, the only shell-side source of a project
was an existing Task, and an empty workspace could not be started from a script.

`--assignee` and `--add-assignee` take a **UUID or an email address**, and never a name: `User.name`
carries no unique constraint, so a name is exit **1** before anything is sent. `user list` is the
read that finds either handle, and it is the only way to reach somebody who holds no Task — their
UUID appears in no key, no URL and no prose. Agents are in that roster too, marked `kind: "AGENT"`
with `operatorId` naming the human they act for; they are teammates, and assignable, but tell the
user when you are handing work to one.

**An @-mention in a body reaches nobody.** A mention is a rich-text node and every body you send
from here is markdown — so `@Robin please look` in a task body, an effort body or a comment notifies
no one, whatever handle you spell. Address a person with `--add-assignee`, not in prose. A body that
looks like it tried is still written as given, with a line on stderr naming who was not told; the
exit code stays 0. The web editor writes those nodes into a **description**, so asking a human to
add one there is a real thing to ask; nothing writes one into a **comment** — the web's comment box
is plain text too — so do not ask for that one.

**stdout is always JSON**, the result on success and `{ "error": ... }` on failure. **stderr is
always the human line.** The exit code is what you branch on.

### Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Succeeded | Continue. |
| 1 | Usage — bad noun, verb or flag. Nothing was sent. | Fix the command. |
| 2 | Configuration — required environment missing or unusable. Nothing was sent. | A human fixes the config. |
| 3 | Auth — 401/403. Credential absent, wrong, revoked, or not permitted. | A human fixes the credential. |
| 4 | Not found — 404. | Check the key. |
| 5 | Conflict — 409. Includes losing a `task claim`, and a body rewrite another session got in ahead of. | Someone else has it; move on, or re-apply and retry. |
| 6 | Rejected — the server understood the request and refused it. | Fix the request. |
| 7 | Server error — 5xx. Whether the work happened is unknown. | Retry, then escalate. |
| 8 | Unreachable — no HTTP response at all. | Retry; check the API is up. |

### The frontier

The unfinished, unassigned, unblocked children of one effort — what is takeable right now:

```bash
taskara task list --parent <effortKey> --status unfinished --assignee none \
                  --blockers none --sort createdAt:asc
```

### Claiming

`taskara task claim <key>` is conditional server-side: it takes the task only if nobody holds it,
and exits **5** naming the holder if somebody does. Always claim before starting work on a shared
effort, and treat exit 5 as "pick a different ticket" — never as "the claim looked stale".

It is deliberately not idempotent. Re-claiming a task you already hold also exits 5, because "you
hold this" and "you just took this" are different answers.

### Watching

Reporting a task, being assigned one, or being mentioned in its description or in a comment
subscribes you to it — though only the description half happens in practice, since nothing writes a
mention into a comment. `taskara
task unsubscribe <key>` stops that, and it **sticks**: being mentioned or assigned again will not
put you back on the list. `taskara task subscribe <key>` withdraws the decision.

`taskara task list --subscription watching` is what you are notified about; `--subscription muted`
is what you silenced, which is the only way to find a decision you made months ago.

It stops the ambient stream, not being spoken to: being assigned the task, asked to review it, or
`@`-mentioned in it still reaches you, and still does not put you back on the list.

An agent may unsubscribe — harmlessly, since agents receive no notifications at all — but
`task subscribe` under an agent credential exits **6** and says why. Find work with the frontier
query above, not with an inbox.

### Labels and blockers

`--add-label` / `--remove-label` are applied **server-side**, so two agents relabelling one task do
not overwrite each other. Both flags repeat, and accept comma-separated lists.

`--add-blocker K` means *K blocks this task*. Blocker edges are separate rows on separate endpoints,
so a `task edit` touching both fields and blockers is not one atomic write.

A blocker can live in a project your credential cannot read. `task view` prints **`null`** in
`blockers` where its key would be, and a subtask you cannot open prints `{ "redacted": true,
"open": … }` — the entry is kept rather than dropped, so the length of `blockers` is still the
number of things in the way. Treat a `null` as blocking: it is real work, and the only thing you are
missing is permission to name it. Ask the person who owns that team.

The workspace activity feed behind `report_weekly` is filtered the other way — a row about work your
credential cannot read is **dropped**, not marked. So `recentActivity` is "what happened in work you
can see", never a complete history of the workspace, and a quiet week there may just mean a quiet
week in your projects. Do not read an empty feed as nothing having happened.

### Bodies

`--body-file -` reads the body from stdin. Use it for anything long: an effort body is tens of
kilobytes of markdown, and inline shell quoting of that is where a paste breaks. The description
ceiling is the server's — 15,000 characters for work, 60,000 for an effort.

**A line break cannot be written as `\n` on a command line.** `--body "one\ntwo"` is argv, and no
shell turns those two characters into a newline inside quotes — so the body used to arrive with a
backslash and an `n` in it, and every reader showed them. An inline body is now read the way it was
meant: `\n` and `\r\n` become line breaks, and the command says on stderr how many it gave back.

It gives back none, and sends the body exactly as written, when the body already has a real line
break in it, when a backslash in it begins anything else (`\t`, `\d`, `C:\node`), or when the `\n`
is inside backticks or a quoted literal — so a body *about* an escape survives being one. It also
leaves the web editor's serialised document alone: that is JSON on one line, where `\n` is JSON's
own escape and decoding it would stop the document parsing. So a body read with `task view` and
written back is safe. To insist on the two characters anywhere else, double the backslash: `\\n`
sends `\n` and disables the reading for that whole body. `--body-file` and stdin are never read this
way; they are the bytes you chose.

A body is written whole, so two sessions editing one body would silently overwrite each other.
`--base-version n` is the version that came back with the body you edited — send it, and a write the
row has moved past is refused with exit **5** rather than applied over somebody else's line. It is
**required** when rewriting an **effort** body, whose Decisions-so-far index several sessions append
to at once; omitting it there exits 6 and writes nothing. `task view` reports `version` on every
read, and `--comments` is what makes it return the description as well.

On exit 5 the current row is on stdout under `error.task`, body and version together. Re-apply your
own change to *that* body and send it with *that* version. Never resend the body you had.

## MCP tools

Same `noun_verb` grammar as the CLI.

| Tool | |
|---|---|
| `workspace_check` | Check the API URL, workspace and identity |
| `project_list` `project_create` `project_summarize` | Projects |
| `milestone_list` `milestone_create` `milestone_update` `milestone_summarize` | Milestones |
| `task_search` `task_list_mine` `task_view` | Reading tasks |
| `task_create` `task_edit` `task_claim` `task_comment` `task_attach` `task_set_milestone` | Writing tasks |
| `task_propose` `agent_action_apply` | Turning a discussion into proposed tasks, then applying them |
| `plan_daily` `plan_work` `backlog_triage` `blocker_detect` | Planning |
| `report_daily_draft` `report_daily_submit` `report_weekly` | Reports |
| `user_list` | The workspace roster, readable by any member including an agent credential. Agents are in it, marked by `kind` |
| `user_create` `user_set_role` | Admin-only; not reachable with an agent credential |

`task_search` carries the whole query vocabulary, so the frontier is one call:
`parentId`, `status: 'unfinished'`, `assigneeId: 'none'`, `blockers: 'none'`, `sort: 'createdAt:asc'`.

## Safety

- Ask for confirmation before applying bulk changes.
- Do not mark tasks `DONE` or `CANCELED` unless the user explicitly asks.
- Do not complete, cancel, archive, or otherwise change milestone lifecycle implicitly. Keep those
  actions deliberate and preserve unfinished-task policy decisions.
- Assign tasks only to an open milestone in the same project; let the API enforce this invariant and
  report its error instead of retrying with a different milestone silently.
- Use a milestone's returned `version` for metadata updates. On conflict, refetch and show the user
  what changed before retrying.
- Prefer `addLabels`/`removeLabels` over `labels`, which replaces the whole set and loses a
  concurrent edit.
- Pass `baseVersion` on `task_edit` whenever you send a `description`. A body cannot be sent as a
  delta, so the version is the only thing standing between a concurrent edit and a lost paragraph.
  On a conflict, refetch, re-apply the change, and show the user what moved before retrying.
- Write a real line break in a `description` or comment `body`. The field carries one; there is no
  shell behind it to escape for. A `\n` written as two characters is read as the break it meant and
  the result says so under `warning` — but that is a repair, not the contract. Double the backslash
  when you mean the characters.
- Draft a daily report with `report_daily_draft` and show it to the user for edits; only call
  `report_daily_submit` once they confirm the wording. The report is their voice, not yours.
- Include task keys in summaries after mutations.
