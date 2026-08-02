# taskara

The CLI and MCP server for [Taskara](https://github.com/moeindanesh/taskara) — a team task manager
that is also an issue tracker an agent can drive.

```bash
bun install -g taskara
taskara login
```

`login` signs you in, asks Taskara for a credential for **your own** agent — creating that agent and
mirroring your team memberships if you have none — and stores it in `~/.taskara/credentials.json` at
mode 600. No admin has to be involved and no token is pasted anywhere. Your password is never
stored: it buys one session, the session buys the credential, and the session is deleted before the
command returns.

Then:

```bash
taskara task list --assignee me
taskara task claim CORE-12
```

Run `taskara` with no arguments for the full grammar.

## Two surfaces, one core

- **The CLI** is what a *skill* can reach. Agent skills are written in shell — they paste commands
  into Bash and branch on exit codes — so this covers the whole tracker contract rather than the
  read half of it.
- **The MCP server** (`taskara-mcp`) is for conversation, where a tool call is natural and an exit
  code is not.

Both are the same operations. Neither is a subset of the other.

## Exit codes

A script branches on these; **stdout is always JSON** and **stderr is always the human line**.

| | |
|---|---|
| `0` | ok |
| `1` | usage — nothing was sent |
| `2` | configuration — nothing was sent |
| `3` | auth: absent, wrong, revoked, or not permitted |
| `4` | not found |
| `5` | conflict — somebody else holds it, or the row moved |
| `6` | rejected |
| `7` | server error — the outcome is unknown |
| `8` | unreachable |

`taskara task claim CORE-12 || handle_it` works, and `$(taskara task view CORE-12)` always parses.

## Configuration

`login` writes all of this. Set it by hand only in CI, where the environment wins over the stored
file, field by field.

| | |
|---|---|
| `TASKARA_API_URL` | The API base URL. |
| `TASKARA_WORKSPACE_SLUG` | One workspace holds the team; every read and write is scoped by it. |
| `TASKARA_AGENT_TOKEN` | The agent credential, as a bearer token. |
| `TASKARA_AGENT_RUNTIME` | `CLAUDE_CODE`, `CODEX`, `OPENCLAW` or `HERMES`. One binary serves all four; each runtime's config declares which it is. |

## Requires Bun

Bundled as Bun modules and run with the Bun runtime — `bun install -g taskara`, not npm's.

## Licence

MIT.
