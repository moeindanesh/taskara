# A Workspace has one operational mode, and capabilities derive from it

A Workspace is created in exactly one `WorkspaceMode`: `TEAM` or `SUPPORT`. Existing rows and an
omitted creation field mean `TEAM`. The mode is operationally immutable: there is no ordinary
`PATCH mode`, and a database trigger rejects changing it behind the application.

Mode selects the coherent domain profile. `TEAM` owns the existing Tasks, projects, Teams,
milestones, reports and Team Overview. `SUPPORT` owns Support Cases, Departments, Support Triage,
service clocks and recovery queues. Identity, membership, settings, Inbox and Knowledge are common
capabilities; Team communications remain Team-only. An actor's permissions are then derived
separately from Workspace role, Support grants and Department membership. Hiding a menu is never
authorization.

## Why

- A populated Team Workspace and a populated Support Workspace have different primary records,
  ownership rules, sync audiences, metrics and safe defaults. Flipping only the sidebar leaves all
  those assumptions contradictory.
- Independent feature booleans admit incoherent combinations: Support queues with no Case model,
  Task create shortcuts in a private Case shell, or Team sync mounted before the product profile is
  known. One enum has two valid states and can be exhaustively handled.
- Defaulting and backfilling to `TEAM` preserves every existing client and Workspace. A caller that
  does not know about modes gets the product it has always used.
- A conversion is data migration, not configuration. It needs a dry run and explicit mappings for
  primary records, ownership, permissions, navigation and integrations. Preventing casual updates
  leaves that future workflow room to be honest about its cost.

## Consequences

- Workspace creation may choose a mode; every response used to authenticate, list or switch
  Workspaces carries it.
- Server-owned capability and permission registries gate routes independently of the web registry.
  The default landing, sidebar, global create action, command palette, sync provider and redirects
  all consume the resolved profile rather than invent their own mode checks.
- A Team-only client presented with a Support Workspace returns a clear unsupported-mode result; it
  does not probe `/projects` and infer from failure.
- Mode-specific writes validate the mode in the service. The real migration also prevents Support
  aggregate rows in a Team Workspace and constrains Workspace connections to `SUPPORT -> TEAM`.

## Considered options

- **Runtime toggle on one populated Workspace.** Rejected: the data and authorization models do not
  switch atomically with navigation.
- **A matrix of feature flags.** Rejected: most combinations are nonsensical and every consumer
  would become responsible for reconstructing a product profile.
- **Infer mode from the presence of Tasks or Cases.** Rejected: an empty Workspace is ambiguous,
  concurrent first writes race, and read behavior must be known before either aggregate is loaded.
