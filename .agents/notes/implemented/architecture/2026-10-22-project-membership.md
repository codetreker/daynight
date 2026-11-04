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
membership and project invitations. The original foundation retained production resource entry points until
coordinated activation. Callable membership handlers use
the existing authentication module rather than a second identity mechanism.

Stored `ProjectGrant` records own project/user IDs, role, the real observation
version and membership timestamps. The [participant projection](2026-11-04-project-participant-projection.md)
owns public roster values: a canonical user ID, required profile object with
nullable fields, effective role and optional real direct grant. Role PATCH
returns the stored grant; deletion retains its empty success. `ProjectMember`
remains the joined direct-relation read used by versioned target checks and
existing invitation/runtime callers. Invitation HTTP results preserve their
current flat member DTO. These readers do not replace computed admission.

Read admission returns `ProjectAccess` within the existing read snapshot. This
computed projection has project/user IDs, the current role and an optional actual
direct grant. It has no independent writable version or storage timestamps; the
embedded grant retains its own facts. Point admission and accessible-project filtering
use the same canonical dual-source relation. The [Personal ownership decision](2026-11-04-personal-project-ownership.md)
activates the maximum of owner Team role and direct grant role without copying
Team membership into grants. Resource services, new task
assignment targets and Worker non-owner administrator checks consume access.
Task-assignee catalogues and bounded resolution use that source's raw identities
for access qualification while retaining their separate profile-integrity and
historical-reference rules. Responsibility and claim ownership remain distinct;
the [assignment decision](2026-11-03-task-assignment-foundation.md) owns those
rules. The [actor access projection](2026-11-03-project-access-projection.md)
owns public reads, same-snapshot task-sync publication and client freshness.

Web and Herdr Session admission use `ReadProjectAccess` through the relay's
shared `member()` wrapper in their existing raw transactions. Credential checks
remain separate; the canonical statement supplies the role without holding grant
row locks until commit. Session paths have different Task/Session lock orders,
so Thread's stronger authorization locks cannot be inserted into them. Original
requesters are reauthorized at dispatch, online content is rechecked after network
waits, and browser channels recheck every 250ms. Owner/controller restrictions and
personal TestSession access remain independent of project roles. The
[Session design](../../../../docs/design/task-session-protocol.md#relay-与恢复)
owns these resource-specific rules. Missing access maps to the existing refusal;
other canonical query errors retain their causes.

Thread consumes `LockProjectAuthorization` from the same canonical storage
owner. This strong primitive locks real ownership, then existing owner Team member
and direct grant rows through commit, and merges their current facts after waits.
The caller acquires Task and credential share locks first; no Project row lock
or profile read is introduced. Inherited-only admission has no direct grant.
Ordinary point reads and Session admission retain their existing nonlocking
behavior. The [Thread decision](2026-11-03-task-thread-storage.md)
owns its stronger lock lifetime, transaction outcome and cancellation rules.

Role and removal inputs bind the reviewed `expectedUserId` to the authenticated
principal before domain SQL. A mismatch is an explicit 409; no project lookup or
authorization write starts. Admitted writes use the existing project row lock
before checking actor access and the target grant's observed version. The same
project lock orders grant mutations and invitation acceptance. Accessible project SQL filters before
cursor and LIMIT; it never filters an already fetched page. Private project
creation commits real Personal ownership and its first direct admin grant
together. The original foundation kept direct-only policy and last-administrator
protection while consumers were prepared; the Personal ownership decision
replaces those policies and renames the original table and sequence in place.
Invitation responses retain their current contract. The
[grant management decision](2026-11-04-project-grant-management.md) adds explicit
creation preconditions and post-mutation actor receipts while preserving the
legacy role and removal responses.

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
principals. The original foundation did not assign existing projects
automatically; the Personal ownership migration now assigns every valid Project using its earliest-
joined current administrator and fails rather than guessing for zero-admin data.

## Alternatives

**Keep private membership SQL in the Session relay.** This makes Session
admission a separate policy owner that can diverge from ordinary resource access.
The canonical reader already accepts a raw transaction, so sharing it does not
require changing Session transaction ownership or adding a new abstraction.

**Use the joined member record as the authorization result.** This couples
resource admission to profile projection and exposes a writable grant version as
though it described the computed access decision. Separate access and grant
values originally gave these consumers explicit responsibilities while
preserving the initial wire format. The participant decision now separates the
roster and role-write DTOs while preserving current invitation consumers.

**Check permission before opening an unrelated business transaction.** A role
could change between the check and mutation. Checking inside the existing project
transaction preserves one authorization decision and the business write.

**Lock only the member being modified.** In the original direct-only policy,
two admins could each observe another admin and both leave. The Project lock
serialized that check. It still serializes current grant and invitation writes,
while real ownership now permits the final direct admin to leave.

**Reset each membership version on insert.** A removed and rejoined member could
again match an earlier observed version. A database sequence preserves the
existing positive-int64 request contract without tombstones or generation fields.

**Automatically cancel invitations when their creator leaves.** This makes
project invitations depend on an unrelated membership lifecycle. The adopted
policy gives the project explicit expiry, one-time consumption and revocation.

## Consequences

The foundation added two tables and a membership version sequence without
foreign keys. Explicit service transactions continue to own association and
policy checks. The Personal ownership decision supersedes its initial empty-
legacy-project behavior and physical member naming while preserving grant
observations and invitation identity.

Independent PostgreSQL and authenticated-handler validation preceded mounting,
preserving that original sequencing rationale. Production composition, CLI and
Web are now connected by the activation decision; actual integrated results
remain source-bound evidence. Trusted same-origin HTML retains the
[adopted attachment boundary](../../archived/architecture/2026-10-21-task-attachment-storage-design.md), and
file IO admission retains K1 and the existing short-transaction lifetime.
