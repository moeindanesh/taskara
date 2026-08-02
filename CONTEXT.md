# Taskara

Agentic team task manager for a Persian-speaking (RTL, Jalali-calendar) team, backed by Postgres/Prisma, with Mattermost and agent integrations. One workspace holds the whole team; managers run the team from it.

## Language

**Task**:
A unit of work with a key (e.g. `CORE-123`), exactly one project, at most one assignee, an optional weight (1/2/3/4/8) and an optional due date. The web UI's `/issue/:taskKey` URLs are a naming leftover — the concept is Task.
_Avoid_: Issue, ticket

**Effort**:
A Task with `kind = EFFORT`: the root of a piece of exploratory work, holding its destination, notes and decisions, and owning its tickets as ordinary child Tasks. It is a real Task with a real key and a real URL, but it is not a unit of work — it carries no assignee, due date, weight, milestone or parent, and only ever sits in `IN_PROGRESS`, `DONE` or `CANCELED`. It lives in the project it concerns. No human is offered one as something to pick up, and no metric counts one. Everything else is `kind = WORK`.
_Avoid_: Map (the agent skills' word for the same thing — the tracker doc carries the translation), epic

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

**Mention** (منشن):
Being addressed by name inside a body — a Task's description, or a comment on it. A mention is a **node** the rich-text editor writes when a human picks a colleague out of an autocomplete; it is never a spelling, so `@robin`, an email address or a UUID typed as text mentions nobody, in any client. Being mentioned notifies that person, subscribes them to the Task, and *replaces* the ambient notification for the same write rather than arriving beside it — one write is one notification. The rule is identical in both bodies and **only a description has a writer**: the editor is mounted on descriptions only, a comment's body is plain text (see Body), and so a comment mention is a rule nothing can currently trigger. Say that plainly rather than implying a human could; the way to reach a person about a comment is to assign them the Task.
_Avoid_: Tag, @-reference

**Body**:
The prose of a Task, in two fields that are two different things. A **description** is revised — one field, rewritten whole, holding either markdown or the web editor's serialised document depending on which client last wrote it. A **comment** is written once and never edited (there is no edit route), and its body is **plain text**: every reader, in every client, gets the characters the author typed. Taskara deliberately runs no single body format across the two — `docs/adr/0003` records why one would cost more than it buys. An Effort's body is a description that the web only reads.
_Avoid_: Content, rich text (the editor's document is one of two things a description may hold, not what a body *is*)

**Watching** (دنبال‌کردن):
A person's relationship to one Task, in exactly three states. **Watching** — a `TaskSubscription` row — means the ambient stream of that Task reaches their inbox: comments, status changes, description edits. **Muted** — a `TaskMute` row — is the recorded decision *not* to watch, and it is sticky: reporting, assignment and mentions may not undo it, only the person's own act may. **No decision** is neither row, and it is the default that auto-subscribe is free to fill. Muting stops the ambient stream and never stops being addressed by name — assignment, a review request and a mention still arrive. Only a person watches; an agent is not an audience and holds none of the three.
_Avoid_: Subscribed (the row and the API path are `subscription`, but the state a human is in is *watching*), Ignored, Following, Unwatched

**Team Overview**:
The workspace's main page: a force-directed graph (Obsidian-style) with the workspace as the central node, each member connected to it, and each member's Today Load as leaf nodes — task color encodes status, size encodes weight.
_Avoid_: Dashboard, graph view
