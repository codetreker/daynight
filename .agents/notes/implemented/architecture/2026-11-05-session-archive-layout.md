# Agent Note: Ownership-grouped Session Archive Layout

Status: implemented

## Problem

The direct `session-archives/<sessionId>/` layout puts every execution's directory
in one bucket level. It does not express the ownership already recorded by the
Session registry, and its directory size grows with all archived executions on
the instance. Task Sessions have project ownership, while independent Test and
Bot Sessions have user ownership. Changing the layout must preserve immutable
archive bytes and receipts, existing metadata, and cleanup of objects whose
metadata transaction never committed.

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
project and user UUID domains, including equal UUID values. There is no task
directory between the owner and Session because the Session owns its archive and
cleanup independently of a later task claim.

`internal/sessionarchive.Namespace` shares the rule across Web and Herdr uploads,
metadata validation, restricted cleanup and offline maintenance. Generic storage
operations still accept bucket/path. `DeleteSessionArchives` accepts the typed,
validated namespace and rejects arbitrary prefixes. It removes that Session's
whole directory, including unregistered objects, while preserving other Sessions
under the same owner or shard. Legacy direct Session directories prevent cleanup
from reporting success before migration. Directory traversal rejects symlinks and
unsafe aliases, and failed deletion keeps its original retryable responsibility.

PostgreSQL retains `session_archives.object_path`. A ready manifest must match
the path derived from the original Session's ownership and digest. Runtime
metadata reads reject an old or mismatched location with `source_corrupt` and a
migration diagnostic; ordinary requests neither move files nor select a legacy
location. Archive protocols, public URLs, SHA-256 values, raw downloaded bytes
and immutable terminal receipts do not change.

The same executable exposes `migrate-session-archive-layout`. All application,
database and file writers must remain stopped, with a matching database/storage
backup and the prior executable or image retained. A PostgreSQL advisory lock
serializes maintenance calls only. The command reads the existing registry and
archive metadata without starting HTTP, authentication or schema migration. It
validates known ownership, exact old or new object paths, complete directory
inventories and registered lengths/digests, body schema and original identity
before conversion. Unknown ownership,
missing or corrupt registered files, symlinks, special files and conflicting
source/target namespaces are errors.

Maintenance moves whole known Session directories by same-filesystem rename,
then synchronizes directory entries before committing that Session's new object
path. A retry verifies a destination already moved while SQL still records the
old location and finishes its metadata update. Completed conversion can be
verified again without moving files. Reserved `projects` and `users` names cannot
be legacy UUID roots, so the source and target locations remain distinguishable
without a separate persistent operation manifest. Errors preserve partial
conversion for an explicit repeat while writers remain stopped; no merge,
overwrite or automatic rollback guesses a valid state.

The [attachment layout decision](2026-10-24-project-sharded-attachment-layout.md)
owns the precedent for business-owned address derivation and UUID sharding. Its
task-specific migration ledger is not a shared archive mechanism: attachments
retain logical paths, whereas archives persist physical object paths, and their
source namespace has different collision conditions. This decision replaces the
direct server directory arrangement within the
[completed archive decision](2026-10-30-session-file-archives.md); that decision's
Controller ownership, final-file format, limits and lifecycle remain applicable.
The [Bot deletion decision](2026-11-04-bot-history-deletion.md) retains the whole
Session orphan-cleanup guarantee under the grouped namespace.

The [Session design](../../../../docs/design/task-session-protocol.md#服务端归档布局与迁移)
owns the detailed layout and conversion rules. The
[upgrade runbook](../../../../deployment/localhost/README.md#session-archive-layout-upgrade)
owns stopped-write operation, verification and paired restore.

## Alternatives

**Keep the direct Session directory.** It preserves existing physical locations
but leaves all instance-wide execution directories at one bucket level and omits
their recorded ownership.

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
and reserved target kinds, so copying that ledger would add operation state
without resolving the archive-specific metadata update.

**Read both layouts or move files during requests.** It would make uploads,
downloads and Bot deletion depend on upgrade progress. Explicit maintenance
allows runtime to enforce one address and exposes incomplete conversion before
writers reopen.

## Consequences

The store is organized by existing ownership and bounded Session UUID shards;
clients and archive receipts keep their identity. Files and PostgreSQL metadata
still require a paired backup, and maintenance does not repair pre-existing
cross-store inconsistencies. Upgrade requires a stopped-write window and full
reads to verify stored content. Rerunning maintenance can finish a known
file-before-SQL interruption, but restoring arbitrary filesystem damage still
requires the retained pair.

Rollback uses the corresponding prior image and matching pre-migration SQL/files
before writers resume. Once new writes occur, restoring the old pair would lose
them and requires a separate preservation decision. Group directories are storage
organization, not independent OS sandboxes or new authorization grants. Automatic
archive retention, live incremental backup and an object-store product remain
outside this decision.
