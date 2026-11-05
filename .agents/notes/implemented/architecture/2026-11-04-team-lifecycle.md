# Agent Note: Team Lifecycle and Existence Locks

Status: implemented

## Problem

A Team's metadata and the caller's current membership are different facts.
Ordinary Team management must preserve raw names, independent observation
versions and current authority without expanding the minimal Team reference
embedded in Projects. Deleting a Team while a Project acquires ownership would
otherwise leave an orphaned relationship in the existing schema without foreign
keys. A lost commit response also cannot safely be treated as a rejected write.

## Decision

The Team service provides atomic ordinary Team creation with a real creator
admin, membership-filtered list/detail reads, versioned rename and empty
deletion. Personal Teams reject rename and deletion. The stable `TeamRef` keeps
its ID, kind and nullable name; full Team responses carry metadata version and
timestamps with the caller's real membership and its own version. No role or
version is synthesized from effective Project authority.

The actor guard compares `expectedUserId` with the admitted principal before
any domain SQL. Names are valid Unicode without NUL and contain at least one
non-White_Space character; raw text and surrounding whitespace remain intact,
and duplicates are allowed. The exact metadata version is checked before a
same-name no-op. Actual rename advances only Team metadata. Delete also checks
the observed raw name and returns only the deleted Team ID and `deleted:true`.

`WriteTeam` uses Read Committed and locks the real Team row `FOR UPDATE` before
checking current membership and metadata. Deletion then uses a separate
nonlocking ownership `EXISTS` statement and deletes members and Team only when
that fresh snapshot is empty. Ownership writers lock and recheck the same Team
before creating a reference. These operations serialize on a real existence
row without acquiring existing Project, Task or Thread head locks. The
[auth design](../../../../docs/design/daynight-auth.md#team-元数据与生命周期事务)
owns the detailed lock and completion rules.

The existing transaction completion facts distinguish callback refusal,
confirmed rollback, commit and unknown completion. A successful resource is
returned only after confirmed commit. Unconfirmed COMMIT produces
`write_outcome_unknown`; cleanup failures retain internal-error priority and
the cause chain. No persistent commit ledger or automatic write replay is
introduced. Reads can establish current state but cannot recover a lost
submission receipt.

The [Personal ownership decision](2026-11-04-personal-project-ownership.md)
retains initialization, migration and access-source ownership. The
[public ownership decision](2026-11-04-public-project-ownership.md) retains the
minimal embedded Team reference and the Project cache boundary. The
[CLI lifecycle decision](2026-11-04-cli-team-lifecycle.md) owns terminal
confirmation and receipt handling. The
[auth requirements](../../../../docs/spec/daynight-auth.md#team-生命周期)
own the lifecycle's public fields and refusals.

## Alternatives

**Expand the embedded Team reference into a management resource.** Project
ownership displays require only ID, kind and name. Attaching the caller's
membership and mutable metadata versions there would broaden unrelated
Project responses and couple their consumers to Team management. A full Team
resource keeps those facts at their own authenticated endpoint.

**Check ownership in the statement that first locks the Team.** Under Read
Committed, that statement's snapshot can precede a lock wait. A Project writer
may commit an ownership reference before deletion acquires the Team lock, while
the original statement still sees an empty set. A separate statement after the
lock observes that commit without taking Project locks.

## Consequences

Metadata changes and deletion have a stable current-authority and version
boundary. Raw names remain display data, while ID and version establish the
resource and observation. Existence locking preserves ownership integrity
without changing the schema's foreign-key policy or reversing resource lock
orders.

The [membership management decision](2026-11-04-team-membership-management.md)
owns directory access, role changes and departures. Team CLI commands and Team
pages retain their own capability boundaries. The [Team invitation decision](2026-11-04-team-invitations.md)
adds invitation children and their transactional cleanup. The
[transfer decision](2026-11-04-project-transfer.md)
uses the same Team existence lock for Project ownership changes. Any new ownership writer must
participate in the Team existence lock; any new Team-owned child records must
be included in deletion's transaction. Transaction and response loss remain
visible to callers and require explicit fresh decisions after reconciliation.
