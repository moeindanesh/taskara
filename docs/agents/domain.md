# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the ubiquitous language. It defines Task, Effort, Workspace,
  Today, Today Load, Plan, Daily Report, Unfinished, Blocker and Team Overview, each with an
  _Avoid_ list of synonyms that are **not** this project's words.
- **`docs/adr/`** — read the ADRs that touch the area you are about to work in:
  - `0001-hand-rolled-svg-force-graph.md`
  - `0002-frontier-is-a-task-filter-composition.md`

There is no `CONTEXT-MAP.md` and no per-package `CONTEXT.md`. If any of these files is missing,
**proceed silently** — do not flag the absence and do not propose creating them upfront.
`/domain-modeling` creates them lazily, when a term or a decision actually gets resolved.

## File structure

Single-context:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-hand-rolled-svg-force-graph.md
│   └── 0002-frontier-is-a-task-filter-composition.md
├── apps/            api, web, menubar, mattermost-bot
├── packages/        db, shared
└── plugins/         taskara-agent
```

This is a Bun workspace with several packages, but it is **one** context, not several. The packages
are layers of a single product — an API, a web client, a Prisma schema, a shared wire vocabulary, an
agent surface — and they all speak the same language about the same Tasks. A term means the same
thing in `apps/api` as it does in `apps/web`, which is exactly the condition under which one
`CONTEXT.md` is correct. Split it only if some package ever means something different by *Task*.

## Use the glossary's vocabulary

When your output names a domain concept — an issue title, a refactor proposal, a hypothesis, a test
name — use the term as `CONTEXT.md` defines it, and do not drift to the synonyms it lists under
_Avoid_.

Two of those matter constantly, because the skills' own vocabulary collides with the glossary:

- The skills say **issue** and **ticket**; this project says **Task**. Both are on the _Avoid_ list.
- The skills say **map**; this project says **Effort**. `docs/agents/issue-tracker.md` carries that
  translation so nothing else has to.

If the concept you need is not in the glossary yet, that is a signal — either you are inventing
language the project does not use (reconsider), or there is a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (the frontier is a task filter composition) — but worth reopening because…_
