# A human account begins at signup, and the header path is what enforces it

A person gets into a workspace by **signing up or accepting an invite**. An admin calling `POST /users`
creates a *pre-registration* — a row naming somebody expected to join — not an account they may act
through.

The mechanism that enforces this is `TASKARA_EMAIL_HEADER_AUTH=false`, not a check on the row.

## Why not a check on the row

The obvious implementation is to refuse a human with no `passwordHash` on the `x-user-email` path. It
was written, measured, and thrown away, and the reason is worth keeping:

**That path never verifies a password.** It reads an email header, finds the user, checks kind and
membership, and returns that member's full role. So requiring a `passwordHash` does not stop
impersonation — it narrows the set of impersonable identities from *every member* to *every member who
has signed up*. An attacker who knows a signed-up colleague's address is unaffected, which is the case
that matters.

The measured cost of that non-fix: **32 test files**, because nearly every route test creates a member
without a password and then acts as them. Paying a suite-wide churn for a change that protects nobody in
this workspace — both real members already hold passwords — is the wrong trade twice over.

## What actually holds the line

- **Agents cannot use the header path at all.** Unconditional, from
  [#29](https://github.com/moeindanesh/taskara/issues/29), and not covered by the flag: an agent has a
  credential of its own, and agent provenance is only worth something if it cannot be asserted by
  whoever knows a string that appears in every activity feed.
- **`TASKARA_EMAIL_HEADER_AUTH` exists and defaults on**, because shipped clients still depend on it.
  Flipping it off is what closes the path for humans too, and doing that fleet-wide is
  [its own effort](https://github.com/moeindanesh/taskara/issues/18) — explicitly out of scope on the
  agent-tracker map, which hardened the *agent's* credential rather than migrating every consumer.
- **Mattermost is unaffected either way.** `getMattermostActor` resolves its own actor behind the
  slash-command token and never reaches the header path, which is why its synthetic passwordless users
  keep working.

## The rows already in that state

None. A count found 3,748 human users of whom 3,746 held no password — and **3,744 of those were leaked
test fixtures** on a `manager-access.test` domain, stranded by a suite that deleted its workspaces but
not its users. They were never workspace members and could never have authenticated. The leak is fixed
and the rows are swept; the real workspace has two members and both hold passwords.

So the migration cost of this policy is zero, and always was — it just could not be known until somebody
ran the count.

## Status

Accepted. The policy is settled; the enforcement is a flag flip that waits on a consumer migration this
effort deliberately kept out of scope. Detail in `.scratch/SECURITY-agent-credential.md` (local,
gitignored), from issue [#43](https://github.com/moeindanesh/taskara/issues/43).
