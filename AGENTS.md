# Taskara

Agentic team task manager for a Persian-speaking (RTL, Jalali-calendar) team, backed by
Postgres/Prisma. One workspace holds the whole team. `README.md` covers running it; this file is what
an agent needs before it starts.

**This repository is public.** Security specifics live in `.scratch/` (gitignored) and are referenced
by path, never pasted into a file, a commit or an issue. The agent credential is referenced by
environment variable name — `TASKARA_AGENT_TOKEN` — never by value.

## Agent skills

### Issue tracker

Issues and PRDs live in **Taskara itself**, as Tasks with keys like `CORE-123`, driven by the
`taskara` CLI (`plugins/taskara-agent/src/cli.ts`). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name; Taskara creates a label on
first use, so there is no pre-seeding step. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and `docs/adr/` at the repo root, covering every workspace package.
See `docs/agents/domain.md`.

## Working in this repo

- `bun run test:api` and `bun run test:web` are the suites; `bun run typecheck` covers all six
  packages. Run all three before calling anything done.
- Migrations are real migrations. `bun run db:push` **cannot apply `CHECK` constraints**, so a
  db-push bootstrap yields columns with no enforcement — the guard tests in
  `apps/api/src/routes/` are what catch it.
- The CLI's exit codes are a published contract, asserted end to end in
  `apps/api/src/routes/agent-cli.test.ts`. Changing one changes the behaviour of every skill that
  branches on it.
