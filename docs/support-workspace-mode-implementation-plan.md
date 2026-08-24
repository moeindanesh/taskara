# Support Workspace Mode — Research and Implementation Plan

> **Status: implemented through Phase 8 (2026-08-23).** The delivered design adds a second
> workspace mode without changing the existing Team workflow. It separates a customer-facing
> Support Case from a Task, then links Cases to Tasks in Team workspaces when delivery work is
> needed. Research-backed target catalogs remain in normative language; the **Delivery boundary**
> is the authoritative account of what shipped and what remains deliberately excluded.

## Outcome

Taskara supports two workspace modes:

| Mode | Purpose | Primary record | Default landing |
|---|---|---|---|
| `TEAM` | The current team-management and delivery workflow | Task | Team Overview |
| `SUPPORT` | Intake, triage, ownership, response, follow-up, and resolution | Support Case | Permission-derived: Triage → Department Inbox → My Cases → setup/no access |

The mode is a server-owned product profile. It determines which domain capabilities can exist;
actor permissions determine which of those capabilities the current user may exercise. Together
they control the domain services, routes, sync bootstrap, global create action, command palette,
default redirect, and sidebar. Mode is neither a set of independent feature booleans nor an
authorization decision by itself.

Existing workspaces are backfilled to `TEAM` and retain their existing behavior.

### Product goal and release guardrails

The product goal is not simply to close more Cases. It is to increase the share of Cases that reach
a customer-verified resolution within the applicable service policy, without an avoidable ownership
bounce, stale follow-up, or reopen. Establish a pilot baseline before setting a numeric target, then
track that outcome alongside first-response attainment, non-fixed/reopen rate, transfer count, and
time from linked Team Task completion to the next customer update.

Hard release guardrails are:

- no Case is dropped or duplicated at intake;
- no peer, report, notification, search result, sync payload, or cross-workspace link leaks the
  existence or content of a Case outside its current audience;
- every actionable Case has a visible owner or queue and a next responsibility;
- Team workspaces retain their existing behavior and performance;
- automation and assistance can recommend, but a human remains accountable for customer-facing
  replies, ownership changes, priority overrides, and resolution in the initial product.

## Implemented recommendation

1. `WorkspaceMode = TEAM | SUPPORT` is stored with `TEAM` as the database and API default.
2. Mode is a workspace type chosen at creation, not a casual toggle on a populated workspace.
   A future conversion must be an explicit migration workflow.
3. The code name is `SupportCase` and the canonical Persian UI noun is «پرونده پشتیبانی». Support
   intake does not use `Task` or the legacy `/issue` route.
4. `Department` is separate from `Team`. A Team owns projects and delivery work; a
   Department owns Support Cases and has a stricter visibility model.
5. Current ownership uses both `departmentId` and an optional department-member assignee.
   Record every transfer in append-only history.
6. Triage, Department Inbox, My Cases, and Needs Attention are derived, access-scoped queries. Do
   not store a queue name or “stale” as mutable Case state.
7. The server enforces the privacy rule: a Department member sees their own assigned Cases,
   not peers' Cases. Department managers are explicit exceptions.
8. A first-class cross-workspace relation links a Support Case to a Team Task. “Create
   subtask” means either create a linked Task, or create a real Task subtask under a selected parent
   Task in the target Team workspace. A Case is never a Task parent.
9. Manual routing, explainable deterministic rules, balanced capacity, skills and audited
   suggestions are delivered in that safety order. Model-driven mutations remain human-decided.
10. Follow-up and SLA clocks use business time, waiting-state transitions and meaningful activity,
    never `updatedAt` alone.

## Domain decisions

### Add vocabulary before code

Before implementation, `CONTEXT.md` said “one team = one workspace” and treated Issue/Ticket only as
avoided Task synonyms. Support mode made that incomplete and made careless use of “issue” ambiguous.
The delivered glossary now defines:

- **Workspace Mode**: `TEAM` or `SUPPORT`; selects one coherent capability profile.
- **Support Case**: a customer's reported incident, request, question, or complaint, including its
  contact history, current owner, next-action responsibility, service clocks, and outcome. It is not
  a Task.
- **Department**: a Support-workspace responsibility group. It owns Cases and may map to one or more
  delivery destinations in Team workspaces. It is not a Team.
- **Triage**: actionable (`NEW | OPEN | WAITING_*`) Cases with no owning Department.
- **Department Inbox**: actionable Cases owned by a Department but not yet assigned to a member.
- **Needs Attention**: an access-scoped projection of Cases whose next action is due, service clock
  is at risk/breached, ownership is stale, resolution is unconfirmed/non-fixed, or Case reopened.
- **Case–Task Link**: an explicit relation between a Support Case and a Task in a Team workspace.

The code name is `SupportCase` and the reviewed UI noun is «پرونده پشتیبانی». It is not a `Task` and
does not reuse `TaskTriageState`.

ADRs 0006–0008 record that:

- a workspace has one operationally immutable mode and capabilities are derived from it;
- a Support Case/Department and a Task/Team are different aggregates connected only by an approved,
  minimized cross-workspace link;
- Support privacy requires assignment-scoped authorization, audience-specific sync/notifications,
  memory-only sensitive browser state in v1, and authenticated expiring media before attachments.

This remains one bounded context: both records use one vocabulary consistently across API, web,
database, and agent surfaces.

### Workspace mode is not a feature-flag matrix

Persist only `Workspace.mode` for product selection. Derive a stable workspace-capability set from
the mode, then derive actor permissions from workspace role, support grants, and Department
memberships:

| Capability group | Team | Support | Common |
|---|---:|---:|---:|
| Tasks, projects, teams, milestones, daily reports, manager OS | yes | no | no |
| Cases, triage, departments, recovery, support reports | no | yes | no |
| Members, authentication, workspace switcher, settings | yes | yes | yes |
| Inbox/notifications, knowledge, search | yes | yes | yes, with mode-specific entity access |
| Announcements/meetings | yes | no | no; Team communications remain Team-only |

The API returns `mode`, workspace capabilities, and actor permissions from `/me`; auth and
workspace-list responses carry `mode` so switching can choose the correct shell. The
web derives routes and navigation from that response; the API independently enforces the same mode
and permission gates. Hiding a menu is never authorization.

### Make workspace mode immutable in v1

“Switch features and menus” should mean selecting the experience for the current workspace, not
flipping the same populated workspace between Team and Support. A populated Team workspace contains
projects, Tasks, Team access, manager metrics, and Task sync assumptions; a Support workspace
contains Departments, Cases, contact history, and stricter access.

For v1:

- choose mode during workspace creation;
- default omitted mode to `TEAM` for compatibility;
- provide no generic `PATCH mode`, even while the workspace appears empty; this avoids a race
  between an emptiness check and the first mode-specific write;
- treat any later conversion as a measured migration with a dry run and explicit mapping.

## Research synthesis

The reviewed service-desk products and platform guidance point to the following patterns. Vendor
capabilities are evidence for each pattern; the Taskara-specific recommendation remains a product
and architecture decision:

1. **One intake record across channels.** Zendesk creates work records for email/web/API, messaging,
   and calls, preserves the original channel, and routes by queue, group, agent availability,
   capacity, priority/SLA risk, and skills. Taskara should preserve `sourceChannel` and unify API and
   call intake as Cases rather than maintain independent call and API queues.
2. **Queues are focused projections.** Jira Service Management describes queues as centralized,
   focused views and usually sorts them by SLA. Its scaling guidance warns against queues that try
   to return too much work. Taskara should compose server-side filters and paginate; it should not
   encode Triage or Needs Attention in Case status.
3. **Department ownership and individual assignment are separate.** Intercom retains team ownership
   when a conversation is assigned to a teammate and can return it to the team inbox when that
   teammate becomes unavailable. Freshdesk supports group-scoped round-robin, load-based, and
   skill-based assignment using availability and capacity. Taskara therefore needs durable
   Department ownership plus an optional member assignee, with the Department Inbox as the safe
   fallback. FIFO or round-robin alone should not be the end state.
4. **Privacy requires explicit restricted groups, but this requirement is stricter.** Zendesk
   private groups keep other groups out. The requested rule also keeps peer members inside one
   Department from browsing one another's Cases, so `department membership = visibility` is too
   broad. Taskara needs assignment-level access plus explicit Department-manager exceptions.
5. **Prioritize breach risk, not just age.** Zendesk can order by oldest eligible time, highest
   priority, or soonest SLA breach. The Support queue should expose all three but default to earliest
   actionable deadline, with priority and intake age as tie-breakers. The delivered queue API
   currently pages by newest receipt; configurable ordering remains a product opportunity.
6. **Response obligations need separate clocks.** Zendesk distinguishes first reply, next reply,
   periodic/pausable customer update, and resolution targets using public customer/agent events;
   Intercom makes waiting/snooze pauses and office-hours schedules configurable. Taskara should
   track first public response, the response to each new customer message, and promised/periodic
   customer updates separately from internal activity. Waiting on a customer may pause only the
   policy-selected clocks; internal waiting, unassignment, or snoozing must not silently stop a
   customer commitment.
7. **Link support and delivery; do not collapse them.** Jira Service Management links an incident
   record to work in another project. The Support Case remains the customer-service source of truth;
   the Team Task remains the delivery source of truth.
8. **Prevent double work and stale replies.** Freshdesk exposes agent collision detection and
   outdated-reply protection. Taskara uses optimistic versions and atomic claims as the correctness
   boundary, plus short-lived, best-effort viewer/editing presence as a collision warning.
9. **Reliable intake is asynchronous and idempotent.** Stripe's webhook guidance explicitly covers
   signature verification, duplicate events, non-guaranteed ordering, async queues, and returning a
   fast `2xx`. Those are transport patterns, not payment-specific behavior, and should govern
   Support API connectors.
10. **Incident, request, and problem are not synonyms.** Atlassian's service-management guidance
    distinguishes an incident (restore disrupted service), a service request, and a problem
    (underlying recurring cause). Start with configurable Case types rather than hard-code every
    intake as an incident.
11. **Operational changes need a complete event history.** Zendesk ticket events include updates
    made by people and business rules and display previous and new field values. Taskara should keep
    an append-only, transactional Case event ledger for assignment, status, SLA, access, automation,
    and cross-workspace handoff changes. Its generic activity feed may project that ledger, but is
    not the operational source of truth.
12. **Duplicate contacts must retain provenance.** Zendesk supports merging multiple tickets about
    the same issue and warns that merges are permanent. Taskara v1 should use a safer canonical
    relation instead of destructive merging: preserve each Case and its timeline, require
    `duplicateOfCaseId` when resolving as `DUPLICATE`, and never expose one requester's messages to
    another merely because their Cases are related.
13. **Knowledge should improve as a by-product of resolving work.** Knowledge-Centered Service
    (KCS) treats searching, reusing, improving, and creating knowledge as part of the support flow,
    rather than a separate documentation campaign. Taskara should suggest access-safe Knowledge
    pages in the Case workspace, let an agent link the article actually used, and create a review
    task when the article was missing or wrong. Measure successful reuse and improvement—not only
    article views or attempted deflection.
14. **Connect expertise without repeatedly transferring ownership.** The Consortium for Service
    Innovation's collaboration guidance favors connecting the current worker to relevant experts
    and reducing handoffs. Taskara's stricter peer-privacy rule means this cannot become ambient
    Department visibility. A later expert-assist flow should keep one accountable Case owner and
    grant a named collaborator the minimum read/comment scope for a purpose and expiry, with audit,
    revocation, audience-safe sync, and no access to the requester's other Cases.
15. **Capacity includes after-contact work.** Intercom reserves a routing slot for a configurable
    wrap-up period after a conversation closes or is reassigned, while leaving the worker otherwise
    available. Taskara should eventually model short, channel-aware after-call/after-contact work as
    routing capacity—not as Case lifecycle and never as a reason to pause a customer SLA. This
    prevents immediate reassignment from crowding out notes, disposition, and callback capture.
16. **Quality programs need reviewer calibration, not only scorecards.** Zendesk QA has reviewers
    score the same conversations, compare their evaluations, and optionally use a baseline review
    so feedback is consistent across reviewers. Taskara's versioned rubrics and reviews are the
    foundation; a mature quality program should add sampled calibration sessions, controlled or
    blinded peer-score visibility, reviewer variance, coaching follow-up, and a dispute/correction
    path without changing the original Case timeline.

### Product opportunities specific to Taskara

- **Persian-first operations:** RTL layouts and Jalali dates in the UI, while all ordering and SLA
  arithmetic stays on UTC instants under an IANA workspace timezone and configurable Iranian or
  Department holiday calendar.
- **Explainable routing:** show why a rule suggested a Department/member (for example language,
  service, skill, capacity, and breach risk), and provide a dry-run simulator before enabling rules.
- **Privacy-preserving dispatch:** ordinary members can work only their assigned Cases; a future
  redacted claim queue may reveal priority/deadline/capacity facts without revealing requester or
  Case content until an atomic claim succeeds.
- **Closed-loop engineering handoff:** Team Task completion prompts the stable Support owner to
  validate the result and update the customer; it never silently closes the Case.
- **Known-issue clustering:** multiple customer Cases can link to one canonical Case or Team Task,
  exposing an access-controlled affected-customer count and recurrence signal without duplicating
  engineering work. A first-class Problem aggregate is a later product decision.
- **Reason-coded recovery:** “Needs Attention” says why a Case is there and the next required action,
  rather than presenting one undifferentiated list of old records.
- **Privacy-safe expert assist:** invite one named expert for a time-boxed consultation while the
  original member stays accountable; do not solve collaboration by widening Department visibility.
- **Contact-center wrap-up:** reserve limited routing capacity after a call or conversation so the
  member can finish notes, disposition and callback commitments without falsifying availability or
  pausing service clocks.
- **Calibrated quality:** treat rubric calibration, coaching and review disputes as quality-system
  work, separate from customer-visible Case history and from peer performance leaderboards.

## Target workflow

~~~mermaid
flowchart LR
  API["API / webhook"] --> Intake["Durable intake receipt"]
  Call["Manual call-center entry"] --> Case
  Manual["Manual entry"] --> Case["Support Case"]
  Intake --> Case
  Case -->|no department| Triage["Workspace Triage"]
  Triage -->|assign department| DeptInbox["Department Inbox"]
  DeptInbox -->|assign member| Mine["Member's My Cases"]
  Mine --> Work["Respond / investigate"]
  Work -->|waiting on customer| Followup["Next-action clock"]
  Work -->|delivery work needed| Link["Case–Task Link"]
  Link --> TeamTask["Task in Team workspace"]
  Followup --> Work
  TeamTask --> Work
  Work --> Resolve["Resolve with outcome"]
  Resolve --> Verify["Verification window"]
  Verify -->|customer replies / not fixed| Work
  Verify -->|confirmed / elapsed policy| Closed["Closed"]
~~~

### Case lifecycle

Keep service lifecycle separate from routing ownership:

| Lifecycle state | Meaning | Required facts |
|---|---|---|
| `NEW` | Newly received and awaiting triage/action | intake source and received time |
| `OPEN` | Actively being handled | current next action is internal/support |
| `WAITING_ON_CUSTOMER` | Customer/requester owes the next action | `nextActionAt`; policy controls SLA pause |
| `WAITING_ON_INTERNAL` | A Department or linked Team is expected to act | `nextActionAt` and waiting reason/link |
| `RESOLVED` | Support supplied an outcome; verification/grace is pending | resolution code, summary, `resolvedAt` |
| `CLOSED` | The verification policy completed the lifecycle | `closedAt` |

Routing is derived independently:

- `UNROUTED`: no Department and no assignee;
- `DEPARTMENT_QUEUE`: Department present and assignee absent;
- `OWNED`: Department and valid Department-member assignee present.

Do not add `UNASSIGNED`, `STALE`, `OVERDUE`, `SLA_BREACHED`, `DUPLICATE`, or `CANCELED` as lifecycle
states. Ownership facts are derived; invalid, withdrawn, spam, duplicate, and non-fixed outcomes are
resolution/disposition codes. These axes can overlap without inventing status combinations.

Use the Support predicate name `nonClosed` for every lifecycle state except `CLOSED`. Do not reuse
the existing Task glossary term “Unfinished,” whose `DONE | CANCELED` semantics are Task-specific.

Important transitions:

- assigning the first Department normally moves `NEW -> OPEN` atomically;
- a triager may request information before routing, moving `NEW -> WAITING_ON_CUSTOMER`; the next
  customer response returns the still-unrouted Case to `NEW`;
- moving Departments clears the individual assignee unless the command explicitly supplies an
  active member of the destination Department;
- inbound customer activity moves `WAITING_ON_CUSTOMER -> OPEN` when routed or back to `NEW` when
  still unrouted, and resumes the relevant clocks;
- inbound customer activity on `RESOLVED` reopens it to `OPEN` and starts a new response cycle;
- resolution requires a structured outcome and does not follow automatically from a linked Task;
- connector customer activity on a `CLOSED` external thread creates a new Case and audit
  cross-reference; it never silently appends to the terminal record. Session-authenticated manual
  interaction/call commands must explicitly reopen the old Case or create a new one;
- every transition and assignment carries `baseVersion`; a stale writer receives `409`.

### Resolution and “not fixed”

The structured resolution codes are:

- `FIXED`
- `ANSWERED`
- `WORKAROUND`
- `DUPLICATE`
- `NO_RESPONSE`
- `NOT_REPRODUCIBLE`
- `REJECTED`
- `WITHDRAWN`
- `SPAM`

Every outcome is recorded on `RESOLVED`; `CLOSED` retains it and adds `closedAt` through a separate
manager/supervisor command that records customer confirmation, asserted policy-window completion or
an administrative override. The delivered product never auto-closes a Case or bypasses the two
lifecycle events; an automatic verification/grace-window evaluator remains future work.

“Needs Attention” includes resolved Cases that are unconfirmed, reopened Cases, and configurable
non-fixed outcomes such as `WORKAROUND` or `NOT_REPRODUCIBLE`. A linked Team Task becoming `DONE`
does not automatically resolve the Case; a support owner verifies the customer outcome.
`DUPLICATE` requires a readable same-workspace canonical Case, but the relation never grants access
to either requester's private timeline.

## Ownership and visibility

### Roles

`WorkspaceRole` remains tenant administration; composable Support authorization carries the
operational meanings:

- `SupportPermissionGrant.role = TRIAGER | SUPERVISOR` for cross-Department duties;
- `DepartmentMember.role = MEMBER | MANAGER` for work and dispatch inside one Department;
- `OWNER`/`ADMIN` imply Support supervisor, but an explicit `SUPERVISOR` does not gain workspace
  billing/member-administration power.

A person may belong to multiple Departments, and the assignee points to the membership in the
owning Department. Triage is an explicit grant, not inferred from all workspace members. `GUEST`
has no Support access. `WorkspaceRole.AGENT` grants no Support access by itself, while a human with
that role may still receive an explicit Department membership or Support grant. A browser-authenticated
`UserKind.AGENT` has no Support access; automation credentials need explicit Support scopes.

### Permission matrix

| Reader | Unassigned Triage | Department Inbox | Own assigned Case | Peer's Case in same Department | Other Department |
|---|---:|---:|---:|---:|---:|
| Workspace owner/admin or Support supervisor | full | full | full | full | full |
| Explicit triager only | full | no | only if separately assigned | no | no |
| Department manager | no unless triager | own Department | full | full in own Department | no |
| Department member | no | no | full | no | no |
| Ordinary workspace member with no grant | no | no | no | no | no |

Command authorization is explicit; readable does not automatically mean mutable:

| Command | Triager | Department manager | Assigned member | Supervisor/admin |
|---|---|---|---|---|
| Create manual Case/call | yes | yes, into own Department | no by default | yes |
| Search contact | minimal intake directory | minimal intake directory; detail through readable Cases | through own Cases | full |
| Accept type/priority assistance or override priority | unrouted Case; override reason | own Department; override reason | own Case; override reason | any |
| Add public interaction/internal note | unrouted Case; recorded channel only | own Department | own Case | any |
| Set next action/request information | unrouted Case | own Department | own Case | any |
| Route to first Department | yes | no unless also triager | no | yes |
| Assign/return to Department queue | no after routing | own Department | return own Case only | any |
| Transfer Department | no after routing | from own Department; reason required | no | any |
| Resolve | reject/spam; duplicate only to another readable unrouted Case | own Department | own Case | any |
| Close/reopen | no | own Department under policy | no manual close | any |
| Link/create/unlink Team work | no while unrouted | readable Case + Team-side write authority | own Case + Team-side write authority | readable Case + Team-side write authority |

There is no generic `PATCH /support/cases/:id`. Ownership, waiting, resolution, close/reopen,
priority decisions, assistance and link state use named commands with optimistic Case versions.
List filters are always intersected with the server-owned access predicate: a peer or out-of-scope
Department identifier returns no extra Case rather than widening the caller's scope. A Support
bulk-export surface is not shipped.

Credential actors are evaluated before human role implications: an agent credential attached to a
User whose workspace membership is `OWNER` still gets only its explicit Support credential scopes,
never implicit supervisor, triage or configuration access.

### One access policy, every read path

`apps/api/src/services/support-access.ts` is the source of Case visibility:

- `resolveSupportAccess(actor)`
- `supportCaseWhereForAccess(access)`
- `canReadSupportCase(access, case)`
- `assertCanTriage`, `assertCanDispatch`, `assertCanWorkCase`
- recipient filtering for Case notifications and task-link projections

Use it for list, detail, search, counts, reports, sync bootstrap/pull, notification hydration,
calls, assistance, cross-workspace links, and any common-activity projection that carries Case
data. Any future attachment or export path must use the same predicate rather than creating a
second privacy model.

Privacy properties:

- unauthorized reads return `404` where existence itself is sensitive;
- counts and aggregations cannot reveal peer Case volume to ordinary members;
- notification rows are re-gated at read time because assignment can remove access after delivery;
- sync sends `removeFromScope` when a transfer removes a reader's access;
- the v1 Support store is memory-only and partitioned by workspace/user; it persists no Case body,
  contact, interaction, or offline mutation in localStorage/IndexedDB, and clears on logout,
  workspace switch, or access-epoch reset;
- no client-side filtering is relied on for privacy;
- server access for the old Department ends in the transfer transaction; an online memory store
  removes it on the audience event, and a reconnect must validate access epoch before stale content
  can render. A later collaborator grant must be explicit, expiring, and audited.

### One atomic ownership command

Route, assign, unassign, return-to-Inbox and cross-Department transfer use one service command,
`routeSupportCase(caseId, targetDepartmentId, targetAssigneeId, reason, baseVersion)`:

1. lock the Case row and reject a stale `baseVersion` with `409` plus the current safe projection;
2. authorize against the Case's current ownership, not the requested destination;
3. validate that the destination Department is active and belongs to the same Support workspace;
4. if present, validate that the assignee is an active member of that exact Department;
5. change Department, assignee, lifecycle/version, ownership clocks, and next action together;
6. append one ownership event and audience-safe Support sync effects in the same transaction.

A cross-Department transfer requires a reason and clears the old assignee unless a valid destination
assignee is supplied. Deactivating a Department membership atomically clears its assignee pointer
from `nonClosed` Cases: actionable Cases return to the Department Inbox, while resolved history stays
out of dispatch. Closed Cases may retain the inactive ownership pointer for reporting. Hard
workspace/member deletion clears current pointers while immutable Case events preserve the
historical actor/owner snapshot. A Department cannot be deactivated while it owns `nonClosed` Cases;
that work must be transferred first.

## Data model

The delivered Prisma models separate these responsibilities.

### Mode and Department structure

- `Workspace.mode WorkspaceMode @default(TEAM)`
- `SupportWorkspaceState`: one row per Support workspace with immutable Case key prefix and
  row-locked `nextCaseNumber`
- `Department`: workspace, name, slug, description, active, default routing settings
- `DepartmentMember`: workspace, Department, User, role, active, routing capacity/availability and skills
- `SupportPermissionGrant`: workspace, User, `TRIAGER | SUPERVISOR`
- `SupportCredentialGrant`: explicit Support scopes bound to one `AgentCredential`, never inferred
  from the credential User's workspace role
- `SupportAccessEpoch`: workspace, User, monotonically increasing authorization version
- `SupportIntakeConnector`: workspace/source-scoped intake identity and credential policy
- `WorkspaceConnection`: dual-approved Support-workspace to Team-workspace relationship
- `DepartmentWorkTarget`: Department to allowlisted Team project destination

`workspaceId` is carried through Department membership with composite uniqueness/foreign keys so a
Department member must also be a member of that workspace. Model the Case assignee so the database
can enforce `(workspaceId, departmentId, assigneeId)` against an actual Department membership; the
application also checks that the membership is active. A `CHECK` requires an assignee to imply a
Department.

Bind `SupportPermissionGrant` through `(workspaceId, userId) -> WorkspaceMember`, with cascade on
membership removal, so leaving and later rejoining cannot resurrect an old supervisor/triager
grant. Bind credential grants to a non-revoked `AgentCredential` in the same workspace and check
revocation on every request.

Do not reuse `Team` or `TeamMember`. Their present meaning is project/task access and Team delivery,
which would make the peer-privacy rule impossible to state cleanly.

### Core Case

`SupportCase` carries:

- identity: workspace-scoped key/sequence;
- title and initial description;
- original source channel (`API`, `CALL`, `MANUAL`, `EMAIL`, `MESSAGING`) even when later
  interactions use another channel;
- configurable Case type;
- priority, impact, and urgency where useful;
- lifecycle status, plus a structured waiting reason when `WAITING_ON_INTERNAL`; do not duplicate the
  lifecycle enum with a second mutable “waiting party” field;
- current Department and optional assignee membership;
- requester/contact;
- optional same-workspace `duplicateOfCaseId`; relating duplicates never merges timelines or access;
- `receivedAt`, `firstResponseAt`, `lastCustomerActivityAt`, `lastHumanResponseAt`,
  `lastMeaningfulActivityAt`, `nextActionAt`, and optional `snoozedUntil`;
- resolution code/summary and resolution/close/reopen timestamps;
- `nextSlaDueAt` as a query accelerator, not the only SLA history;
- optimistic `version` and normal timestamps.

Keep `SupportContact` and `SupportExternalRef` separate: contact fields have privacy/retention needs,
while a unique `(connectorId, externalCaseId)` identifies the source thread without turning
email/phone into identifiers. Avoid copying customer PII into immutable events or Team Tasks.

Use `lastMeaningfulActivityAt` for stale detection. System sync, a label edit, or an automated
classification update must not make an abandoned Case look recently followed up.

Allocate keys through a row lock on `SupportWorkspaceState`, independent of
`Project.nextTaskNumber`/Task key reservation. Connector idempotency is checked before reserving a
number where possible; concurrent manual/connector creates still produce unique monotonic keys, and
a retry returns the original key rather than consuming a second Case.

### Timeline, audit, and delivery

- `SupportInteraction`: immutable inbound/outbound/internal envelope; kind
  (`MESSAGE | CALL | NOTE`), visibility (`PUBLIC | INTERNAL`), channel, direction, author/contact,
  external id, source `occurredAt`, trusted `receivedAt`, and content hash/reference
- `SupportInteractionContent`: encrypted body separated from its envelope, with retention and
  redaction metadata so a future authorized erasure path can tombstone content without destroying
  provenance; no redaction command, job, or UI is shipped
- `SupportCallDetail`: one-to-one call metadata where applicable—direction, start/end/duration,
  answered/missed/abandoned/voicemail disposition, consent flags, callback owner/due time, and
  external call id
- `SupportCaseEvent`: append-only operational/security event with per-Case sequence, actor
  provenance, correlation/idempotency id, action, non-sensitive before/after delta, reason, and time
- existing `ActivityLog`: limited access-filtered security/setup and handoff projections, not a
  general Case timeline or the authoritative Support audit ledger
- `SupportIntakeReceipt`: `connectorId`, external event/idempotency key, payload hash/private
  reference, processing state, attempt count, `nextAttemptAt`, lease owner/expiry, Case id, last
  error code, dead-letter state, and received/processed timestamps
- `SupportOutboxEvent`: durable delivery records for processed-intake and intake-security topics;
  the current outbox does not deliver recovery or general Case notifications

The customer-facing/investigation timeline and the security audit are related but not interchangeable.
Case mutations commit the current snapshot, `SupportCaseEvent`, relevant SLA changes, and sync
events together; connector processing also commits its receipt and outbox record together. Do not
depend on generic JSON audit rows for operational SLA math, and do not put conversation bodies or
PII into an append-only audit payload.

### SLA

- `SupportBusinessCalendar`: IANA timezone, work periods, holidays
- `SupportSlaPolicy`: ordered conditions, targets, pause rules, version/effective dates
- `SupportCaseSlaClock`: Case, metric/cycle, frozen policy version, state,
  started/due/paused/met/breached times, and accumulated paused duration

Initial clock metrics:

- triage/time to first Department ownership;
- first response;
- next human response;
- resolution;
- follow-up/next promised action;
- optionally, time waiting for a Department member after routing.

Only a public human response fulfills first/next-response clocks. Assignment, an internal note, or a
bot acknowledgement does not. Waiting on the customer may pause selected clocks under the frozen
policy version; waiting internally, being unassigned, or snoozing does not pause anything unless the
policy says so explicitly. Transfer never resets a Case-level SLA.

Compute deadlines on the server in UTC using the business calendar. Render dates in Jalali/Persian
in the web. Clients do not perform SLA arithmetic.

### Cross-workspace delivery

`SupportCaseTaskLink` is many-to-many so several customer Cases can share one engineering/root
problem Task and one Case can require several delivery Tasks. It includes:

- active `WorkspaceConnection` and allowlisted `DepartmentWorkTarget`;
- Support workspace and Case;
- Team workspace and Task;
- relation type (`FIX_WORK`, `INVESTIGATION`, `FOLLOW_UP`, `RELATED`);
- safe handoff summary/snapshot;
- creator and timestamps.

Keep immutable sanitized Task key/title/status snapshots and allow `taskId` to become null on hard
Task deletion. The Task deletion transaction appends a `LINKED_TASK_DELETED` Support event, freezes
the tombstone, and creates a follow-up Attention item for the current Case owner; it never cascades
deletion to the link or Case.

Database and service invariants:

- source workspace must be `SUPPORT` and destination workspace `TEAM`;
- the connection is approved by an owner/admin of both workspaces, can be revoked, and explicitly
  allowlists target projects and create/link capabilities per Department;
- the Case and Task must match the workspace ids on the link;
- link-existing requires Support Case work/dispatch authority, independent Task read authority, an
  active allowlisted connection target, and Team-side `LINK_SUPPORT_CASE` authority because adding
  the visible relation mutates the Team workspace;
- create-linked v1 requires the initiating human to have Case work/dispatch authority and explicit
  Task-create authority in the allowlisted target project; ordinary Team membership or
  `ProjectRole.VIEWER` is not sufficient;
- the relation grants no full aggregate access, but intentionally publishes only the dual-approved,
  versioned cross-workspace projection described below;
- every link/create writes audit and sync events in both workspaces;
- task title/body receives an explicit handoff brief, never a silent copy of the full Case,
  contact details, call notes, or attachments.

Operational v1 has no service bypass or impersonation: the initiating human must be authorized on
both sides. A later bridge is a separate ADR/phase and must model its non-human identity, explicit
project grants, credential lifecycle, reporter/actor provenance, inability to browse, and
revocation. Revoking a connection blocks new links/creates and future cross-workspace signals;
existing projections freeze at their last sanitized snapshot and neither aggregate is deleted.
Revocation cannot recall handoff prose already copied into a Team Task, which the confirmation UI
must state.
Unlinking never deletes either aggregate, and Task completion never resolves a Case.

Composite foreign keys make same-workspace facts database facts; service guards cover invariants
PostgreSQL cannot express with a row-local `CHECK`.

Composite candidate keys such as `Task(id, workspaceId)` and `Project(id, workspaceId)` are
referenced by `SupportCaseTaskLink` and `DepartmentWorkTarget`. A plain UUID relation plus duplicated
workspace columns would not prove that link endpoints match those workspaces.

### Indexes and constraints

Indexes follow the queue access patterns:

- current ownership: workspace + Department + assignee + status;
- Triage: workspace + status where Department is null; the query further excludes `RESOLVED` and
  `CLOSED`;
- Department Inbox: workspace + Department + status where assignee is null; the query further
  excludes `RESOLVED` and `CLOSED`;
- My Cases: workspace + assignee + `nonClosed` status;
- Recovery: workspace + next action, next SLA due, and meaningful activity;
- intake deduplication: unique workspace + source connection + external event/idempotency key;
- external thread deduplication: unique source connection + external Case/thread id;
- per-Case event and SLA-cycle sequence uniqueness;
- Case key/sequence and Case–Task relation uniqueness.

Real migrations enforce assignee-implies-Department, status/timestamp agreement, immutable keys,
same-workspace composite relations, ownership/resolution constraints, and partial indexes. Terminal
Cases cannot be reassigned without an explicit reopen command. Because `bun run db:push` cannot
create `CHECK` constraints, API guard tests under `apps/api/src/routes/` prove the same refusal on a
db-push bootstrap.

The status truth table is explicit: `NEW | OPEN | WAITING_*` have no resolution/close fields;
`WAITING_*` require a next action and the internal variant requires a reason; `RESOLVED` requires
code, summary, and `resolvedAt` but no `closedAt`; `CLOSED` retains those fields and requires
`closedAt >= resolvedAt`; `DUPLICATE` additionally requires a same-workspace `duplicateOfCaseId`.
Mirror every database rule in the service guard tests.

## API and reliable intake

### Workspace contract

Mode is carried by:

- workspace creation and onboarding schemas, defaulting to `TEAM`;
- login/signup/invite/auth workspace responses, including `GET/POST /auth/workspaces`;
- `GET /workspaces` and `GET /me`;
- web auth/session/workspace types and equality;
- workspace switcher items.

`GET /me` also returns workspace capabilities, actor permissions, Support access epoch, and minimal
Department/Triage summaries needed to choose the landing page. The URL workspace, not a possibly
stale cached workspace, is authoritative.

### Support endpoints

Delivered resource surface (grouped; schemas remain the source of truth):

- Department setup and authority: `/support/departments`,
  `/support/departments/:id/members`, `/support/permission-grants`, and
  `/support/credential-grants`.
- Case work: `GET/POST /support/cases`, `GET /support/cases/:idOrKey`, and named `route`, `wait`,
  `resolve`, `close`, `reopen`, `interactions`, `events`, `snooze`, and `resume` subresources;
  `POST /support/calls` records a new- or existing-Case call.
- Search and online collaboration: `/support/search`, `/support/counts`, `/support/session`,
  `/support/sync/*`, `/support/saved-views`, and `/support/cases/:idOrKey/presence`.
- Reliable intake: session-authenticated `/support/intake-connectors`, source-authenticated
  `/support/intake/:lookupId/events` and receipt status, plus `/support/intake-admin/*`.
- Operations: `/support/config/calendars`, `/support/config/sla-policies`,
  `/support/reports/overview`, and `/support/routing/*`.
- Team handoff: `/support/workspace-connections`, `/workspace-connections`,
  `/support/department-work-targets`, and the Case `task-links`/`team-tasks` subresources.
- Maturity: `/support/enablement/*`, `/support/problem-clusters/*`, Case `knowledge`, `assistance`
  and `csat` subresources, `/support/knowledge/gaps`, `/support/csat/respond`, and
  `/support/quality/*`.

Keep all new triage routes under `/support`. `/triage/tasks/*` and `TaskTriageState` already mean
backlog Task triage.

Every mode-specific route and shared service entry point asserts the server-loaded
`actor.workspace.mode` before resolving entity identifiers or writing side effects. No endpoint
accepts mode/capabilities as authoritative request fields.

### Queue composition

`GET /support/cases` composes these delivered filters before intersecting them with access:

- `queue=TRIAGE|DEPARTMENT_INBOX|MY_CASES|NEEDS_ATTENTION`;
- one or more explicit `status`, `priority`, or `sourceChannel` values;
- `departmentId`, `assigneeMembershipId`, `typeKey`, or one `attentionReason`;
- `q`, `receivedFrom`, `receivedTo`, opaque `cursor`, and bounded `limit`.

The four operational queues remain server-defined compositions rather than mutable Case state.
Phase 7 added a separate `SupportSavedView` schema and `/support/saved-views` routes for validated
private, Department or Workspace filters; it does not reuse Task `View`/`taskView*` schemas. Every
execution re-applies current access. Both list surfaces currently page by `receivedAt DESC`; an
arbitrary sort expression is not exposed. This follows ADR-0002's principle that one server-side
read path owns access and exclusion rules.

### Connector intake

The broad agent credential is not a generic public intake key. Each connector has a write-only,
workspace- and source-scoped credential/secret.

`SupportIntakeConnector` is distinct from the Support→Team `WorkspaceConnection`. It stores a public
lookup id, secret hash/version and rotation metadata, signature scheme, active/revoked state,
workspace/source scope, replay window, and rate/size policy—never a plaintext secret in a response,
log, plan, or repository file.

The v1 public provisioning contract exposes `HMAC_SHA256` only. The database reserves an ED25519
enum value for a future asymmetric key-registration design, but clients cannot select it until that
design can register and rotate a public key without pretending the current symmetric secret is an
ED25519 credential. A legacy or manually corrupted unsupported row fails as an invalid connector;
it never reaches an unauthenticated `501` implementation-detail response.

For each webhook/connector event:

1. capture exact request bytes in a content-type-scoped Fastify hook, verify connector/signature/
   timestamp/replay window/size/rate limit against those bytes, and only then parse/validate JSON;
2. persist a durable receipt with a unique workspace/source/event id and payload hash;
3. return `202` quickly with receipt id and a status location;
4. process asynchronously;
5. map source data to a Case and timeline interaction;
6. treat the same id and same hash as a successful retry, but return `409` and persist a
   deduplicated security outbox record when the same id carries a different payload;
7. tolerate out-of-order updates by advancing the source snapshot only for a newer source sequence,
   while still retaining independently idempotent older interactions in their source-time order;
8. retain failed receipts for retry/dead-letter review without exposing raw payloads in logs.

The first-party synchronous Case body may include `idempotencyKey`; identical retries return the
original result and a changed payload returns `409`. A new-Case call requires that key, while an
existing-Case call can bind retries to `externalCallId`. These manual paths are payload-bound but do
not create connector receipts. Connector interactions preserve source `occurredAt` and trusted
server `receivedAt`; SLA starts from the trusted receive time. Raw connector bytes needed for replay
are encrypted and retention-bounded.

A leased receipt/outbox worker starts with the API process and releases leases during shutdown.
Claims use `SKIP LOCKED`/lease expiry, retry with backoff, and recover after worker death; poison
receipts eventually enter an admin-visible dead-letter state. Connector schemas reject server-owned
workspace, key, lifecycle, owner/assignee, resolution, and SLA fields.

Manual call-center entry uses normal session auth and creates the Case and first Call interaction
transactionally.

### Call-center delivery

The `/support/calls` contract supports:

- an explicit existing requester `contactId` or a distinct requester created from inline details;
  the separate audited contact search matches name, email, or normalized phone, while inline phone
  or external-customer data never silently selects or merges an existing contact;
- incoming/outgoing/missed/abandoned/voicemail disposition;
- start/end/duration and agent;
- consent/recording indicator even while recordings themselves are excluded;
- summary and internal notes;
- existing Case link or new Case;
- callback owner and `nextActionAt`;
- Department selection on a new Case; routing assistance is a separate Case command;
- external call id for deduplication.

Zendesk's call routing behavior makes missed/abandoned work visible as records even when no agent
answers. Taskara likewise records abandoned calls as Cases rather than silently losing them. The
new-Case web dialog records inbound calls and the Case timeline records outbound calls; more
specialized provider UX can use the same API contract.

**Recording constraint:** ADR-0004 says current attachment URLs are permanent capabilities and
cannot be revoked when access changes. Support call recordings and sensitive Case attachments
therefore stay out of operational v1. Shipping them requires reopening that decision for a signed,
expiring/revocable media path. Do not attach recordings through the current media service.

### Contact lookup privacy

Contact access is separate from Case access because intake searches before a Case exists:

- triagers, supervisors, and Department managers with manual-create permission may search a minimal
  contact directory for intake; searches are rate-limited and audited;
- Department managers and members otherwise see a contact only through a Case they can currently
  read;
- search results expose no Case count, title, Department, assignment, interaction, or outcome;
- a source connector's external customer id is authoritative for deduplication; normalized phone or
  email returns candidates and never silently merges two people;
- relating duplicate Cases never shares one requester's private timeline with another.

## Web application and sidebar

### Resolve workspace runtime before mounting mode-specific providers

`WorkspaceRuntimeProvider` resolves the URL workspace before any mode-specific provider mounts, so
Support never briefly bootstraps Team Tasks or trusts a stale session workspace after switching:

1. fetch `/me` for that workspace;
2. expose mode, workspace capabilities, and actor permissions;
3. mount `TeamWorkspaceProviders + TeamMainLayout` or
   `SupportWorkspaceProvider + SupportMainLayout`;
4. share only genuinely common providers;
5. make sidebar and command palette consume the same runtime.

Keep Taskara's existing Team provider and local-first behavior intact. Build a separate Support
store/provider over the generic sync primitives; do not make `useWorkspaceTaskSync` nullable across
the whole Team UI. Because Cases contain customer PII and access can disappear on transfer, the v1
Support provider is online-first and memory-only. Persistent/offline Support storage requires a
separate security ADR covering device encryption, TTL, purge, and the unavoidable limit that a
disconnected device cannot receive immediate revocation.

### Central navigation registry

The delivered navigation registry contains:

- mode;
- required capability;
- route;
- Persian label and description;
- icon;
- active-match rule;
- default landing priority;
- global create action.

The registry drives sidebar, command palette, shortcuts help, page metadata, workspace switch
destination, and default redirect.

Delivered Support sidebar/navigation:

| Item / path | Audience | Projection or purpose |
|---|---|---|
| Triage — `/support/triage` | triagers, supervisor, owner/admin | no Department; actionable states |
| My Cases — `/support/my-cases` | Department members | assigned to current user; not `CLOSED` |
| Department Inbox — `/support/department-inbox` | Department manager | Department-owned, unassigned, actionable states |
| Needs Attention — `/support/attention` | access-scoped Case readers | reason-coded recovery |
| Saved Queues — `/support/saved-queues` | access-scoped Case readers | access-rechecked saved filters |
| Departments — `/support/departments` | admin; managers see authorized setup | membership and handoff destinations |
| Routing — `/support/routing` | admin; Department manager capacity scope | policies, simulation and capacity |
| Enablement and Quality — `/support/maturity` | owner/admin; Department manager or supervisor by scope | definitions, problem clusters, knowledge gaps and quality reviews |
| Reports — `/support/reports` | supervisor/admin or manager by scope | operational overview |
| Operations — `/support/operations` | owner/admin | calendars and SLA policy versions |
| Intake Health — `/support/intake-admin` | owner/admin | connector health and dead letters |
| Inbox, Knowledge, Members, Settings | capability-dependent common features | mode-aware common routes |

The top-right plus and keyboard create shortcut create a Task in Team mode and a Support Case in
Support mode.

The mature route catalog should not become one flat sidebar. Keep the registry as the source of
truth, but present only the groups the actor can use:

| Sidebar group | Items | Presentation rule |
|---|---|---|
| Work | Triage, My Cases, Department Inbox, Needs Attention, Saved Queues | first and expanded; an ordinary member normally sees only My Cases and Needs Attention |
| Insights | Reports | visible only to scoped managers/supervisors; never a peer leaderboard |
| Manage Support | Departments, Routing, Enablement and Quality, Operations/SLA, Intake Health | collapsed or reached through one management entry; owner/admin or scoped manager only |
| Workspace | Inbox, Knowledge, Members, Settings | shared, capability-gated items |

Aim for at most four to six immediately visible operational destinations for any actor. Keep less
frequent management routes discoverable through the command palette and management landing page.
Badges show only counts the actor may read and must not leak peer workload through totals.

Use an explicit Case deep link such as `/:workspaceSlug/support/cases/:caseKey`. Keep
`/:workspaceSlug/issue/:taskKey` as the legacy Team Task route; do not overload it by mode.

### Support screens

- Triage: access-scoped actionable Cases with Department assignment; the current queue paginates by
  newest receipt and Case detail owns duplicate, outcome and interaction commands. A recorded public
  response is timeline evidence only; it does not pretend an email/message was delivered.
- My Cases: private working list; no peer assignee filter or peer counts.
- Department Inbox: manager view with member capacity and atomic assignment. Ordinary members do
  not see or self-claim this queue in v1.
- Case detail: requester/context, SLA/next action, status/owner, messages/internal notes/calls,
  assignment/status audit, linked Team Tasks, assistance decisions, approved-definition
  preview/apply/safe undo, KCS search/use/gap capture, and CSAT invitations.
- Needs Attention: reason, clock/age, current owner, resolving action, snooze with explicit next
  action.
- Departments/setup: roles, Support grants and Team destinations. Calendars/SLA, routing and intake
  health use their dedicated Operations, Routing and Intake Health screens.
- Enablement and Quality: versioned macro/template/automation definitions, privacy-filtered problem
  clusters, knowledge-gap review, versioned rubrics and access-scoped completed quality reviews.
- Support Reports is shown to supervisors/admins and Department managers, then re-scoped by the same
  Case access predicate on every request.

Landing precedence is deterministic: supervisor/triager → Triage; otherwise Department manager →
Department Inbox; assigned Department member → My Cases; workspace member with no Support grant or
Department membership → a no-access/setup screen rather than an empty queue.

All layouts require RTL Persian QA, Jalali display, long names/titles, mobile behavior, and useful
empty states.

### RTL and accessibility contract

Treat RTL as record-level data behavior, not only a mirrored shell. Use CSS logical properties and
an RTL document/container direction for Persian navigation, while rendering mixed-direction values
such as Case keys, email addresses, phone numbers, URLs, code, and Team Task keys with `dir="auto"`
or an isolated `<bdi>` boundary. Copying, selection, punctuation, truncation, and screen-reader
announcements must preserve the logical value even when its visual order differs.

Use WCAG 2.2 AA as the release baseline: every queue and Case action is keyboard reachable; focus
order follows the visual RTL flow; dialogs restore focus; validation, SLA risk, and assignment
changes are announced without relying on color alone; pointer targets and contrast meet the
standard; and reduced-motion users do not depend on animated transitions. Automated accessibility
checks are necessary but not sufficient—add manual Persian screen-reader and keyboard passes for
the Triage, My Cases, Department Inbox, Needs Attention, and handoff dialogs.

This is the accessibility release contract, not a claim of formal WCAG certification. Automated
desktop/mobile coverage does not replace the manual Persian screen-reader and keyboard pass.

## Sync, notifications, and concurrency

Reuse `WorkspaceSyncState`, sequence reservation, `SyncEvent`, `ClientMutation`, and the SSE wakeup
mechanism, but expose a separate `/support/sync/*` projection and provider so the existing Task wire
contract stays unchanged:

- bootstrap only hot, accessible Cases and the Department data needed by this reader; ordinary
  members do not receive peer identities, assignments, or capacity rows;
- keep cold closed history paginated and server-searched;
- never put Case bodies, contacts, or interaction content in a workspace-wide event/poke;
- keep the global workspace sequence internal, but expose an audience-specific sequence or opaque
  Support cursor; visible numeric gaps in the current workspace cursor would reveal peer activity;
- scan internal events in order, authorize/transform each event for the reader, and advance the
  private cursor past invisible events as well as returned events so a hidden peer event cannot
  stall pull;
- record audience-safe delivery metadata for ownership changes: old readers receive only
  `removeFromScope`, new readers receive an upsert, and unrelated readers receive nothing;
- include the actor's `SupportAccessEpoch` in bootstrap/cursor state. Workspace-role,
  Support-grant, and Department-membership/role changes increment it transactionally, target that
  user with `scopeReset`, and invalidate old cursors/mutations. Pull/push present the epoch; mismatch
  returns `SUPPORT_SCOPE_CHANGED` with no entity payload. Every tab atomically drops Cases, contacts,
  interactions, counts, notifications, and optimistic writes, then fetches fresh `/me` plus bootstrap
  before rendering;
- map `support_case`, interaction, Department, link, SLA/attention events through
  `supportCaseWhereForAccess` at pull time as defense in depth;
- Support sync push handles route, wait/next-action, interaction, resolve, close and reopen
  mutations. Task links use idempotent REST handoff commands and publish Support sync events;
- preserve optimistic versions in a workspace/user-partitioned in-memory store; do not copy Task
  sync's persistent IndexedDB queue into Support v1.

The Team SSE hub retains its workspace poke behavior. Support wakeups target
`SyncStreamClient.userId` audiences and carry no Case identifier/content, preventing global cursor
gaps or broadcast timing from revealing peer activity volume.

`supportCaseId` is a first-class notification relation and the null-entity branch explicitly
requires it to be null. Shipped linked-Task notifications are recipient-scoped and re-gated during
hydration; stale rows no longer hydrate or contribute to unread counts after access changes.
Recovery currently uses scoped `AttentionItem` projections and Support sync wakeups rather than a
notification type. Assignment, customer reply, reopen, and recovery notifications remain useful
future types, but are not a claim of outbound delivery. Sensitive Case titles/bodies never belong
in a workspace-wide poke or generic external notification.

For concurrency:

- assignment/claim is a single transaction and compare-and-set on Case version;
- only one concurrent manager wins; the other receives `409` and a current projection only if the
  loser still has access—otherwise a generic “access changed” response;
- reply and transition mutations require a current base version;
- Phase 7 adds process-local, short-lived “viewing/editing” presence as a best-effort warning;
  optimistic versions remain the correctness boundary across processes and restarts.

## SLA, routing, and recovery

### Needs Attention reasons

The independently testable reason vocabulary is:

- untriaged too long;
- Department-owned but unassigned too long;
- owner has made no meaningful update within policy;
- next action due/overdue;
- SLA at risk/breached;
- waiting on customer/internal beyond policy;
- missed/abandoned call whose callback is due;
- excessive Department bouncing or a rejected/expired handoff;
- reopened after resolution;
- resolved but unconfirmed;
- non-fixed resolution requiring follow-up;
- linked Team Task blocked/overdue (signal only, never automatic Case state).

These reasons may overlap. Show the most urgent reason first and preserve the full set for detail and
reporting.

The delivered recovery worker evaluates SLA/follow-up state in idempotent sub-day buckets even when
nobody opens a page, maintains scoped `AttentionItem` projections, and publishes payload-free
Support sync wakeups. It does not emit recovery notifications or outbox messages. On-read derivation
remains a correctness fallback. `AttentionItem` is a rebuildable projection, not SLA source of
truth; its reason-plus-cycle identity deduplicates one condition while allowing a later reopened
cycle to surface again.

Support does not reuse the once-per-`(jobKey,dateKey)` `ScheduledJobRun`, which has no workspace
bucket/lease or retryable sub-day clock. `SupportJobLease(jobKey, workspaceId, bucketKey)` carries
attempt count, `nextAttemptAt`, lease owner/expiry, completion and error/dead-letter state.
Business-time math comes from each frozen `SupportBusinessCalendar`, not the global Team workweek
helper.

### Routing maturity

The delivered deterministic policy versions match Case type, source channel, priority, impact and
urgency. A matching action chooses a Department Inbox or capacity-aware member using explicit
availability, capacity and required skills; no eligible member falls back to that Department Inbox.
Simulation explains every rule mismatch and the selected candidate before a version-checked apply.
The impact × urgency matrix produces an audited suggestion that a human accepts or overrides with a
reason.

Service/product, customer tier, category and language dimensions, alternate-Department/time-based
fallbacks, and direct SLA-risk rule conditions remain future extensions. Assistance records can
carry model/rule provenance and confidence, but Taskara does not invoke a model or auto-apply a
routing/reply suggestion. Any future model must use no broader Case scope than its calling actor or
connector.

### Metrics

The delivered `/support/reports/overview` defines a received-time cohort, reports sample sizes and
P50/P90 durations for first response, resolution and current backlog age, exposes SLA state/
attainment counts, and breaks visible Cases down by status, priority, source, type, outcome and
Department. Every query is intersected with Case access and contains no per-member leaderboard.

P95, time trends, business-time/elapsed-time comparison, small-cell suppression and the broader
catalog below remain reporting opportunities rather than shipped claims. Any expansion must define
its cohort/clock and preserve the same authorization boundary.

Track:

- intake volume, interaction/channel mix, untriaged rate, duplicate/contact rate, and time to triage;
- time unassigned, first-assignment accuracy, transfer/bounce/dwell, queue wait, and no-capacity
  events;
- first qualifying public response and next public response after customer activity;
- promised/periodic customer-update adherence while work is waiting internally;
- first/final resolution, requester wait, and internal/engineering wait;
- SLA attainment, at-risk volume, and breach duration;
- non-closed backlog/WIP and age distribution, including unassigned dwell and stale/no-next-action;
- one-touch/first-contact resolution with an explicit denominator, reopen, recurrence, and non-fixed
  resolution rates;
- linked-Task cycle time and time from Team completion to customer update;
- Department capacity/load balance and, when telephony supplies events, call
  answer/abandon/voicemail/callback measures;
- denied access, temporary grant, sensitive export, assignment override, and SLA override counts;
- later report metrics: CSAT, quality-review sampling, and knowledge reuse/deflection.

A qualifying public response is not an internal note, label edit, sync event, or metadata-only
automation. Decide explicitly whether an automated public response satisfies a target and report
human and automated responses separately.

Avoid raw member leaderboards. Optimize customer outcomes, service reliability, and balanced load,
not closure count. Any member-level coaching report is supervisor-only and never visible to peers.

## Cross-workspace Team Task handoff

### Configuration

`WorkspaceConnection` joins one Support workspace to one Team workspace with
`PENDING | ACTIVE | REVOKED` state. An owner/admin on each side must approve it. The Team-side
approval allows only the agreed project/link capabilities; the Support-side approval maps
Departments to allowlisted `DepartmentWorkTarget` projects. A Department member does not get
arbitrary cross-workspace create power or Team membership.

Operational v1 authorization:

- link existing: the initiating human can work/dispatch the Case, can read the target Task, and has
  explicit project-scoped authority to add/remove a Support relation; read-only access is
  insufficient;
- create linked: actor can work/dispatch the Case, the connection/target is active and permits
  creation, and the same human has explicit Task-create authority in the project;
- choosing a `parentTaskId` creates a real Task subtask under that Team Task, subject to existing Task
  same-project/workspace and cycle checks; selecting the parent requires independent Task read
  access;
- without a parent, create an ordinary linked Task.

Record the initiating human in both workspace audit events. A connection never substitutes for
either side's permission, grants ambient browsing, or widens either workspace's membership.
The handoff service resolves the target membership/project permission server-side from the active
connection; it does not trust a client-supplied target actor/role or reuse the Support-bound
`RequestActor` as if it belonged to the Team workspace.

### Data minimization

The create dialog makes the handoff body explicit:

- problem statement safe for the Team workspace;
- expected outcome/acceptance criteria;
- priority and relevant non-sensitive diagnostics;
- Case key backlink.

Requester phone/email, private notes, call transcript/recording, and unrelated conversation history
are excluded by default.

Automatic mapping copies only allowlisted structured fields: Case key, user-selected priority,
Case type, and non-sensitive diagnostics explicitly marked for handoff. It never reads contact,
internal interaction, call, attachment, SLA audit, or raw connector payload tables. User-authored
handoff prose cannot be mechanically guaranteed PII-free, so the dialog previews the target
workspace/project visibility, requires explicit confirmation, and audits the exact submitted brief.

The v1 versioned link projection is exact:

- Support side: opaque link id, approved Team workspace display name, Task key, sanitized title,
  status, last signal time, and deletion/revocation tombstone;
- Team side: opaque link id, approved Support workspace display name, Case key, sanitized handoff
  title, coarse `OPEN | RESOLVED | CLOSED` signal (`NEW | OPEN | WAITING_*` map to `OPEN`), last
  signal time, and revocation tombstone;
- neither side receives the source aggregate's raw UUID, contact/requester, owner/assignee,
  Department/Team membership, conversation, attachment, audit, or full description.

### Status behavior

- Support Case shows only the allowlisted link projection (for example key, sanitized title,
  status, and last signal); opening the full Task still requires independent Team access.
- Team Task shows only the sanitized handoff/Case reference; opening the full Case still requires
  independent Support access.
- Task completion notifies the Case owner and may set a suggested next action.
- Task status never directly changes Case status.
- Case closure never directly closes/cancels Tasks.

Creation accepts an idempotency key. In the single-Postgres delivery, the Task, link, audit events
and two workspace sync publications commit in one transaction, with sync states locked in stable id
order. A retry creates exactly one Task and link.

## Pre-implementation architecture map

This section preserves the repository baseline used to plan the work. Statements such as “has no
mode” or “is hard-coded” describe the code before Support delivery, not the live tree.

### Starting extension points

- `packages/db/prisma/schema.prisma`: Workspace has no mode; Team/Task and generic sync/audit models
  are the main foundations.
- `packages/db/prisma/migrations/`: add a real enum/default/backfill and the composite/`CHECK`
  constraints that `db:push` cannot reproduce.
- `packages/shared/src/index.ts`: add mode, Department, Case, filter, command, and transition schemas.
- `apps/api/src/services/actor.ts`: `RequestActor.workspace` will carry mode; add mode/capability
  guards.
- `apps/api/src/routes/auth.ts` and `routes/system.ts`: both auth workspace responses and the
  `/workspaces`/`/me` contracts currently select workspace fields explicitly and must carry mode;
  `/me` also computes the mode-specific unread gate and actor permissions.
- `apps/api/src/services/team-access.ts` and `task-visibility.ts`: preserve unchanged for Team; build
  parallel support access rather than widening these project predicates.
- `apps/api/src/services/tasks.ts`: the current project-access check admits read-only project
  membership and `createTask` owns its transaction/post-commit publication. Define canonical
  create/link write predicates that exclude viewers, extract a transaction-aware Task-create
  primitive, and make hard deletion tombstone/notify Support links.
- `apps/api/src/routes/sync.ts` and `services/sync.ts`: extract/reuse the generic cursor, mutation,
  and publication machinery while keeping Task wire behavior compatible.
- `apps/api/src/services/attention.ts`: reusable lifecycle, but Case visibility and support reasons
  must be added deliberately.
- `apps/api/src/services/notifications.ts` and `routes/notifications.ts`: add the Case relation,
  thread/hydration shape, unread counts, and current-access filtering—including the null-entity
  branch described above.
- `apps/api/src/services/audit.ts` and `activity-visibility.ts`: extend their closed entity-type/read
  mapping for a filtered common-feed projection; keep `SupportCaseEvent` authoritative.
- `apps/api/src/services/scheduled-jobs.ts` and `workspace-time.ts`: keep the existing daily/global
  Team scheduler out of Support; filter Team reminders/digests/SMS by mode and add the separate
  retryable per-workspace bucket/lease and business-calendar engine described above.
- `apps/api/src/app.ts`: add endpoint-scoped raw-body capture and explicit intake/outbox worker
  startup/shutdown; do not rely on the current parsed JSON body for signature verification.
- `apps/web/src/App.tsx`: routes and default landing are currently Team-only and hard-coded.
- `apps/web/components/layout/sidebar/app-sidebar.tsx`: sidebar/workspace switcher is hard-coded.
- `apps/web/components/layout/main-layout.tsx`: global search, create, and shortcuts assume Tasks.
- `apps/web/lib/fa-copy.ts`: add one reviewed Persian noun set for Support navigation, queues,
  lifecycle, errors, and empty states rather than scattering literal copy.
- `apps/web/components/taskara/auth-pages.tsx`, `page-header.tsx`, and `settings-view.tsx`: each has a
  hard-coded workspace home that must use the same mode registry.
- `apps/web/lib/task-sync-provider.tsx` and `workspace-data/*`: retain for Team; reuse selector and
  optimistic-overlay ideas in a distinct memory-only Support provider, not its persistent Case cache.
- `apps/web/lib/inbox-sync.ts` and `knowledge-sync.tsx`: their persistent keys currently use only the
  workspace slug. Re-key Team/common data by workspace plus authenticated user, clear on identity
  change, and keep the Support Inbox projection memory-only so a second browser user cannot see the
  previous user's Case notification.
- `apps/web/lib/taskara-types.ts` and `store/auth-store.ts`: carry mode/capabilities and compare them
  in cached session equality.
- `apps/api/src/routes/agent-cli.test.ts`: existing CLI exit codes and behavior remain untouched;
  any future Support CLI gets its own contract tests.
- `apps/api/src/routes/raycast.ts`, `apps/menubar/src/main.mjs`,
  `plugins/taskara-agent/src/cli/login.ts`, Mattermost handlers, and agent/AI routes: currently assume
  Team projects/Tasks. Select a Team workspace or return a clear unsupported-mode response before
  provisioning, probing `/projects`, or creating any record.

### Name and contract collisions to avoid

- `/triage/tasks/*` and `TaskTriageState` already mean Team backlog triage.
- `AgentRunKind.TRIAGE` already exists; a future AI run should be named
  `SUPPORT_CASE_TRIAGE` rather than overload it.
- `/issue/:taskKey` is the legacy Task URL and must remain so.
- `TaskSource.API` is Task provenance, not a Support Case channel.
- Task CLI exit codes are a published contract. Add separate Case commands later without changing
  existing codes or meanings.

## Delivered phase sequence

The bullets below preserve the implementation sequence and exit intent; they are a historical
checklist, not a roadmap of still-unstarted work. Explicitly deferred items are called out in Phase
8 and in the Delivery boundary.

### Phase 0 — Settle language and security boundaries

- choose the Persian UI noun for Support Case;
- confirm populated-workspace mode immutability;
- confirm whether ordinary members can ever see/claim a redacted Department queue;
- confirm direct member transfer versus transfer request;
- confirm dual-approved cross-workspace connection and minimal shared projection;
- update `CONTEXT.md` and add the three ADRs;
- inventory Team-only, Support-only, and common API route groups;
- write the permission matrix/threat model, including inference through sync, notifications, search,
  analytics, exports, attachments, and cross-workspace links;
- decide authenticated expiring media posture and document sensitive call/contact retention in the
  existing gitignored security area.

Exit: no unresolved term changes the schema or access matrix.

### Phase 1 — Workspace mode spine, Team behavior unchanged

- migration: Workspace mode default/backfill `TEAM`;
- explicit Team/Support selector in onboarding/new-workspace UI; mode in creation, auth,
  `/workspaces`, `/me`, shared/web types, and session equality;
- runtime provider resolves URL workspace before mounting a mode shell;
- centralized route/navigation/capability registry;
- Team sidebar, routes, create action, sync, and landing snapshot tests;
- Support workspace shows a guarded empty setup screen and no Team-only menus/providers;
- deny-by-default mode classification at REST/CLI routes, sync mutations, shared service entry
  points, agent/AI actions, Mattermost/Raycast/menubar handlers, meeting/check-in Task creation, and
  scheduled jobs—not only page routes;
- filter existing daily-report/digest/SMS jobs to `TEAM`, and make unsupported non-web clients select
  a Team workspace or fail cleanly before provisioning/writing;
- re-key common Inbox/Knowledge browser caches by workspace and authenticated user; use a memory-only
  Inbox projection in Support mode and clear all common providers on auth identity change.

Exit: an existing Team workspace is behaviorally unchanged and its API changes are additive
`mode/capability` fields only; Support cannot create/read mode-specific Team records through normal
Team routes.

### Phase 2 — Departments and privacy perimeter

- Department, Department membership roles, Support permission grants, and minimal Case/event schema;
- `support-access.ts` and negative access matrix tests;
- Department admin UI;
- Support sync skeleton with an identity-partitioned, memory-only store;
- audience-scoped upsert/removal events and cursor-progress tests;
- access-epoch reset tests for grant/revoke, manager promotion/demotion, Department and workspace
  membership removal, multiple tabs, and reconnect before stale content renders;
- read-access sweep covering every shipped detail, list, search, count, sync, notification,
  activity, relation, report and assistance projection. Attachment and export surfaces remain
  deliberately unshipped.

Exit: fixture Cases prove a peer cannot learn another member's Case exists through any surface.

### Phase 3 — Manual Case tracer bullet

- complete Case keying, lifecycle, contact/external-reference, interaction, audit, versioning, and
  ownership invariants;
- requester lookup, call dispositions, and transactional manual Case + Call interaction;
- Triage, assign Department, Department Inbox, assign member, My Cases;
- logged public-channel interactions/internal notes/calls, next action, resolve/reopen; no claim of
  email/messaging delivery before an outbound connector exists;
- Needs Attention for stale/next-action/non-fixed/reopened;
- atomic transfer with access removal/upsert events;
- mode-specific global create/search and access-scoped sidebar counts.

Exit: one Case can travel from manual call to Triage to Department to member to verified resolution,
and every transition is live, auditable, and privacy-safe.

### Phase 4 — Reliable connector intake

- `SupportIntakeConnector` credential/configuration and durable receipt queue;
- signature/replay/rate/size checks, idempotency, retry/dead-letter handling;
- scoped raw-body verification before parsing;
- leased async receipt/outbox worker, startup/shutdown lifecycle, source mapping, and recovery after
  worker death;
- duplicate/link-to-existing Case workflow;
- intake health dashboard for failed or delayed receipts.

Exit: duplicate and out-of-order test events create one correct Case; an abandoned call is never
silently lost.

### Phase 5 — SLA clocks and recovery

- workspace business calendars and versioned SLA policies/cycles;
- triage, first response, next response, resolution, and follow-up clocks;
- breach-risk/Attention reason projection and idempotent background evaluation; configurable queue
  ordering remains outside the delivered list contract;
- retryable per-workspace/time-bucket job leases and calendar arithmetic, separate from the current
  once-per-day scheduler contract;
- pause/resume/reopen/transfer semantics and cycle-keyed Attention projections;
- manager/supervisor recovery views and scoped sync wakeups; recovery notifications remain future.

Exit: clock simulation tests cover workspace timezone, Jalali display boundaries, holidays, public
human response, waiting rules, transfers, reopen, and policy changes; every due/breached/stale Case
appears in Needs Attention without a page visit and is deduplicated once per reason/cycle.

### Phase 6 — Cross-workspace Task links

- dual-approved workspace connections and Department Team destinations;
- link existing Task with dual authorization;
- dual-authorized human creation of a linked Task and optional parent Task;
- transaction-aware Task creation/publication primitive and linked-Task deletion tombstone behavior;
- safe handoff brief, redacted projections, audit, two-workspace sync;
- linked Task updates notify the Case owner without coupling states.

Exit: unauthorized users learn no title/body from either side, and failure cannot leave an
untracked Task or dangling link.

### Phase 7 — Routing maturity and operational reporting

- deterministic rule builder with simulator/explanation;
- optional access-scoped saved Support queues with a separate Support-view schema;
- balanced capacity/availability assignment, skills, and fallback routing;
- impact × urgency priority suggestions with audited override;
- operational reporting and percentile metrics;
- collision/presence warnings after version-conflict correctness.

Exit: simulated demand never strands a Case without a fallback; routing decisions are reproducible,
capacity-aware, and explainable; reports respect supervisor/manager/member privacy scopes.

### Phase 8 — Quality and agent assistance

- macros/templates and approved automation;
- KCS-style access-filtered search/use/gap-review flow with feedback and review ownership;
- recurring-problem clusters plus canonical duplicate Case relations;
- suggested type, priority, Department, duplicate, summary, and reply;
- human accept/reject with model/rule provenance;
- CSAT/quality review and knowledge suggestions;
- deliberately deferred: vendor-specific email/messaging/telephony adapters and every outbound
  delivery channel; the generic signed intake contract remains channel-labelled;
- deliberately deferred: secure recording/attachment work until the media ADR is changed.

### Post-v1 evidence gates — not delivered

These are optional maturity steps, not prerequisites for the manual tracer bullet or operational
v1. Promote each only when pilot evidence shows the problem is material:

- **Expert assist:** expiring Case-collaborator grants, consult requests, owner-preserving internal
  discussion, and help-response time; do not add ambient Department visibility.
- **Contact-center capacity:** channel-aware wrap-up, shift/availability handover and callback load;
  add workforce forecasting only after enough volume history exists.
- **Quality operations:** stratified/random review sampling, calibration sessions, baseline reviews,
  reviewer variance, coaching follow-up and disputes, all under the same Case access predicate.
- **Customer channel completeness:** outbound email/messaging/telephony adapters and a customer
  portal only after identity, consent, retention, delivery-status and secure-media decisions are
  settled in ADRs and the gitignored security area.

## Acceptance contract

This is the complete threat, behavior and regression catalog used to shape implementation. It is
not an assertion that an endpoint exists for a deliberately excluded feature; attachment/export,
offline storage, outbound delivery and other exclusions are tested by absence or refusal where
applicable.

### Mode and compatibility

- old rows migrate to `TEAM`;
- omitted create mode still creates Team workspace;
- workspace mode is immutable after creation, including an apparently empty workspace;
- Team route/sidebar/sync/default redirect behavior is unchanged;
- Support mode cannot call Team-only routes and Team mode cannot call Support-only routes;
- spoofing mode/capabilities in local storage or a request body does not bypass a server route guard;
- switching workspaces immediately changes mode, providers, create action, command palette, and
  menus without a reload;
- Mattermost/Raycast/menubar/agent/AI/sync/service entry points and scheduled jobs cannot create Team
  records or send Team-only reminders in a Support workspace; unsupported clients fail before agent
  provisioning or default-project creation.

### Privacy

- ordinary member sees own Case and receives its events/notifications;
- same-Department peer gets `404` and no list/search/autocomplete/count/sync/inbox/activity/
  relation trace; no Support attachment endpoint exists;
- the same peer's update/note/route/resolve/link attempts are refused, not merely hidden; no Support
  bulk-export endpoint exists to bypass that predicate;
- a peer-only mutation neither wakes the member's Support stream nor exposes a global sequence gap;
- Department manager sees all current Department Cases but no other Department;
- triager sees unassigned Cases but loses them after routing unless another grant applies;
- transfer gives the old audience a payload-free cache removal, gives the new audience an upsert,
  and makes old notifications disappear from hydration/unread counts;
- transfer between notification creation and delivery suppresses delivery and any external message
  remains generic;
- manager/triager/supervisor grant and revoke, Department-role/membership change, workspace-role
  downgrade/removal, multiple tabs, and offline reconnect all force an epoch reset before stale data
  renders or an optimistic write replays;
- a credential actor whose backing User is workspace `OWNER` still sees nothing without explicit
  Support credential scopes;
- contact search and interaction/call/content subresources apply their independent access rules;
- no Case/contact/interaction content exists in localStorage, IndexedDB Task snapshots, or a second
  browser user's common-provider cache;
- supervisor/admin sees all;
- linked Task and Case projections redact the inaccessible side;
- shipped report, assistance, cluster, KCS and quality endpoints apply the identical predicate; any
  future export or model invocation must do the same.

### Ownership and concurrency

- assignee is an active member of the owning Department;
- assignee-without-Department and cross-workspace/cross-Department membership combinations fail at
  both the API guard and real database constraint;
- Department change clears an invalid assignee;
- two claims race: one wins, one gets `409`;
- stale status/reply write cannot overwrite a newer transfer or customer reply;
- no generic Case patch exists; named commands cannot smuggle owner, lifecycle, resolution, link or
  SLA fields outside their schema;
- every cross-Department transfer requires and stores a reason;
- membership deactivation clears assignment from `nonClosed` Cases, returns actionable work to the
  Department queue, preserves resolved/closed history, and hard deletion clears current pointers;
  leaving/rejoining does not resurrect old grants;
- Department deactivation with `nonClosed` work is refused until that work is transferred;
- connector activity on a `CLOSED` external thread creates a new audited follow-up Case; manual
  interaction/call commands require an explicit authorized reopen or new Case.

### Intake

- repeated idempotency/external event id returns one Case;
- same idempotency/event id with a different payload hash returns `409` and audits the mismatch;
- signature verification uses exact raw bytes before JSON parsing; invalid/replayed input is refused;
- handler persists then returns `202` with a receipt/status location quickly;
- concurrent connector/manual creation reserves unique Case keys, while concurrent duplicate
  receipts create one Case/interaction and return its original key;
- out-of-order interaction does not roll the Case backward;
- a worker killed after claim is recovered after lease expiry; retries are safe and poison receipts
  become visible dead letters;
- manual call and connector call share the same Case/timeline vocabulary.

### SLA and recovery

- clock uses workspace business calendar, timezone, and holidays;
- a calendar/policy edit does not rewrite an active cycle's frozen version; DST/timezone and holiday
  boundary simulations preserve the intended business duration;
- waiting on customer pauses only policy-selected clocks;
- bot acknowledgement, assignment, and internal note do not satisfy first response; a public human
  reply does;
- inbound reply resumes/reopens correctly;
- transfer preserves Case-level clock and records Department ownership clock boundaries;
- unassigned and snoozed Cases do not silently pause clocks;
- meaningful-activity stale rule ignores automated metadata updates;
- repeated scheduler runs produce one active Attention projection per Case/reason/SLA cycle;
- a failed Support time bucket retries, while existing Team-only daily jobs skip Support workspaces;
- due, breached, stale, reopened, and non-fixed reasons appear and resolve independently.

### Cross-workspace

- link existing requires Case work permission, Task read permission, an allowlisted target, and
  Team-side relation-write authority; source-write/target-read, source-read/target-write, and
  target-viewer cases are denied;
- connection activation requires approval from both workspace sides and an allowlisted Department
  target; revocation blocks new work without deleting history;
- create linked requires the same human to hold Case permission and explicit Team project-create
  permission; a viewer is refused;
- optional parent is in the target Team workspace/project and passes Task relation checks;
- automatic handoff maps only the exact structured allowlist; user-authored prose is previewed with
  target visibility and audited;
- both projection payloads match the exact versioned field allowlist and expose no raw source UUID;
- support-only readers cannot open the Task and Team-only readers cannot open the Case;
- Task completion suggests follow-up but does not resolve Case;
- unlink requires mutation authority on both sides; connection revocation freezes projections and
  stops later status signals, while Task deletion leaves a tombstone and Support follow-up;
- an injected transaction failure leaves neither Task nor link, and retry is idempotent across both
  workspaces.

### Required verification

After every implementation phase:

~~~text
bun run test:api
bun run test:web
bun run typecheck
~~~

Also add focused Playwright coverage for Support desktop/mobile RTL, long Persian copy, empty and
large queues, workspace switching/cache purge, transfer-driven access removal, network reconnect
and forced rebootstrap, cross-workspace links, mixed-direction Case/Task/contact values, keyboard
focus order, dialog focus restoration, non-color SLA states, and reduced motion.

~~~text
bun run --filter @taskara/web test:e2e
~~~

## Delivery boundary

The original sequencing used Phases 0–3 for the **manual pilot**, Phases 4–6 for **operational v1**,
and Phases 7–8 as the maturity roadmap. This implementation delivers all three boundaries: the
manual workflow, reliable intake/SLA/recovery/Team handoff, and the routing, collaboration,
reporting, quality, enablement, KCS, and assistance foundations.

Operational v1 includes:

- two coherent workspace modes;
- Departments and strict private ownership;
- manual, API, and call intake;
- Triage, Department Inbox, My Cases, Needs Attention;
- assignment/reassignment and outcome-aware resolution;
- Case–Task links and create-linked Task/subtask;
- triage/response/resolution/follow-up clocks and reason-coded recovery;
- audit, sync, notifications, and basic operational counts.

The delivered maturity layer also includes:

- deterministic rule versions, simulation/explanation, capacity/availability/skills and fallback;
- audited impact × urgency suggestions and human priority override;
- access-scoped saved queues, process-local collision presence and scoped P50/P90 operational
  percentiles;
- versioned macros/templates/automation with approval, exact preview, human apply and safe undo;
- privacy-filtered problem clusters and KCS search/use/gap-review flows;
- persisted assistance suggestions with target re-authorization and human accept/reject;
- opaque single-use CSAT invitations, versioned quality rubrics and scoped completed reviews.

The delivered product still excludes or deliberately limits:

- customer portal, vendor-specific channel adapters and outbound email/messaging/telephony delivery;
  the generic signed connector only accepts channel-labelled inbound events;
- call recording, sensitive Support attachments, and an automated retention/redaction/erasure UI;
- persistent/offline Support Case storage or offline mutation queues;
- free-form custom field/form, report-builder or Support bulk-export surfaces; the delivered report
  is the access-scoped overview described above;
- configurable queue sort expressions, P95/time-trend analytics and alternate-Department/time-based
  routing fallback; lists page newest receipt and capacity fallback returns to the selected
  Department Inbox;
- automatic resolution-to-close/grace-window execution; close is an explicit audited command;
- cross-process durable presence; collision warnings are best-effort and optimistic versions remain
  authoritative;
- automatic model-driven routing or replies; the product persists explainable rule/model
  suggestions but a human remains the mutation boundary;
- automatic populated-workspace conversion;
- any cross-workspace service/integration principal; v1 uses one human authorized on both sides;
- Support Case commands in the Task CLI, Mattermost, Raycast or menubar clients; those clients stay
  Team-only or return unsupported mode;
- formal WCAG certification; WCAG 2.2 AA remains the manual and automated release target.

## Settled product decisions

1. **UI noun:** «پرونده پشتیبانی» is the canonical Persian product noun.
2. **Department queue:** ordinary members cannot browse or claim even a redacted unassigned queue;
   Department managers dispatch work.
3. **Triage lifetime:** routing removes triage-only access unless another current grant applies.
4. **Member transfer:** ordinary members may return their own Case to the Department Inbox;
   Department managers/supervisors perform cross-Department transfer with a reason.
5. **Team handoff authority:** the initiating human must be independently authorized in both
   Workspaces. No integration principal is implied by a connection.
6. **Common modules:** Inbox, Knowledge, members and settings are mode-aware common capabilities;
   Team communications remain outside the Support sidebar.
7. **Close policy:** resolution and closing are separate, versioned commands. Closing records
   customer confirmation, policy-window completion or an administrative override; inbound customer
   activity follows the explicit reopen/new-Case rules.
8. **SLA calendar:** Support uses versioned Workspace business calendars, an IANA timezone and
   explicit holidays, with versioned policy targets/pause behavior frozen per active cycle.
9. **Intake contract:** v1 ships signed API/webhook intake plus manual/call-center entry. It stores
   only contract-allowlisted fields. A connector's configured source may be API, call, email or
   messaging, but no vendor adapter or outbound email/messaging/telephony delivery is claimed.
10. **Shared projection:** links carry only versioned sanitized key/title-summary/status/signal
    projections. They never grant source access or carry contact, conversation, call or SLA data.

This plan interprets “Department members should not see each other's tasks” as applying to Support
Cases. Linked Team Tasks continue to obey the target Team workspace's existing project/Team access
rules. A link grants no full aggregate access; it deliberately exposes only the approved sanitized
projection, and opening either source record still requires independent authorization.

## Sources

Vendor documentation is mutable. The original source set was checked on 2026-08-23; the expert
collaboration, wrap-up and quality-calibration additions were checked on 2026-08-24. They support
the identified patterns, not a commitment to reproduce every vendor feature.

- Zendesk, [About omnichannel routing](https://support.zendesk.com/hc/en-us/articles/4409149119514-About-omnichannel-routing):
  channel unification, queues, group eligibility, capacity/availability, priority, skills, SLA-risk
  ordering, reassignment, and call behavior.
- Zendesk, [About private ticket groups](https://support.zendesk.com/hc/en-us/articles/4767122732058-About-private-ticket-groups):
  restricted group visibility and explicit exceptions; Taskara's assignment-level rule is stricter.
- NIST, [least privilege](https://csrc.nist.gov/glossary/term/least_privilege): the security basis
  for giving members only the Case access necessary for their assigned work.
- Atlassian, [What are queues?](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-queues/)
  and [best practices for queues at scale](https://support.atlassian.com/jira-service-management-cloud/docs/best-practices-for-managing-queues-at-scale/):
  focused queue views, priority, SLA sorting, and bounded queries.
- Atlassian, [What are SLAs?](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-slas/):
  goals, start/pause/stop conditions, and calendars used to prioritize service work.
- Atlassian, [Create linked work items](https://support.atlassian.com/jira-service-management-cloud/docs/create-linked-issues-to-collaborate-with-other-jira-products/)
  and [developer escalations](https://support.atlassian.com/jira-service-management-cloud/docs/what-are-developer-escalations/):
  keeping customer-service intake linked to, but separate from, delivery collaboration.
- Atlassian, [What is a service request?](https://www.atlassian.com/itsm/service-request-management):
  incident, request, and problem distinctions.
- Intercom, [Set SLAs for conversations and tickets](https://www.intercom.com/help/en/articles/6546152-set-slas-for-conversations-and-tickets):
  first/next/close/resolution targets, business hours, and configured waiting/snooze behavior.
- Intercom, [Workload management](https://www.intercom.com/help/en/articles/6560715-workload-management-explained)
  and [Inbox assignment limits](https://www.intercom.com/help/en/articles/12960865-inbox-assignment-limits):
  balanced Support assignment, person/team capacity, fallback behavior, and channel-aware wrap-up
  time for after-contact work.
- Intercom, [Assign conversations to teammates and teams](https://www.intercom.com/help/en/articles/6561699-assign-conversations-to-teammates-and-teams):
  team and teammate ownership, team-inbox fallback, and reassignment controls.
- Freshdesk, [Load-balanced assignment](https://support.freshdesk.com/support/solutions/articles/221919-configure-load-balanced-ticket-assignment)
  and [skill-based assignment](https://support.freshdesk.com/support/solutions/articles/222692-configure-skill-based-ticket-routing):
  availability/capacity-aware routing and qualified-agent selection.
- Freshdesk, [Hourly automation](https://support.freshdesk.com/support/solutions/articles/240671-automation-rules-that-run-on-hourly-triggers)
  and [audit logs](https://support.freshdesk.com/support/solutions/articles/235745-track-changes-using-audit-log):
  stale follow-up reminders and performer/date-time/action/change-detail traceability.
- Freshdesk, [Prevent outdated replies](https://support.freshdesk.com/support/solutions/articles/218076-how-to-prevent-reply-clashes):
  collision and stale-reply protection.
- Zendesk, [Problem and incident tickets](https://support.zendesk.com/hc/en-us/articles/4408835103898-Working-with-problem-and-incident-tickets):
  clustering several customer reports around one underlying problem.
- Zendesk, [Defining SLA policies](https://support.zendesk.com/hc/en-us/articles/4408829459866-Defining-SLA-policies):
  policy conditions, priority targets, calendars/business hours, and precise first-reply,
  next-reply, periodic-update, and resolution clocks.
- Zendesk, [Viewing ticket update events](https://support.zendesk.com/hc/en-us/articles/4408829602970-Viewing-all-events-for-ticket-updates):
  person/rule update history and previous/new field values.
- Zendesk, [Merging tickets](https://support.zendesk.com/hc/en-us/articles/4408882445594-Merging-tickets):
  duplicate-request consolidation and the permanence/privacy risks of destructive merges.
- Zendesk, [Support metrics and attributes](https://support.zendesk.com/hc/en-us/articles/4408827693594-Metrics-and-attributes-for-Zendesk-Support):
  unsolved/unassigned work, one-touch records, reopens, first/full resolution, and requester/agent
  wait measures.
- Zendesk, [Omnichannel queue metrics](https://support.zendesk.com/hc/en-us/articles/9046662025498-Metrics-and-attributes-for-omnichannel-routing-queues):
  queue entries, exits/transfers, and wait-time measurement.
- Stripe, [Receive events in a webhook endpoint](https://docs.stripe.com/webhooks):
  signature verification, replay protection, duplicate handling, non-guaranteed ordering,
  asynchronous processing, and fast successful acknowledgement.
- Google SRE, [Monitoring distributed systems](https://sre.google/sre-book/monitoring-distributed-systems/):
  why averages conceal tail behavior and distributions/percentiles should be retained; the exact
  delivered P50/P90 cuts remain a Taskara product choice.
- W3C, [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/): the AA
  baseline for keyboard operation, focus, contrast, status communication, pointer targets, and
  accessible authentication in the Support workflow.
- W3C Internationalization, [Inline markup and bidirectional text](https://www.w3.org/International/articles/inline-bidi-markup/):
  isolating mixed-direction Case keys, Task keys, contact data, URLs, and code inside an RTL Persian
  interface.
- Consortium for Service Innovation, [Knowledge-Centered Service (KCS)](https://www.serviceinnovation.org/kcs/):
  integrating knowledge capture, reuse, and improvement into the Case-resolution workflow.
- Consortium for Service Innovation, [expert collaboration guidance](https://www.serviceinnovation.org/intelligent-swarming/):
  connecting work to relevant expertise, collaborating without unnecessary handoffs, and retaining
  learning in a knowledge-intensive support environment.
- Zendesk, [Setting up calibration in Zendesk QA](https://support.zendesk.com/hc/en-us/articles/7043724530842-Setting-up-calibration-in-Zendesk-QA):
  common-case reviewer calibration, comparison against a baseline review, controlled review
  visibility, and consistent quality feedback.
