# Agent Note: Team Project Repository Uniqueness

Status: implemented

## Problem

A Team can otherwise own multiple active Projects for equivalent repository
addresses. Client-side discovery cannot protect an empty slot against concurrent
creation or transfer, and a private conflicting Project must not be disclosed to
the caller. Existing addresses and historical data must survive activation.

## Decision

The shared Project core enforces at most one active repository identity per owner
Team, including Personal Teams. Creation and actual transfer use the existing
Team locks and a separate Read Committed occupancy query after admission and
version checks. The DAO joins ownership to active Projects through EXISTS and
does not lock other Project rows. Transfer keeps Project, ownership, then ordered
Team locks; refusal precedes ownership and GitHub App integration effects.

Projects retain the original address and a nullable, byte-compared persistent
identity. Transactional migration 083 freezes the existing RepositoryIdentity
rules in `repositoryidentity/v1`, checksums that source and its `migration083`
transform, backfills in batches and rejects same-Team active duplicates before
commit. The transform and original SQL share the version directory
`postgres/schema/migrations/083/`; a separate registration file exposes the SQL
while preserving the frozen transformation and SQL bytes. The
[PostgreSQL ownership decision](2026-11-05-server-postgres-ownership.md) owns the
unified schema/history layout and checksum-preserving relocation. The repository
transform was assigned version 083 before publication because the Worker tag
filter had already taken version 082. Its version-specific diagnostics give the
083 transform a new checksum; the identity rules and SQL algorithm are unchanged.
The published Worker migration and ledger checksum remain intact. Unparseable
historical addresses keep NULL identities and redacted diagnostics; duplicate
active raw values within a Team also abort migration.
Actual transfer of NULL identities is refused, while reads, deletion and
same-Team no-ops remain available.

The [server design](../../../../docs/design/daynight-server.md#team-仓库占用)
owns the mechanism and [server guide](../../../../packages/daynight-server/README.md#team-repository-uniqueness-upgrade)
owns the stopped-writer upgrade and recovery procedure. This decision supersedes
the archived [client discovery decision](../../archived/bug-fix/2026-10-21-project-create-repository-discovery.md)'s
deferral of service uniqueness and extends the [Project boundary decision](2026-11-05-server-project-boundaries.md).
The [MCP Team-scoped reuse decision](2026-11-18-mcp-team-repository-reuse.md) applies the target Team to registration lookup. Read-only discovery retains its full-visible-project scope.

## Alternatives

**Rely on client preflight or an unlocked transaction query.** Two writers can
both observe an empty slot, and transfer has the same race. The Team lock covers
the empty set and gives the subsequent statement a fresh committed view.

**Store Team, identity and active status in a separate unique-index table.** This
can enforce occupancy, but duplicates mutable ownership/deletion state and adds
maintenance to every transfer and soft delete. Existing Team locks already
serialize the required writes without that second state machine.

**Normalize all candidate addresses while holding the Team lock.** Parsing an
entire Team repeatedly increases lock duration and repeats version-sensitive
work. Persisting a versioned identity moves old-data handling into migration.

**Make repository identity globally unique.** Different Teams legitimately own
their own Project, grants and retained history for the same repository. The
constraint must follow ownership, rather than global visibility or URL text.

## Consequences

Deletion and transfer out release occupancy through their existing authoritative
facts. Equivalent HTTPS/SSH/SCP inputs contend for the same slot while path case
and supported transport distinctions remain meaningful. No full-address B-tree
index is required, so valid maximum-length addresses remain supported.

An unknown legacy identity cannot be safely moved to a different Team. Operators
receive IDs and error classes for repair decisions without losing original data.
Future identity semantics require a new migration and duplicate validation. Old
writers must stop before activation; after new writes resume, recovery proceeds
forward. Unknown commits retain the original completion semantics and cannot be
replayed merely because later reads appear unchanged.
