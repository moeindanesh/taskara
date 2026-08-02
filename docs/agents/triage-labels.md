# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repo's issue tracker — Taskara.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this task   |
| `needs-info`               | `needs-info`         | Waiting on the reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

Apply and remove them with `taskara task edit`:

```bash
taskara task edit CORE-123 --add-label ready-for-agent --remove-label needs-triage
```

## There is no pre-seeding step

Unlike GitHub, **Taskara creates a label the first time it is used.** The write upserts on
`(workspace, name)`, so the first `--add-label needs-triage` in a workspace mints the label and
attaches it in the same request. Nothing has to be created up front, no bootstrap script exists, and
there is no "label does not exist" failure to handle.

Four consequences worth knowing before you paste a label string:

- **A typo silently mints a new label.** `read-for-agent` does not fail; it becomes a label. There is
  no "list the labels" command, so the check is that `taskara task list --label <name>` returns
  `total: 0` for a name nothing carries.
- **Matching is exact and case-sensitive.** `Needs-Triage` and `needs-triage` are two labels.
- **Labels are workspace-scoped**, so two workspaces can hold the same name independently.
- **`none` is the absence sentinel** on the `--label` filter: `taskara task list --label none` lists
  unlabelled Tasks, which makes a label literally named `none` unreachable through that filter.

Limits: at most **12** labels on one Task, and at most **40** characters in a name. Exceeding either
is exit 6.

## This vocabulary is not Taskara's own triage queue

Taskara has a native triage state machine of its own — accept, request info, decline, mark duplicate,
snooze, split — stored per Task and surfaced in the web UI's decision queues. **The five labels above
do not touch it, and it does not set them.** They are the skills' vocabulary riding on labels, which
is all `/triage` needs; a human working Taskara's queue is looking at a different field.

Keeping them in step is manual today. If that ever becomes load-bearing, it is a change to Taskara,
not to this file.

## Wayfinder's labels are separate

`/wayfinder` uses its own namespace — `wayfinder:map` on the Effort (Taskara marks a map with
`kind = EFFORT`, so the label is redundant here and is not applied) and `wayfinder:<type>` on each
ticket, one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.
These are not triage roles and a Task can carry both.

Edit the right-hand column above to match whatever vocabulary you actually use.
