# Taskara

Agentic team task manager for a Persian-speaking (RTL, Jalali-calendar) team, backed by Postgres/Prisma, with Mattermost and agent integrations. One workspace holds the whole team; managers run the team from it.

## Language

**Task**:
A unit of work with a key (e.g. `CORE-123`), exactly one project, at most one assignee, an optional weight (1/2/3/4/8) and an optional due date. The web UI's `/issue/:taskKey` URLs are a naming leftover — the concept is Task.
_Avoid_: Issue, ticket

**Workspace**:
The top-level container for the whole team: members, teams, projects, and tasks. One team = one workspace; routing and API access are scoped by its slug.
_Avoid_: Org, organization

**Today**:
The current calendar day in the workspace timezone (Tehran), identified by a server-computed `dateKey` (`YYYY-MM-DD`). Clients never compute the day themselves.

**Today Load** (بار امروز):
The computed set of tasks representing a person's working set for today: active tasks (BACKLOG/TODO/IN_PROGRESS/IN_REVIEW/BLOCKED) with a due date on or before today — overdue included, no age cap — plus tasks completed today. Derived from task data, never self-reported.
_Avoid_: Today plan (that term is reserved for self-reported intent — see Plan)

**Plan**:
What a person *says* they will do, self-reported as free text in their daily report (`planText`). Distinct from Today Load, which is computed from due dates.
_Avoid_: Today load

**Daily Report** (گزارش روزانه):
A person's end-of-day check-in for one `dateKey`: what was completed, what was unplanned, blockers, the next plan, and help needed. One per member per day; it *is* the check-in (no separate model).

**Unfinished**:
A Task that is neither DONE nor CANCELED.
_Avoid_: Open; Active (Today Load's active set is narrower — it drops BACKLOG)

**Blocker**:
A Task that must finish before another Task can start, recorded as a dependency edge. A blocker is *open* while it is unfinished. Unrelated to the BLOCKED status, which a person sets by hand.
_Avoid_: Dependency (that names the edge, not the task)

**Team Overview**:
The workspace's main page: a force-directed graph (Obsidian-style) with the workspace as the central node, each member connected to it, and each member's Today Load as leaf nodes — task color encodes status, size encodes weight.
_Avoid_: Dashboard, graph view
