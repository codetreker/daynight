# Agent Note: Public Project Ownership and Access Sources

Status: implemented

## Problem

Project consumers need to distinguish its durable owner relationship from a
caller's current authority. Once real Team inheritance exists, a grant alone
cannot explain why a caller or participant has access. A roster and a role read
from different snapshots can also authorize controls using incompatible facts.
Existing derived Project records lack the owner relationship and cannot safely
be interpreted as complete current records.

## Decision

Every public intrinsic Project contains required `ownership:{teamId,version}`.
Create, list, graph, sync and cache projections use the same fields. GET Project
also returns fresh access from its resource read snapshot. GET /me reads and
validates the actual Personal relationship and returns a required personalTeam
reference; it does not initialize or repair data during a read.

ProjectAccess contains projectId, ownerTeam, ownership, effectiveRole, nullable
teamRole, nullable directGrant and canTransfer. TeamRef has an ID, personal or
ordinary kind and a nullable raw name. Personal names are null. The canonical
source query owns role merging; canTransfer depends only on owner Team admin.
Participants expose nullable inheritedFrom separately from their real direct
grant. Team inheritance does not create a writable grant observation.

Members returns items and actorAccess from one read snapshot. MembersPanel
publishes that access through the existing identity, project, generation and
observation-order fences. The independent profile reader still serves claim
display without becoming an authority source. The CLI roster facade validates
the complete envelope and retains its participant-array return value.

Resource codecs require these fields and preserve nested positive int64 versions
above 2^53. Project, graph/sync and roster decoders validate complete JSON
natively and share one source-field map per inspected object. Access and
participant roots have no protocol version; only their declared ownership and
grant subtrees receive version conversion. This avoids repeating source scans as
the projection expands. Opaque task properties keep their existing JSON semantics. Missing ownership, invalid
Personal references and inconsistent owner/source facts fail instead of receiving
defaults. The [auth design](../../../../docs/design/daynight-auth.md) owns the
public field definitions and snapshot boundaries.

Introducing ownership used IndexedDB schema 5 to rebuild earlier derived
formats and rotate user fences. The
[profile-reuse decision](../bug-fix/2026-11-04-task-view-request-reuse.md) adds a
separate profiles store in schema 6; upgrading compatible schema-5 records
preserves task data and fences, while upgrades from 1 through 4 still rebuild.
Within one epoch, Project settings and ownership merge independently by their own
versions; equal ownership versions must identify the same Team. A new epoch
snapshot replaces the Project completely: database restoration can legitimately
restore lower versions or a different owner from the previous history. Access,
Team names and participant snapshots remain in memory. Reusable assignee profile
content is persisted separately without access or inheritance metadata. The
[cache design](../../../../docs/design/daynight-task-sync.md) owns merge,
publication and recovery details.

## Alternatives

**Accept old Project shapes and synthesize an owner.** A null owner or version 0
would describe no actual relationship and let stale records pass current shape
validation. Rebuilding replaceable data avoids a second runtime interpretation.

**Use a separate access read for member management.** Independently fresh reads
can still observe different committed states. Returning the admission result
with the roster preserves one snapshot and reuses the established publication
fences without another authority owner.

**Merge the whole Project using settings.version or updatedAt.** Ownership and
settings change independently. A later settings observation can contain an older
owner, or the reverse. Independent versions preserve each relationship without
inventing a shared ordering token.

**Scan the same object separately for each resource field.** Each exposed field
would repeat a complete source scan. Sharing its validated field map retains
explicit version paths while reducing repeated work.

## Consequences

The protocol producer and current CLI/Web consumers switch together. An old
client may reject the complete source fields; deployment must pair the service
and matching consumers. Upgrading a pre-ownership cache costs a complete task snapshot; the later
profile-only upgrade preserves compatible records. Actor authority stays outside
durable records.

The [Team lifecycle decision](2026-11-04-team-lifecycle.md) owns ordinary Team
metadata and empty deletion separately from these public Project projections.
Member management and new Team commands/pages remain separate capabilities.
The [transfer decision](2026-11-04-project-transfer.md) owns the versioned
ownership mutation and its receipt. They can reuse real ownership and independent grant facts without
changing the cache's permission boundary. The
[Personal ownership decision](2026-11-04-personal-project-ownership.md),
[access projection](2026-11-03-project-access-projection.md) and
[participant projection](2026-11-04-project-participant-projection.md) retain
their storage, freshness, identity and mutation rationale.
