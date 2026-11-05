# Agent Note: Ownership-grouped Session Archive Layout

Status: implemented

## Problem

The direct `session-archives/<sessionId>/` layout puts every execution's directory
in one bucket level. It does not express the ownership already recorded by the
Session registry, and its directory size grows with all archived executions on
the instance. Task Sessions have project ownership, while independent Test and
Bot Sessions have user ownership. Changing the layout must preserve immutable
archive bytes and receipts, existing metadata, and cleanup of objects whose
metadata transaction never committed. Service startup must establish the layout
before serving requests and avoid rescanning completed storage on every restart.

## Decision

The Session archive address owner derives these fixed paths:

```text
session-archives/projects/<projectId>/<sessionId[:2]>/<sessionId>/<sha256>.json
session-archives/users/<ownerUserId>/<sessionId[:2]>/<sessionId>/<sha256>.json
```

Task Web and Herdr Sessions use `projects`; independent Test and Bot Sessions
use `users`. Canonical nonzero UUIDs precede prefix construction. The complete
Session UUID remains the namespace identity; its first two hexadecimal characters
provide at most 256 shard names per owner. The explicit ownership kinds separate
project and user UUID domains, including equal UUID values. The Session owns its
archive and cleanup independently of a later task claim.

`internal/sessionarchive.Namespace` shares the rule across Web and Herdr uploads,
metadata validation, restricted cleanup and startup migration. Generic storage
operations still accept bucket/path. `DeleteSessionArchives` accepts the typed,
validated namespace and rejects arbitrary prefixes. It removes that Session's
whole directory, including unregistered objects, while preserving other Sessions
under the same owner or shard. Legacy direct Session directories prevent cleanup
from reporting success. Traversal rejects symlinks and unsafe aliases, and failed
deletion keeps its original retryable responsibility.

PostgreSQL retains `session_archives.object_path`. A ready manifest must match
the path derived from the original Session's ownership and digest. Runtime
metadata reads reject an old or mismatched location with `source_corrupt`;
ordinary requests neither move files nor select a legacy location. Archive
protocols, public URLs, SHA-256 values, raw downloaded bytes and immutable terminal
receipts do not change.

Normal startup initializes local storage, opens and migrates the SQL store, then
calls `EnsureSessionArchiveLayout` before listening or composing HTTP handlers.
Database/schema startup and listener startup each receive a bounded
`DAYNIGHT_STARTUP_TIMEOUT` phase. Archive conversion uses the caller's cancellation
context without that short phase timeout because its work depends on stored bytes.
Old application versions and direct database/file writers must remain stopped
through the first conversion. Concurrent new-version startup calls serialize on
a dedicated PostgreSQL advisory lock; none serves HTTP before layout completion.

Under that lock, startup first checks the storage-root
`.session-archive-layout.json` completion marker. It is a regular, nonsymlink
file of at most 128 bytes containing only `{"version":1}`. Truncated, invalid,
duplicate or extra fields and unsupported versions fail startup. The root is
synchronized before an existing marker is trusted. A valid marker skips directory
and database inventories and returns `AlreadyApplied=true` with zero counts.
An empty installation publishes the same marker after verification.

Without the marker, startup validates the existing registry and archive metadata,
known ownership, exact old or new paths, complete directory inventories and
registered lengths/digests, body schema and original identity. Unknown ownership,
missing or corrupt registered files, symlinks, special files and conflicting
source/target namespaces are errors. Whole known Session directories move by
same-filesystem rename, followed by directory synchronization before that
Session's new object path commits. A later startup verifies a destination already
moved while SQL still records the old location and finishes its metadata update.
The reserved `projects` and `users` roots remain distinct from legacy UUID roots,
so retry does not require a separate per-operation manifest.

Only after every directory and metadata update completes is the marker written
through an owned temporary file, file synchronization, rename and root
synchronization. Failures prevent readiness and preserve partial conversion for
the next startup. A rename followed by a failed root barrier can leave marker
bytes; the next startup must complete its own root barrier before trusting them.
Temporary crash residue does not establish completion. The marker is part of the
storage-root backup and must remain paired with the corresponding database and
archive tree. It is a layout-version record, not a database identity ledger or a
replacement for per-read archive integrity checks.

The [attachment layout decision](2026-10-24-project-sharded-attachment-layout.md)
owns the precedent for business-owned address derivation and UUID sharding. Its
task-specific offline migration remains independent: attachments retain logical
paths and have different source/target collision conditions. This decision
replaces the direct server directory arrangement within the
[completed archive decision](2026-10-30-session-file-archives.md); that decision's
Controller ownership, final-file format, limits and lifecycle remain applicable.
The [Bot deletion decision](2026-11-04-bot-history-deletion.md) retains the whole
Session orphan-cleanup guarantee under the grouped namespace.

The [Session design](../../../../docs/design/task-session-protocol.md#服务端归档布局与迁移)
owns the detailed layout and startup rules. The
[deployment guide](../../../../deployment/localhost/README.md#session-archive-layout-upgrade)
owns normal upgrade, startup diagnostics and paired restore.

## Alternatives

**Keep the direct Session directory.** It leaves all instance-wide execution
directories at one bucket level and omits their recorded ownership.

**Shard only by Session UUID.** It bounds the immediate bucket entries but still
mixes all projects and independent owners in the same shards. Explicit ownership
grouping follows the existing attachment arrangement without changing Session
identity or introducing another lookup key.

**Use project directories for every Session.** Independent Test and Bot Sessions
have no project. Inventing one would change their domain ownership; user grouping
uses their actual owner and keeps those identities distinct from Task Sessions.

**Reuse the attachment migration implementation.** It assumes task-relative
metadata and task-only source directories, and its whole-bucket staging handles
project/task UUID collisions. Archive conversion has persisted physical paths
and reserved target kinds, so copying its operation ledger adds unrelated state.

**Require a separate offline archive migration command.** It makes service
correctness depend on an operator invoking another entry point. Startup owns
conversion and a persistent completion marker so ordinary restart enforces the
layout before serving, while completed roots avoid repeat scans.

**Read both layouts or move files during requests.** Uploads, downloads and Bot
deletion would depend on upgrade progress. Completing migration before listening
lets runtime enforce one address and keeps conversion out of request handling.

## Consequences

The store is organized by existing ownership and bounded Session UUID shards;
clients and archive receipts keep their identity. First startup may require full
content reads and a longer wait; later startup trusts the durable version marker.
Invalid markers or conversion failures keep the service unavailable with explicit
diagnostics. Cancellation and restart can finish a known file-before-SQL
interruption without exposing an intermediate layout through HTTP.

Files, the completion marker and PostgreSQL metadata require a paired backup.
Migration does not repair pre-existing cross-store inconsistencies. Restoring only
the database or only storage can invalidate the marker's completion claim.
Rollback uses the corresponding prior image and matching pre-migration SQL/files
before writers resume. Once new writes occur, restoring the old pair would lose
them and requires a separate preservation decision. Group directories remain
storage organization, not independent OS sandboxes or authorization grants.
Automatic archive retention, live incremental backup and an object-store product
remain outside this decision.
