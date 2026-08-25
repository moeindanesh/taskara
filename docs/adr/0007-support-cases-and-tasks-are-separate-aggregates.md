# Support Cases and Tasks are separate aggregates joined by a minimized link

A Support Case and a Task model different work and stay different aggregates. Departments own and
route Support Cases in a Support Workspace; Teams and projects own Tasks in a Team Workspace. A
Case that needs delivery work gains a `SupportCaseTaskLink` through a dual-approved
`WorkspaceConnection` and Department project allowlist. It never becomes a Task or a Task parent.

The link is many-to-many. One recurring customer problem may produce many Cases linked to one
engineering Task; one Case may need several Tasks. Creating “a subtask from a Case” means creating a
real Task under a selected Team Task, then linking it to the Case.

## Why

- Customer service and delivery have independent lifecycles. A Task reaching `DONE` is evidence to
  Support, not proof the requester is fixed; a Case reaching `CLOSED` is not an instruction to close
  or cancel delivery work.
- Ownership means different things. Department ownership persists while an optional member handles
  the Case, and ordinary peers may not browse it. Task visibility follows project and Team access.
  Reusing either membership model would erase one side's rules.
- Intake channels, contacts, public replies, call metadata, waiting states, SLA clocks and
  resolution outcomes do not belong on a delivery Task. Conversely, project milestones,
  dependencies, weights and Task status do not describe service obligations.
- A first-class link can audit approval, revocation, minimization and lifecycle signals. Copying a
  URL into prose cannot.

## Link boundary

The initiator must be authorized on both sides in v1: work or dispatch the Case, and independently
read/link or create in the allowlisted Team project. A connection substitutes for neither
membership. It records owner/admin approval from both Workspaces and can be revoked.

Only a versioned projection crosses the boundary. Support receives the Team Workspace display name,
Task key, sanitized title/status and last signal. Team receives the Support Workspace display name,
Case key, sanitized handoff title, coarse `OPEN | RESOLVED | CLOSED` signal and last signal. Neither
projection contains requester identity, conversation, internal notes, call data, attachment URLs,
SLA history, Department/member ownership or the other aggregate's raw UUID.

The handoff brief is explicit user-authored prose previewed against the target project's audience.
Revoking a connection prevents new links and signals but cannot recall prose already copied into a
Task. Unlinking and hard Task deletion retain a sanitized tombstone; neither deletes the Case.

## Consequences

- Composite foreign keys prove that Case, Department, project, Task, target and both Workspace IDs
  agree. Mode direction and active approval remain service checks with migration-level backstops.
- Link/create commands are transactional and idempotent, audit both Workspaces and publish
  audience-specific sync events.
- Case keys use a Support Workspace counter, independent of `Project.nextTaskNumber`.
- A future service bridge is a new decision: it needs a non-human identity, narrow project grants,
  credential lifecycle and revocation. V1 does not impersonate or bypass the initiating human.

## Considered options

- **Store Support intake as Tasks.** Rejected: it overloads Task status, project ownership and broad
  peer visibility while leaving service clocks and requester history implicit.
- **Make a Case the parent of delivery Tasks.** Rejected: parenthood would cross aggregates and
  Workspaces, bypass existing Task tree/project invariants and imply shared lifecycle.
- **Copy the full Case into a Task.** Rejected: it permanently widens sensitive data and drifts as
  both records change.
