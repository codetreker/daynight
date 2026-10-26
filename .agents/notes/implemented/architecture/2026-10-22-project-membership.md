# Agent Note: Project Membership Transactions

Status: implemented

## Problem

Stable local identity does not identify which projects a person may access.
Membership changes, invitation acceptance and concurrent administrator removal
must make one decision against current project state. A stale observation must
also remain stale after a member is removed and later joins again.

## Decision

The membership foundation implements the project policy in the adopted
[authentication architecture](../../../../docs/design/daynight-auth.md).
Admin and member share existing resource read/write authority; admins manage
membership and project invitations. Existing production resource entry points
remain unchanged until coordinated activation. Callable membership handlers use
the existing authentication module rather than a second identity mechanism.

Read admission checks the current member within the existing read snapshot.
Writes use the existing project row lock before checking actor authority,
observed target version and administrator count. The same project lock orders
membership mutations and invitation acceptance. Accessible project SQL filters
by membership before cursor and LIMIT; it never filters an already fetched page.
Private project creation and its first admin membership commit together.

Member observation versions come from one PostgreSQL bigint sequence on insertion
and real role changes. They are opaque, positive and noncontiguous; a no-op keeps
its version. Removal and rejoining receive a new observation version, so an old
page cannot change the recreated membership. Task versions remain independent.

Project invitations last seven days, grant member authority once, and store only
a hash of a random secret. They belong to the project; the creator's later role
change does not revoke them. Admins can revoke pending invitations. Inspection
reveals only minimal project information to an authenticated holder. Acceptance
locks the project then the invitation, inserts membership and consumes the invite
atomically. Existing members neither upgrade nor consume an available invite.
Expired, consumed and revoked invitations share one unavailable response.

`RequireProjectRead` and `RequireProjectWrite` compose inside the caller's snapshot
or project write transaction. The initial `Projects.CreatePrivate` and
`ListAccessible` staging aliases preserved existing entry points while the module
was reviewed separately. The [activation decision](2026-10-22-authentication-activation.md)
now makes ordinary Create/List principal-aware, removes those aliases and mounts
`NewMembershipRoutes(...).RegisterRoutes` in the mandatory composition. The
[identity foundation](2026-10-22-identity-credentials.md) supplies session/PAT
principals. Existing projects receive no automatic membership.

## Alternatives

**Check permission before opening an unrelated business transaction.** A role
could change between the check and mutation. Checking inside the existing project
transaction preserves one authorization decision and the business write.

**Lock only the member being modified.** Two admins could each observe another
admin and both leave. The existing project row serializes their checks without
introducing another project lock mechanism.

**Reset each membership version on insert.** A removed and rejoined member could
again match an earlier observed version. A database sequence preserves the
existing positive-int64 request contract without tombstones or generation fields.

**Automatically cancel invitations when their creator leaves.** This makes
project invitations depend on an unrelated membership lifecycle. The adopted
policy gives the project explicit expiry, one-time consumption and revocation.

## Consequences

The schema adds two tables and a membership version sequence without foreign
keys. Explicit service transactions own association and policy checks. Empty
membership on existing projects naturally denies access through authorized
queries; manual assignment remains separate.

Independent PostgreSQL and authenticated-handler validation preceded mounting,
preserving that original sequencing rationale. Production composition, CLI and
Web are now connected by the activation decision; actual integrated results
remain source-bound evidence. Trusted same-origin HTML retains the
[adopted attachment boundary](../../archived/architecture/2026-10-21-task-attachment-storage-design.md), and
file IO admission retains K1 and the existing short-transaction lifetime.
