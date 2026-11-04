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

Stored `ProjectGrant` records own project/user IDs, role, the real observation
version and membership timestamps. `ProjectMember` is a joined response projection
with a named grant and nullable profile fields. It is returned by roster reads,
grant mutations and invitation acceptance; HTTP flattens it into the existing
member JSON. Explicit direct-relation reads determine invitation no-ops and
versioned mutation targets without extra profile queries.

Read admission returns `ProjectAccess` within the existing read snapshot. This
computed projection has project/user IDs, the current role and an optional actual
direct grant. It has no independent writable version or storage timestamps; the
embedded grant retains its own facts. Point admission and accessible-project filtering
use the same canonical direct-authorization source. Resource services and Worker
non-owner administrator checks consume access; claim ownership and task-assignee
requirements keep their separate rules. The [actor access projection](2026-11-03-project-access-projection.md)
owns public reads, same-snapshot task-sync publication and client freshness.

Writes use the existing project row lock before checking actor access, the target
grant's observed version and administrator count. The same project lock orders
grant mutations and invitation acceptance. Accessible project SQL filters before
cursor and LIMIT; it never filters an already fetched page. Private project
creation and its first admin grant commit together. This separation preserves
the current direct-only policy, physical tables and sequence, HTTP responses and
last-administrator protection.

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

**Use the joined member record as the authorization result.** This couples
resource admission to profile projection and exposes a writable grant version as
though it described the computed access decision. Separate access and grant
values give these consumers explicit responsibilities while preserving the
existing response query and wire format.

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
