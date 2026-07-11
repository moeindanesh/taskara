# Milestones Premium UX and Implementation Plan

## Goal

Add first-class Milestones to Taskara so a team can define a project-scoped goal such as:

- a product feature to deliver;
- an implementation phase to finish;
- another meaningful project checkpoint that groups executable tasks.

Milestones must be easy to reach from the main sidebar, fast to create, connected directly to tasks, clear about ownership and timing, and useful for both day-to-day execution and stakeholder-level progress.

This plan treats “Milestones” as one guaranteed-visible primary navigation destination. It does not automatically put every milestone into the global sidebar, because that becomes noisy as a workspace grows. Individual pinning can be added later with a small cap.

## Recommended Product Decision

Use this hierarchy:

    Workspace
      └── Team
          └── Project
              └── Milestone
                  └── Task

Cycles remain an orthogonal timebox:

    Task → one required Project
    Task → zero or one Milestone in that Project
    Task → zero or one Cycle

The first release should make these decisions explicit:

1. A milestone belongs to exactly one project.
2. A task belongs to zero or one milestone.
3. The task and milestone must belong to the same project.
4. A project can have multiple active milestones; Taskara must not force one artificial “current” milestone.
5. Milestone progress is computed from tasks, but milestone lifecycle is changed manually.
6. Reaching 100% suggests completion; it never auto-completes the milestone.
7. Cycles are not renamed, migrated, or reused as milestones.
8. Cross-project strategic goals are a future Goals or Initiatives concept, not a v1 milestone.

## Product Vocabulary

| Object | Meaning in Taskara | Use it when |
| --- | --- | --- |
| Project | A durable workstream with a task key namespace, team, lead, docs, health updates, and optional subprojects | The work needs its own identity and long-lived operating context |
| Milestone | A project-scoped goal container, typed as a feature, phase, or other checkpoint | A meaningful outcome should group tasks and expose progress |
| Task | Executable work with status, assignee, priority, weight, due date, and activity | Someone needs to do something |
| Cycle | A bounded execution timebox with required start and end | Work is being scheduled into a sprint-like period |
| Future Initiative | A strategic objective that can roll up several projects | The outcome crosses project boundaries |

A feature milestone can later outgrow its project-scoped role. A future “Promote to project” workflow is preferable to making milestones hierarchical or cross-project in v1.

## Industry Research

Research was checked against live official documentation on 2026-07-11. Product details and paid-tier availability can change.

### Linear

[Linear project milestones](https://linear.app/docs/project-milestones) represent stages in one project’s lifecycle. They support optional dates and descriptions, issue assignment, filtering, grouping, ordering, timeline interaction, and completion percentages derived from completed issues. They cannot be shared across projects, and an oversized milestone can be converted into a project.

[Linear projects](https://linear.app/docs/projects) are features or large units of work, while [Linear initiatives](https://linear.app/docs/initiatives) are workspace-level objectives that roll up projects.

Takeaways for Taskara:

- Keep milestones project-scoped and aggregate them through a global hub.
- Keep progress separate from manual lifecycle.
- Support fast task assignment, filters, grouping, and ordering.
- Do not assume projects execute milestones strictly one after another.
- Leave room for promotion to a project when scope grows.

### GitHub

[GitHub milestones](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/about-milestones) group repository issues and pull requests. Their detail page shows description, due date, completion percentage, open and closed counts, and the related work list.

Takeaways for Taskara:

- A simple title, description, and date make creation fast.
- Users trust transparent completed/total counts.
- Bulk association and milestone filtering are important once the base flow works.
- GitHub’s sparse repository-level model is useful evidence, but it is not a complete premium UX to copy.

### Jira

[Jira versions](https://support.atlassian.com/jira-software-cloud/docs/what-is-a-version/) group features and fixes released together. Versions may span sprints, appear in project release planning, and support explicit resolution of unfinished work during release.

Takeaways for Taskara:

- Completion should be deliberate.
- Unfinished work needs an explicit keep, move, or unassign decision.
- Readiness warnings should explain inconsistencies without silently changing tasks.
- Release approvals and deployment data are later-stage features, not part of the first milestone release.

### Asana

[Asana project milestone guidance](https://asana.com/resources/project-milestones) defines a classic milestone as a zero-duration checkpoint and distinguishes it from a goal, task, deliverable, and project phase. It warns against creating too many milestones, using them as tasks, or separating them from execution work.

[Asana Goals](https://help.asana.com/s/article/get-started-with-asana-goals?language=en_US) separate owner, status, progress, time period, type, and visibility. Goal progress and health are also independent concepts.

Takeaways for Taskara:

- Taskara’s requested concept is closer to a tactical goal container than Asana’s strict checkpoint.
- The product must state its definition clearly in onboarding and empty states.
- Lifecycle, health, progress, and closure outcome must not be collapsed into one status field.
- Ownership and timing should be visible on the overview and detail screens.

### GitLab

[GitLab milestones](https://docs.gitlab.com/user/project/milestones/) group work toward a goal, support optional start and due dates, work alongside iterations, show completed/total progress, and allow each work item to have one milestone. GitLab also exposes Milestones in its planning sidebar.

Takeaways for Taskara:

- Milestones and cycles can coexist without semantic conflict.
- One milestone per task is a proven, predictable model.
- A global Milestones destination can coexist with project-scoped milestones.
- Issue weight is useful supporting information, but count-based progress is the clearest headline.

### Accessibility

[WCAG 2.2 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) requires a simple pointer alternative for functionality that uses drag interactions.

[WCAG 2.2 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) defines a 24 by 24 CSS-pixel minimum target or sufficient spacing.

Takeaways for Taskara:

- Dragging may be offered for speed, but menus and click/tap controls must provide equivalent actions.
- Dense milestone controls still need usable targets, visible focus, and text or shape in addition to color.

## Research Synthesis

The strongest cross-industry patterns are:

1. Scope milestones narrowly.
   Project scope and one milestone per task keep progress and permissions understandable.

2. Make progress automatic and transparent.
   The headline should be completed eligible tasks divided by total eligible tasks, with the exact counts beside it.

3. Keep lifecycle manual.
   Task completion is evidence of progress, not proof that the goal itself was achieved.

4. Make dates optional but visible.
   Unscheduled milestones are valid, but the UI should make “No target date” obvious.

5. Keep creation lightweight.
   Name, project, and type are enough to start. Owner and target date remain visible but optional.

6. Put execution inside the milestone.
   Users should create, add, remove, filter, and inspect tasks without leaving the detail experience.

7. Treat completion as a workflow.
   Unfinished tasks require an explicit decision and a clear explanation of the result.

8. Prefer archive and restore over destructive deletion.
   Historical task links and progress are useful after a milestone ends.

9. Do not flood the sidebar.
   One top-level hub is the stable entry point. Individual pinning is optional and capped.

10. Design drag interactions as enhancements.
    Every reorder, assignment, and date move needs a non-drag alternative.

## Current Taskara Findings

Taskara already contains two partial seams for milestones, but no real milestone feature:

- packages/shared/src/index.ts already accepts milestone as a task display-property value.
- apps/web/lib/taskara-types.ts contains the matching display-property type.
- apps/web/lib/fa-copy.ts already contains Persian project copy for milestones.
- apps/web/components/taskara/tasks-view.tsx does not expose or render that display property.
- packages/db/prisma/schema.prisma has a Cycle model and Task.cycleId, but no Milestone model.
- Taskara’s Cycle has required startsAt and endsAt and is therefore a timebox, not the requested goal.

Relevant architecture:

- Project, Task, and Cycle models live in packages/db/prisma/schema.prisma.
- Shared Zod contracts live in packages/shared/src/index.ts.
- Project routes and access behavior live in apps/api/src/routes/projects.ts and apps/api/src/services/team-access.ts.
- Task relation validation and serialization live in apps/api/src/services/tasks.ts.
- Workspace bootstrap and sync visibility live in apps/api/src/routes/sync.ts.
- Web routes live in apps/web/src/App.tsx.
- The primary sidebar lives in apps/web/components/layout/sidebar/app-sidebar.tsx.
- Global commands and entity search live in apps/web/components/layout/main-layout.tsx.
- The hot local-first store lives in apps/web/lib/task-sync.ts and apps/web/lib/workspace-data.

Two implementation hazards deserve special treatment:

1. Server-derived progress is mandatory.
   The sync bootstrap intentionally omits older completed tasks. Progress computed from the browser task cache would undercount historical completion.

2. The current sidebar is intentionally minimal and role-aware.
   It renders one primary destination for the manager/member, followed by a collapsed Teams section. Milestones should be a direct top-level sibling between that primary destination and Teams, visible for every role with project access.

## Premium V1 Scope

The premium launch baseline includes:

- one guaranteed-visible primary Milestones sidebar destination;
- a global list/detail hub for all accessible project milestones;
- milestone type, lifecycle, owner, health, description, start date, and target date;
- automatic server-derived progress and attention reasons;
- project-scoped create, edit, reorder, activate/reactivate, complete, reopen, cancel, archive, restore, and deep links;
- task assignment from the milestone, task detail, task composer, and task context actions;
- milestone task filters, grouping, and display badges;
- command-menu navigation, creation, and milestone search;
- audit history and local-first/realtime updates;
- RTL, Persian copy, Jalali date display, responsive layouts, keyboard support, and accessible non-drag actions.

The following are premium follow-ups, not launch blockers:

- individual milestone pinning under the main nav;
- bulk assignment across many selected tasks;
- milestone status-update posts, comments, followers, and reminder notifications;
- project timeline and workspace milestone timeline;
- promotion from milestone to project;
- Mattermost milestone commands;
- manual metric progress for strategic outcomes.

## Domain Model

### Enums

    enum MilestoneKind {
      FEATURE
      PHASE
      OTHER
    }

    enum MilestoneStatus {
      PLANNED
      ACTIVE
      COMPLETED
      CANCELED
    }

    enum MilestoneHealth {
      ON_TRACK
      AT_RISK
      OFF_TRACK
    }

### Milestone

    model Milestone {
      id          String           @id @default(uuid()) @db.Uuid
      workspaceId String           @db.Uuid
      projectId   String           @db.Uuid
      ownerId     String?          @db.Uuid
      name        String
      description String?
      kind        MilestoneKind
      status      MilestoneStatus  @default(PLANNED)
      health      MilestoneHealth?
      startsOn    DateTime?        @db.Date
      targetOn    DateTime?        @db.Date
      position    Int              @default(1024)
      version     Int              @default(1)
      completedAt DateTime?
      canceledAt  DateTime?
      archivedAt  DateTime?
      createdAt   DateTime         @default(now())
      updatedAt   DateTime         @updatedAt
    }

Relations:

- Workspace has many milestones.
- Project has many milestones, with cascade on project deletion.
- User has owned milestones, with the foreign key set to null if the User record is deleted. Workspace-membership removal performs an explicit workspace-scoped owner cleanup because it does not delete the User.
- Milestone has many tasks.
- Task receives nullable milestoneId and a Milestone relation with set-null as a database safety fallback. V1 exposes no direct milestone-delete service or UI.

Indexes:

- Milestone on projectId, position.
- Milestone on workspaceId, archivedAt, status, targetOn.
- Milestone on ownerId, status.
- Task on milestoneId, status.

Do not hard-enforce unique milestone names. Duplicate phase names can be valid across time, and the UUID is the stable identity. The UI may warn about an exact duplicate inside the same project.

Do not allow changing projectId through ordinary milestone edit. A later explicit move workflow can validate and migrate scope safely.

### Date Contract

Milestone start and target are date-only values, not task-style timestamps:

- store them as PostgreSQL date fields;
- send them through the API as YYYY-MM-DD;
- render and edit them as Jalali dates in the web app;
- avoid timezone conversion that moves a target to the previous or next day.

completedAt, canceledAt, archivedAt, createdAt, and updatedAt remain UTC timestamps.

### Progress Contract

Progress is derived and returned by the server:

    eligibleTasks = all assigned tasks except CANCELED
    completedTasks = eligible tasks with status DONE
    percent = completedTasks / eligibleTasks * 100

Return:

- total task count;
- eligible task count;
- completed task count;
- canceled task count;
- blocked task count;
- overdue task count;
- total and completed task weight as secondary context;
- percentage, or null when there are no eligible tasks.

Rules:

- Canceled tasks are excluded from the denominator but remain visible as a separate count.
- No eligible tasks renders “No tasks,” not a misleading 0%.
- Task count is the primary progress measure because Linear, GitHub, and GitLab use this predictable formula.
- Task weight is supporting context, not a second competing headline.
- Progress is never stored in the Milestone row.
- Progress reaching 100% creates a “Ready to complete” suggestion.
- Progress does not change Milestone.status automatically.

### Lifecycle Contract

The default state is Planned. The default hub segment is Open, which contains both Planned and Active milestones, so a newly created milestone does not disappear from the current view.

Allowed transitions:

| Current state | Allowed action | Result |
| --- | --- | --- |
| Planned | Activate | Active; clear completedAt and canceledAt |
| Planned | Complete | Completed; set completedAt; clear canceledAt |
| Planned | Cancel | Canceled; set canceledAt; clear completedAt |
| Active | Complete | Completed; set completedAt; clear canceledAt |
| Active | Cancel | Canceled; set canceledAt; clear completedAt |
| Completed | Reopen | Active; clear completedAt and canceledAt |
| Canceled | Reactivate | Active; clear canceledAt and completedAt |

Archive is orthogonal to lifecycle:

- normal UI allows archive only for Completed or Canceled milestones;
- archive sets archivedAt and preserves status and terminal timestamps;
- restore clears archivedAt and preserves the previous status;
- a restored terminal milestone must be reopened/reactivated before accepting new tasks;
- archived milestones are read-only except for restore;
- v1 exposes no permanent-delete workflow.

Metadata may be corrected on non-archived terminal milestones, but new task assignment remains limited to Planned and Active.

### Health and Attention

Health is a lightweight manual judgment:

- On track;
- At risk;
- Off track;
- unset.

Attention reasons are derived separately:

- target date passed while non-terminal;
- blocked tasks exist;
- overdue tasks exist;
- owner missing;
- target date missing.

The UI must never treat a derived warning as the user’s manual health judgment.

### Task Invariants

- A new assignment accepts only a planned or active milestone.
- The milestone must be in the same workspace and project as the task.
- Archived, completed, or canceled milestones remain visible on already-linked tasks but are not offered for new assignment.
- Changing a task’s project clears its old milestone unless the request atomically supplies a valid milestone in the target project.
- A server-induced clear must appear in activity and sync changedFields.
- The UI warns before a project change that clears a milestone and offers Undo when possible.

## Information Architecture and UX

### Main Sidebar

Add Milestones as a primary item:

- Route: /:orgId/milestones
- Detail route: /:orgId/milestones/:milestoneId
- Active matching uses the route prefix so list and detail stay highlighted.
- The item is always rendered directly, outside the collapsible Teams section.
- Do not display total milestone inventory as a badge.
- If a badge is used, show only actionable owned/overdue milestones with an accessible label.

Update the current minimal navigation contract:

- render Milestones as a direct primary SidebarMenuItem;
- place it after the manager/member primary destination and before Teams;
- keep it visible whether Teams is collapsed or expanded;
- use prefix-based active matching for list and detail routes;
- verify both manager and member navigation;
- if sidebar customization is introduced before this feature ships, keep Milestones visible by default.

Optional later behavior:

- “Pin to sidebar” on a milestone;
- show at most five pinned/recent milestones below the primary item;
- persist pins per user and workspace, not only in local storage.

### Milestones Hub

Default view: Open.

Segments:

- Open, containing Planned and Active;
- Active;
- Planned;
- Completed;
- All;
- Archived through an explicit secondary filter.

Filters:

- project;
- team;
- owner;
- type;
- lifecycle state;
- health;
- target date;
- overdue;
- search.

Default ordering:

1. overdue;
2. off track;
3. at risk;
4. target date ascending;
5. manual project position;
6. updated time.

Each row shows:

- diamond milestone glyph;
- name and Feature/Phase/Other chip;
- project and team breadcrumb;
- owner avatar;
- lifecycle label;
- health text/icon;
- progress bar, percent, and completed/eligible count;
- target date or a visible “No target” state;
- blocker or overdue reason when applicable.

Use a dense calm list, not a dashboard of oversized cards. Preserve the current list while refreshing and use row skeletons only on first load.

### List and Detail Behavior

Desktop:

- stable milestone list on one side;
- selected milestone detail in the main pane;
- compact property rail at wide breakpoints;
- URL changes on selection so deep links and back/forward work.

Tablet and mobile:

- list becomes a full-width view;
- detail opens as a full page or sheet with a clear back action;
- the create flow uses the same fields and validation;
- no horizontal dependence on drag/drop.

### Quick Create

Required:

- name;
- project;
- type.

Visible optional fields:

- owner, defaulting to project lead when present, otherwise the creator;
- target date;
- a compact Planned/Active state control, defaulting to Planned.

Progressive disclosure:

- description;
- start date;
- health.

Context defaults:

- from a project: prefill the project;
- from a task: prefill the task’s project, create the milestone, then assign that task;
- from the global hub: remember the last project only within the current session.

After success:

- insert optimistically;
- select and open the new milestone;
- announce success;
- preserve entered data and show Retry if saving fails.

### Milestone Detail

Overview:

- editable name, type, status, health, owner, start, and target;
- rich description using the existing DescriptionEditor;
- progress summary with exact counts;
- attention reasons;
- latest activity;
- project link.

Work:

- tasks grouped by status;
- “Create task” with project and milestone prefilled;
- “Add existing tasks” limited to the same project;
- filter and search;
- remove or move task through an accessible menu;
- explicit “No tasks” guidance.

Activity:

- creation and metadata changes;
- ownership and health changes;
- task scope changes as a batched summary;
- lifecycle transitions;
- archive and restore.

Status-update posts, comments, followers, and notification delivery can extend this activity surface after v1.

### Task Integration

Add Milestone to:

- the task detail property rail;
- the global task composer after Project;
- task list/card display properties;
- task context menus;
- task filters;
- saved view state;
- grouping and subgrouping;
- command search;
- create-task-from-milestone context.

Selector rules:

- milestone options change with the chosen project;
- terminal or archived milestones are hidden except for the current linked value;
- “Create milestone…” is available inline;
- changing project clearly communicates any milestone reset.

Task views:

- add milestoneIds to TaskaraTaskViewState and its Zod schema;
- add milestone to grouping and subgrouping enums;
- render an explicit “No milestone” group;
- complete the already-declared milestone display property;
- make old saved views parse with milestoneIds defaulting to an empty array.

### Completion and Cancellation

Completing a milestone with no unfinished work is a simple confirmation.

When unfinished tasks remain, require one explicit policy:

- Keep tasks assigned;
- Move tasks to another active milestone in the same project;
- Return tasks to no milestone.

The dialog shows:

- current progress;
- unfinished and blocked counts;
- the exact effect of each choice;
- an optional completion note.

Rules:

- no default policy is silently selected when unfinished work exists;
- task status is never changed by milestone completion;
- completion emits one milestone-level activity event; future notification delivery sends one batched notification, not one per moved task;
- reopening a Completed milestone returns it to Active and clears completedAt;
- reactivating a Canceled milestone returns it to Active and clears canceledAt;
- cancellation uses the same unfinished-work handling;
- archive is available only after completion/cancellation and retains task links and history.

### Empty, Loading, Error, and Permission States

First milestone:

- Explain: “Use a milestone for a feature or implementation phase; use tasks for actions.”
- Offer “Create feature milestone” and “Create phase milestone.”

No tasks:

- Offer to create a task or add existing project tasks.

No filtered results:

- Show active filters and one “Clear filters” action.

No project access:

- Explain that the milestone follows project visibility.
- Do not reveal inaccessible project or milestone metadata.

Save failure:

- Keep the user’s input;
- roll back only the optimistic server state;
- show Retry;
- avoid clearing the selected detail.

Invalid dates:

- Inline validation when targetOn precedes startsOn;
- retain both values for correction.

Offline:

- show cached content;
- make pending state visible;
- queue supported mutations;
- disable unsupported destructive workflows with a clear explanation.

### Accessibility and Visual Quality

- RTL is the default and must be verified with long Persian names.
- Dates display in Jalali while preserving date-only API values.
- Milestone state, health, and attention use text/icon/shape, not color alone.
- Progress includes exact text and progressbar semantics with aria-valuemin, aria-valuemax, and aria-valuenow.
- All drag operations have menu, button, or click/tap alternatives.
- All actions work by keyboard with logical focus order and focus return.
- Dialogs trap focus and return it to their invoker.
- Interactive targets meet at least 24 by 24 CSS pixels; primary row actions should target 36 to 44 pixels.
- Skeletons preserve spatial layout.
- Background refresh never clears usable content.
- New UI should prefer Taskara theme tokens over new hardcoded dark-only values.

## API Contract

### Milestone Routes

    GET    /milestones
    POST   /milestones
    GET    /milestones/:id
    PATCH  /milestones/:id
    POST   /milestones/:id/reorder
    POST   /milestones/:id/activate
    POST   /milestones/:id/complete
    POST   /milestones/:id/reopen
    POST   /milestones/:id/cancel
    POST   /milestones/:id/archive
    POST   /milestones/:id/restore

List filters:

- projectId;
- teamId;
- ownerId;
- kind;
- status;
- health;
- overdue;
- q;
- includeArchived;
- limit and offset.

Task routes:

- add milestoneId to GET /tasks and GET /tasks/archive;
- add milestoneId to task create and update schemas;
- later add a transactional bulk-assignment endpoint.

### Create

    {
      "projectId": "uuid",
      "name": "Public beta",
      "kind": "PHASE",
      "ownerId": "uuid-or-null",
      "description": "serialized editor value",
      "health": null,
      "startsOn": "2026-07-15",
      "targetOn": "2026-08-15"
    }

### Update

Metadata patch includes a required base version or equivalent optimistic-concurrency guard:

    {
      "version": 3,
      "name": "Public beta",
      "ownerId": "uuid-or-null",
      "health": "AT_RISK",
      "targetOn": "2026-08-22"
    }

Ordinary update cannot change projectId.

### Complete

    {
      "unfinishedTaskPolicy": "KEEP | UNASSIGN | MOVE",
      "targetMilestoneId": "required-only-for-MOVE",
      "note": "optional completion note"
    }

The policy may be omitted only when no unfinished tasks remain.

### List Response Shape

Each item includes:

- milestone metadata;
- parent project and team access context;
- owner;
- computed progress;
- derived attention reasons;
- current version;
- task count summary.

Compute summaries with one milestone query and grouped task-status queries, not an N+1 query per row.

### Permission Matrix

| Action | Permission |
| --- | --- |
| Read | Same as reading the parent project |
| Assign or unassign a task | Existing task-mutation permission plus same-project validation |
| Create, edit, reorder, complete, cancel, archive, restore | Workspace owner/admin, project lead, Project LEAD/MEMBER, or a writable member of the project’s team |

ProjectRole exists but Taskara currently treats project memberships alike for access, and task creation also permits members of the project’s team. Introduce one centralized assertCanManageProjectPlanning helper that preserves normal team-member planning while making Project VIEWER and guest-style access read-only. Do not require explicit ProjectMember rows until Taskara has a complete project-membership management workflow.

Permission precedence:

1. Workspace OWNER or ADMIN can manage milestones.
2. The project lead can manage milestones.
3. Explicit ProjectMember LEAD or MEMBER can manage; explicit VIEWER is read-only and overrides a writable team membership.
4. Without an explicit project membership, TeamMember OWNER, ADMIN, or MEMBER can manage the team project.
5. TeamMember GUEST or AGENT is read-only for milestone planning. An agent needs an explicit ProjectMember LEAD/MEMBER grant to mutate milestones.
6. A project with no team can be managed only by workspace OWNER/ADMIN, its lead, or explicit ProjectMember LEAD/MEMBER.

A milestone owner must be a current workspace member who can read the parent project. Ownership never grants project access. When workspace membership is removed, the existing membership-removal transaction must clear ownerId on that workspace’s milestones, append audit/sync events for the affected milestones, and refresh clients.

Return 404 for inaccessible resources where Taskara already uses that behavior, preventing existence leaks.

## Backend Architecture

Add:

- apps/api/src/services/milestones.ts;
- apps/api/src/routes/milestones.ts;
- focused API and service tests.

Update:

- packages/db/prisma/schema.prisma;
- packages/shared/src/index.ts;
- apps/api/src/app.ts;
- apps/api/src/services/team-access.ts;
- apps/api/src/services/tasks.ts;
- apps/api/src/routes/tasks.ts;
- apps/api/src/routes/sync.ts;
- apps/api/src/routes/users.ts for owner cleanup on membership removal;
- README.md API documentation.

Milestone service responsibilities:

- access and planning-permission checks;
- date and project invariants;
- stable position allocation and rebalance;
- aggregate progress query;
- create/update/lifecycle transactions;
- unfinished-task disposition;
- audit snapshots;
- sync-event creation;
- serialization with project access context.

Use spaced integer positions such as 1024, 2048, and 3072. Insert between neighbors when a gap exists and transactionally renumber one project when gaps close.

## Sync and Local-First Architecture

### Bootstrap

Add accessible milestone summaries to /sync/bootstrap:

- all non-archived planned and active milestones;
- completed/canceled milestones inside a bounded recent window;
- archived history remains on-demand through /milestones.

Milestone progress must come from the server, never from the hot task cache.

### Events

Add milestone event visibility based on the parent project:

- event payloads include project id, team id, and lead id;
- non-admin users receive events only for projects they can read;
- create/update/reorder/activate/complete/reopen/cancel/archive/restore map to milestone upsert or removal events.

Whenever task creation, task deletion, status change, milestone assignment, or project move affects milestone progress:

- refresh the old and new milestone summaries;
- emit milestone progress events in the same transaction where possible;
- do not rely on the milestone page observing only hot task events.

### Client Store

Add milestones to:

- BootstrapResponse;
- TaskSyncResources;
- cached scope snapshots;
- TaskSyncController;
- WorkspaceDataState;
- command-search selectors;
- sidebar attention selectors.

The current generic workspace reducer recognizes manager entities, not resource arrays. Add a resource-event reducer for milestones instead of treating them as page-local state.

Cache compatibility:

- introduce a v2 snapshot schema/key, or normalize missing milestones to an empty array;
- migrate IndexedDB data safely;
- never crash on a v1 snapshot;
- test resetRequired and stale-cursor recovery.

### Mutations

Add persisted mutation names:

- milestone.create;
- milestone.update;
- milestone.reorder;
- milestone.activate;
- milestone.complete;
- milestone.reopen;
- milestone.cancel;
- milestone.archive;
- milestone.restore.

Task assignment continues through task.update with milestoneId.

Optimistic rules:

- create inserts a clearly pending local milestone;
- update preserves the last confirmed snapshot for rollback;
- lifecycle operations update the row immediately but keep the confirmation dialog result recoverable;
- conflicts retain the user’s draft and explain whether the milestone changed remotely.

## Implementation Phases

### Phase 0: Lock Semantics and UX Contract

Implementation:

1. Confirm the hierarchy, one-milestone-per-task rule, kinds, lifecycle, health, progress formula, permissions, archive behavior, and completion policies.
2. Produce low-fidelity desktop and mobile interaction prototypes for:
   - global hub;
   - quick create;
   - milestone detail;
   - task selector;
   - completion with unfinished work.
3. Validate Persian labels:
   - Milestones;
   - Feature;
   - Implementation phase;
   - Planned, Active, Completed, Canceled;
   - On track, At risk, Off track.
4. Define analytics events and performance budgets before implementation.

Acceptance:

- Product, API, and UI use one vocabulary.
- No unresolved ambiguity remains between Project, Milestone, Task, and Cycle.
- The sidebar contract guarantees Milestones is visible.

### Phase 1: Additive Database and API Foundation

Implementation:

1. Add milestone enums, model, relations, and indexes.
2. Add nullable Task.milestoneId.
3. Create an additive Prisma migration and regenerate the local client.
4. Add shared create, update, list, lifecycle, and task relation schemas.
5. Add milestone service and routes.
6. Add server-derived progress and attention summaries.
7. Add centralized planning permission checks.
8. Validate that owners are current members who can read the project, and clear ownership transactionally on workspace-membership removal.
9. Add audit and sync events for milestone metadata and lifecycle.

Acceptance:

- Existing tasks remain valid with milestoneId null.
- Cycles remain unchanged.
- Cross-workspace/project assignment is rejected.
- No list endpoint performs N+1 aggregate queries.
- Date-only values round-trip without timezone movement.
- Zero-task and canceled-task progress are correct.

### Phase 2: Client Resource Foundation, Primary Navigation, and Milestones Hub

Implementation:

1. Add milestones to bootstrap, client resources, cached snapshots, controller output, workspace selectors, and a dedicated resource-event reducer.
2. Normalize v1 caches that have no milestone collection before any milestone UI consumes the store.
3. Add list and detail routes plus page metadata.
4. Add a guaranteed-visible primary sidebar item between the role-aware home destination and Teams.
5. Extend project API counts and apps/web/components/taskara/projects-view.tsx with:
   - milestone count;
   - “View milestones” opening the hub with projectId prefiltered;
   - “New milestone” opening quick create with that project prefilled.
6. Build the list/detail hub with Open, Active, Planned, Completed, All, and archive filtering.
7. Build quick create and inline metadata editing.
8. Add command actions for Go to Milestones and Create Milestone.
9. Add milestone entity search with deep links.
10. Add Persian copy, RTL layouts, Jalali date-only controls, skeletons, and error states.

Acceptance:

- A first-time user can create a feature or phase milestone in under 30 seconds.
- A returning user reaches any active milestone in at most two interactions.
- A project row opens a correctly filtered hub or a project-prefilled create flow.
- List selection has a stable deep link and browser history.
- Collapsed and expanded primary navigation both keep Milestones visible.
- Background refresh preserves list and detail content.
- Bootstrap, pull, cache restore, and resource events produce the same milestone collection.

### Phase 3: Task-to-Milestone Workflow

Implementation:

1. Add milestoneId to task create/update/list/archive contracts and serializers.
2. Enforce same-project and selectable-state rules.
3. Clear an old milestone atomically on project change when needed.
4. Emit refreshed progress events for every old/new milestone affected by task create, update, delete, status, assignment, or project changes.
5. Add reusable MilestoneSelector.
6. Add assignment to task detail, composer, context menu, and milestone detail.
7. Add create-task-with-milestone prefill.
8. Add milestoneIds to saved task views.
9. Add filter, group, subgroup, “No milestone,” and display-property rendering.
10. Include milestone context in command search.

Acceptance:

- Tasks can be assigned, moved, and unassigned from every primary task workflow.
- Changing project cannot leave an invalid milestone link.
- Old saved views continue to parse.
- Grouping and filtering work with null milestone values.
- Progress changes after task status or assignment changes.

### Phase 4: Lifecycle and Local-First Mutation Quality

Implementation:

1. Add activate/reactivate, complete, reopen, cancel, archive, and restore workflows with the defined transition graph and timestamp rules.
2. Add explicit unfinished-task handling.
3. Add persisted/optimistic milestone create, metadata, reorder, and lifecycle mutations.
4. Add rollback, conflict, and offline handling.
5. Add overdue-owned milestone attention to the sidebar without an extra N+1 fetch.

Acceptance:

- 100% progress never auto-completes.
- Completing with unfinished work cannot happen without an explicit policy.
- A task move refreshes both affected milestone summaries.
- Restricted project milestone events never leak through sync.
- Reconnect and resetRequired recover without duplicate or stale milestones.
- V1 client caches remain safe.

### Phase 5: Premium Collaboration and Planning Follow-Ups

Implementation candidates:

1. Milestone updates with health, summary, author, timestamp, and progress snapshot.
2. Followers and batched notifications for ownership, health, target, updates, completion, and cancellation.
3. Due-soon and overdue reminders.
4. Bulk assignment.
5. Project and workspace timelines.
6. Pin up to five milestones beneath the global sidebar item.
7. Promote milestone to project.
8. Codex plugin tools:
   - list_milestones;
   - create_milestone;
   - update_milestone;
   - assign_task_to_milestone;
   - summarize_milestone.
9. Mattermost commands after the web/API contract is stable.

Acceptance:

- Notifications are milestone-level or batched, not one message per task churn.
- Every drag action has an accessible alternative.
- Timeline is additive; the list/detail flow remains complete without it.
- Agent tools obey the same access and lifecycle invariants as the web app.

### Phase 6: Hardening and Rollout

Implementation:

1. Run API, sync, reducer, UI, and E2E suites.
2. Test migration against a copy of an existing database.
3. Verify large workspaces and milestones with hundreds of tasks.
4. Verify RTL, long Persian names, light/dark themes, mobile, keyboard, and reduced motion.
5. Deploy database and API first.
6. Deploy the web UI behind a milestone feature flag.
7. Enable for an internal workspace, observe telemetry, then roll out.
8. Update README and Taskara plugin documentation.

Launch gates:

- no permission leak;
- no stale progress after task mutations;
- no timezone date shift;
- no hidden primary sidebar item;
- no destructive completion default;
- no accessibility-critical keyboard or drag-only blocker;
- no regression to tasks without milestones.

## Verification Matrix

| Layer | Required tests |
| --- | --- |
| Shared schemas | Kind/status/health/date validation; start before target; optional milestoneId; old view defaults |
| Database | Additive migration; nullable relation; indexes; on-delete behavior; Cycles untouched |
| Service | CRUD; order/rebalance; timestamps; version conflict; progress and weight summaries |
| Invariants | Cross-workspace/project rejection; terminal assignment rejection; project move clearing; valid atomic move |
| Permissions | Exact precedence for owner/admin, lead, Project LEAD/MEMBER/VIEWER, team member, guest, agent; owner eligibility and membership-removal cleanup; inaccessible 404 |
| Lifecycle | Planned/active transitions; complete with zero/open work; keep/move/unassign; reopen/reactivate; cancel; archive/restore |
| Sync | Accessible bootstrap; no restricted pull leak; CRUD events; old/new progress refresh; reset recovery |
| Client reducer | Upsert/remove; progress refresh; optimistic rollback; pending replay; old cache without milestones |
| Task UI | Composer/detail/context selector; clear; project reset warning; filter/group/no-milestone/display |
| Navigation | Manager/member variants; collapsed/expanded Teams; list/detail active state; command create/search/deep link |
| Accessibility | Keyboard; focus return; status announcements; progress semantics; drag alternatives; target size |
| E2E | Create phase; add/create tasks; progress; project move; complete/archive/restore; RTL/mobile/offline |
| Performance | No N+1; bounded list; stable selected detail; warm navigation; large milestone task pagination |

## Performance and Quality Targets

- Immediate visual feedback for local interactions, normally under 100 ms.
- Warm cached Milestones navigation should not show a blank loading screen.
- Milestone list API should remain below 250 ms p95 in a representative workspace test with at least 10,000 tasks.
- Detail task lists paginate; never render hundreds of rows at once.
- Progress aggregation uses bounded grouped queries and indexed milestoneId/status fields.
- Reordering updates one project and rebalances only when position gaps are exhausted.
- Search input is debounced and capped.

## Migration and Deployment Order

1. Add enums, Milestone table, nullable Task.milestoneId, foreign keys, and indexes.
2. Do not infer milestones from Cycles, projects, labels, or task titles.
3. Existing tasks remain unassigned.
4. Deploy database migration.
5. Deploy API that accepts and returns optional milestone fields.
6. Deploy sync support.
7. Deploy web UI behind the flag.
8. Enable internally and validate real data.
9. Enable broadly.

Do not add demo milestone rows in the production migration. The repository has no Prisma seed workflow today. Add milestone fixtures to focused API tests, sync tests, E2E mocks, and an optional future dev-only seed.

## Telemetry

Track:

- milestone_created with kind and entry point;
- milestone_task_assigned and milestone_task_unassigned;
- milestone_progress_ready;
- milestone_completed, canceled, reopened, archived, restored;
- completion unfinished-task policy;
- milestone_overdue_viewed;
- milestone_create_failed and milestone_conflict;
- time from create open to successful save;
- time from milestone open to first task assignment.

Do not log names, descriptions, or other milestone content.

Success indicators:

- active projects adopting at least one milestone;
- milestones with an owner and target;
- tasks assigned through milestone context;
- completed milestones whose unfinished scope was handled deliberately;
- falling rate of overdue milestones without owners;
- low rollback/conflict/error rate.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| “Milestone” is confused with a classic zero-duration checkpoint | Explain Taskara’s feature/phase definition in create and empty states |
| Milestones duplicate Projects | Keep them lightweight; no key prefix, hierarchy, team, docs, or project membership |
| Milestones duplicate Cycles | Preserve Cycle as a timebox and allow both relations on a task |
| Progress is wrong from partial client cache | Compute summaries on the server and emit progress refresh events |
| New nav is buried under Teams or role-specific navigation | Render it as a direct top-level item and test manager/member plus collapsed/expanded Teams states |
| Target dates shift by timezone | Use date-only DB/API contracts |
| Task project changes leave invalid links | Clear or replace milestone atomically and record the induced change |
| Completion strands unfinished tasks | Require keep/move/unassign choice |
| Sidebar becomes unscannable | Use one global entry; cap future pins |
| Permissions leak project data | Scope every query/event through parent project access |
| Drag workflows exclude users | Supply click/tap menus and keyboard actions |
| Progress and status disagree | Treat the disagreement as visible information, not an automatic state transition |
| Large scopes become slow | Grouped aggregates, indexes, filters, pagination, and performance tests |

## V1 Non-Goals

- Cross-project milestones.
- Multiple milestones on one task.
- Nested milestones.
- Milestone dependencies.
- Replacing Cycles.
- Automatic milestone completion.
- Manual number/currency metrics.
- Company OKRs or strategic goal trees.
- Approval gates and deployment integrations.
- Public release portals.
- Permanent milestone deletion.
- Automatically listing every milestone in the main sidebar.

## Recommended Pull Request Sequence

1. Schema, migration, shared contracts, progress service, and API tests.
2. Task relation, invariants, serializers, filters, and sync events.
3. Client resource store, cache migration, and reducer tests.
4. Sidebar migration, routes, global hub, and quick create.
5. Milestone detail and task assignment workflows.
6. Task view filter/group/display integration.
7. Lifecycle completion/cancel/archive flows.
8. Command search, Codex tools, accessibility, E2E, performance, and rollout documentation.

Each pull request should be independently testable, keep the database migration additive, and avoid exposing the sidebar item until the end-to-end create/view/assign/progress flow is complete.

## Implementation Evidence — 2026-07-11

The premium V1 implementation described above is present in the current worktree.

- Database and contracts: additive milestone enums/model/indexes/migration, nullable task relation, date-only schemas, lifecycle/reorder/list contracts, saved-view compatibility, and unchanged Cycle semantics.
- API and invariants: project-scoped CRUD, permissions, owner eligibility/cleanup, derived progress/attention, stable ordering/rebalance, explicit unfinished-work disposition, archive/restore, task relation validation, exact pagination, audit history, and plugin tools.
- Concurrency hardening: workspace-sequence serialization prevents stale full-summary events; milestone row locks serialize assignment/status/review/triage changes with completion disposition; unfinished task rows are locked during disposition; concurrent create/reorder position allocation is serialized.
- Sync and local first: scoped bootstrap/pull events, viewer-specific capabilities, archive tombstones, auth-identity cache isolation, v1 cache normalization, persisted optimistic milestone mutations, dependency ordering, offline replay, rollback, and conflict draft retention with retry.
- Premium web workflow: guaranteed primary sidebar destination, URL-backed hub filters and deep links, responsive list/detail, quick create, inline metadata, Jalali date controls, progress/attention, task creation/assignment/removal, lifecycle dialogs, task composer/detail/context/filter/group/display integration, project entry points, and command search.
- Accessibility and visual quality: RTL, light/dark theme tokens, progressbar semantics, named mobile controls, keyboard navigation, focus-managed dialogs, non-drag reorder controls, responsive full-page mobile detail, and no horizontal overflow in browser checks.

Launch-gate evidence:

| Gate | Evidence |
| --- | --- |
| No permission leak | Exact role-precedence API tests, inaccessible-project tests, scoped bootstrap/pull tests, per-viewer `canManage` mapping, and archived tombstones pass. |
| No stale progress | Same-transaction old/new progress events and a deterministic concurrent sequence-order regression pass. |
| No timezone shift | Real/leap date schema tests and API date-only round-trip tests pass. |
| Primary navigation stays visible | Desktop/mobile browser tests cover the primary hub, detail deep links, and manager/member navigation. |
| No destructive completion default | API and browser tests require an explicit KEEP/MOVE/UNASSIGN choice when unfinished work exists. |
| No accessibility-critical blocker | Keyboard selection, named controls, progress semantics, non-drag reordering, light/dark, RTL, mobile, and overflow checks pass. |
| Tasks without milestones remain valid | Additive migration, nullable relation, old saved-view defaults, and complete API regression suite pass. |

Verification performed against the final implementation:

- `bun run test:api`: 121 tests passed, 489 assertions.
- Web unit suites: 43 tests passed, 120 assertions.
- Milestone/shared focused suites: 20 tests passed, 71 assertions.
- `bun run typecheck`: all workspaces passed.
- `bun run --filter @taskara/web build`: production build passed; only the existing large-chunk advisory remains.
- `bun run --filter @taskara/web test:e2e`: 55 passed across desktop/mobile, 3 intentionally skipped manager-only mobile cases.
- Fresh PostgreSQL database: all 18 migrations applied successfully, including `20260711120000_milestones`.
- 10,000-task benchmark: milestone list p95 6.10 ms and 100-task page p95 11.71 ms against the 250 ms budget.
- `git diff --check`: passed.

Database/API/web deployment, staged feature enablement, and production telemetry observation remain operational rollout actions; they are not performed by the local implementation workflow.
