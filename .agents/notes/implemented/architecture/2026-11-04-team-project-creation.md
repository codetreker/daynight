# Agent Note: Team Project Creation

Status: implemented

## Problem

Project creation must establish real ownership and a creator's independent
grant while Team membership and Team existence can change concurrently. A
browser or CLI can also submit a form after its authenticated identity changes.
Without a shared existence lock, deletion could leave an orphaned ownership row.

## Decision

Creation requires `expectedUserId` and checks it against the principal before
domain SQL. It accepts an optional target Team; absent a target, it uses the
caller's Personal Team. The writer locks the target Team and checks current
membership after the lock, then inserts Project, ownership and creator direct
admin grant in one transaction. Team deletion holds the same lock and checks
ownership in a separate Read Committed statement. The existing CLI and Web
creation paths bind requests and responses to the observed user. Unknown commits
remain unknown and are not automatically replayed; the Web result retains that
status while an identity-bound read shows the current directory.

The [auth design](../../../../docs/design/daynight-auth.md#数据与并发) owns
the transaction and error contract. The [Personal ownership decision](2026-11-04-personal-project-ownership.md)
owns initialization and inherited access; the [Team lifecycle decision](2026-11-04-team-lifecycle.md)
owns deletion and its existence check.

## Alternatives

**Check membership before taking the Team lock.** Membership or the Team could
change before the ownership write, allowing a stale admission or orphaned row.
The lock and fresh membership read bind the decision to the transaction.

## Consequences

Team members and administrators both create Projects with independent admin
grants. API callers that omit a Team create in Personal. The [CLI selection
decision](2026-11-05-cli-project-team-selection.md) governs its explicit and
default targets. Identity mismatch causes no domain writes; response loss cannot
establish whether a commit occurred.
