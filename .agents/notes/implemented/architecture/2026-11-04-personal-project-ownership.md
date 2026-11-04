# Agent Note: Personal Project Ownership and Inherited Access

Status: implemented

## Problem

A direct Project grant records an independent collaboration decision. It cannot
also represent a user's Personal project container or a Team's current members.
Copying inherited members into grants would destroy that distinction and require
cross-project writes whenever a Team relationship changes. A partially activated
resolver would also deny access inconsistently as soon as an administrator
removes an owner's direct grant.

## Decision

Every user has one Personal Team with a real owner admin member. Every Project
has one real `project_ownership` row. The internal Project aggregate includes its
Team ID, ownership version and update time; a missing required ownership row is
an integrity failure. Public Project and account DTOs expose these real relationships under the
[public ownership decision](2026-11-04-public-project-ownership.md). The [auth design](../../../../docs/design/daynight-auth.md) owns
storage, login, writer and migration details.

Migration 032 creates `teams`, `team_members` and `project_ownership` and renames
`project_members`, its sequence, constraints and index in place to
`project_grants`. It preserves grant rows, times, versions and the sequence's
actual high-water state, including `is_called`. Deleted high versions cannot be
reconstructed from live `MAX(version)`. All existing users, including PAT-only
users, receive Personal Teams. Each existing Project belongs to the Personal
Team of its earliest-joined current admin, using `created_at,user_id` ordering.
Invalid references or a Project without a current admin fail the whole numbered
migration. SQL, transforms and migration ledger remain one transaction.

Canonical user UPSERT, Personal initialization and session creation share the
login transaction. A newly inserted Team receives its owner admin there;
repeated and concurrent logins reuse the existing Team and validate its owner
relationship. Authentication does not repair broken Personal state. The active
Project creator locks and validates the real Personal Team, then inserts Project,
ownership and creator direct admin grant in one transaction.

The canonical access owner computes `max(owner Team role, direct grant role)`
under `none < member < admin`. Actor admission, lists, participant/assignee
queries, Worker snapshots and Session relay consume this owner. Participants are
the union of real source identities, with one effective role per user and a null
direct grant for inherited-only access. Raw identities survive profile joins so
missing canonical users remain visible integrity failures. Team changes do not
rewrite grants. Effective administrators may remove or demote the last direct
administrator; that grant policy no longer stands in for ownership.

Thread strong admission locks Task, credential, real ownership, existing owner
Team member, existing direct grant and head in that order. It reads current
source facts after waits and keeps ownership and actual source rows stable
through commit. A later nonlocking read cannot admit a writer solely through a
concurrently inserted source that was never locked. It never acquires Project after Task. Ordinary Task and Session
admission retain their nonlocking source reads and resource-specific rechecks.
The [Thread design](../../../../docs/design/daynight-task-thread.md) owns the full
transaction and outcome rules.

Existing grant mutation identities, exact versions and unknown-result rules
remain. Web edits the real grant without a last-direct-admin restriction. After
confirmed self-removal it revalidates current access and leaves the Project only
after authoritative withdrawal; inherited access keeps the page available.
Failed reconciliation remains a visible read retry and does not repeat the
write.

This decision replaces the direct-only and last-project-admin portions of the
[membership foundation](2026-10-22-project-membership.md). The
[participant](2026-11-04-project-participant-projection.md),
[access projection](2026-11-03-project-access-projection.md) and
[Thread storage](2026-11-03-task-thread-storage.md) decisions retain their
independent DTO, freshness and discussion guarantees.

## Alternatives

**Activate inheritance one runtime family at a time.** Personal-only data does
not isolate the transition: another existing Project admin can remove the
owner's grant immediately. A partial rollout would let the same user read one
resource while being denied another. Existing consumers first share permanent
access seams, then real sources activate together.

**Copy Team members into Project grants or protect the owner's grant.** Copies
would need cleanup across every Project and would erase independent grant
intent. Protecting a grant introduces a temporary Project policy that still
cannot express inherited authority. Real ownership and source calculation keep
those facts separate.

**Reset the renamed sequence to the largest surviving grant version.** A deleted
row can have allocated a larger version. Reusing that observation could let an
old PATCH or DELETE target a recreated grant. Renaming the original sequence
preserves the full allocation history without a tombstone mechanism.

**Infer an owner for damaged historical projects.** The stored data establishes
current administrators and their joining times, but not an original creator.
The confirmed rule uses those actual facts. A project with no current admin
requires data repair before migration and cannot receive an arbitrary owner.

**Include ordinary Team management and complete public source fields.** Those
features have their own callers and lifecycle contracts. The existing public
access shape already represents inherited-only authority with a nullable grant.
Keeping real internal ownership and one canonical resolver lets later protocol
and management work add actual fields and operations without a compatibility
view, placeholder version or runtime fallback.

## Consequences

Independent grants remain stable when their inherited context changes. All
prepared resource families observe the same role semantics, and existing users
can authenticate with old PATs after migration without a login-dependent
backfill. Integrity failures stop migration or the affected operation rather
than becoming empty results or guessed authority.

The table rename and changed authorization semantics require stopping old
writers and switching to the matching application after migration. An old binary
cannot serve the new schema. A failed uncommitted migration rolls back; recovery
after commit requires a forward repair or a paired database/file backup restored
while writers remain stopped.

Ordinary Team CRUD, Team invitations, transfer, new CLI commands and Team pages
remain separate capabilities. Public ownership/source expansion must update its
actual strict consumers and derived cache format together. These additions must
retain independent grant facts and the established nonreversing lock order.
