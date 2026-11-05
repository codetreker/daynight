# Agent Note: Ownership-grouped Session Archive Layout

Status: implemented

## Problem

The direct `session-archives/<sessionId>/` layout puts every execution directory
in one bucket level. It omits the ownership already recorded by the Session
registry, and the directory size grows with all archived executions on an
instance. Task Sessions belong to projects; independent Test and Bot Sessions
belong to users. Their physical directories need ownership grouping and bounded
shards while retaining existing archive API behavior.

## Decision

New archive objects use these paths:

```text
session-archives/projects/<projectId>/<sessionId[:2]>/<sessionId>/<sha256>.json
session-archives/users/<ownerUserId>/<sessionId[:2]>/<sessionId>/<sha256>.json
```

Task Web and Herdr archives use `projects`; independent Test and Bot archives
use `users`. Canonical UUIDs precede prefix construction. The complete Session
UUID remains the directory identity, with at most 256 prefix shards per owner.
The kind directory separates the existing project and user UUID domains,
including equal UUID values; it introduces no new ownership or access authority.

`internal/sessionarchive.Namespace` shares path generation between archive
writers and restricted cleanup. Generic `Put`, `Open` and `Delete` continue to
accept bucket/path. Bot cleanup receives a validated Namespace and removes that
current Session directory, including unregistered objects there, while preserving
same-owner/shard siblings. Old direct directories are untouched and do not block
current directory cleanup. Existing lock order, SQL deletion and failure/retry
responsibilities remain unchanged.

PostgreSQL continues to retain `session_archives.object_path`. Readers open that
persisted location and perform the existing length, digest and archive-structure
checks; they do not derive another key or reject a location because of its layout.
Same-hash ready uploads return the existing result with the original idempotence
semantics. Protocols, raw bytes, immutable receipts and public URLs retain their
existing behavior. Existing files and metadata stay in place; this directory
arrangement neither relocates them nor adds a compatibility path or repair rule.

The [attachment layout decision](2026-10-24-project-sharded-attachment-layout.md)
provides the precedent for business-owned grouping and UUID shards. This decision
replaces the direct address for new writes within the
[completed archive decision](2026-10-30-session-file-archives.md), preserving its
content ownership and lifecycle. The
[Bot deletion decision](2026-11-04-bot-history-deletion.md) retains cleanup of the
current derived namespace and excludes old direct-directory bytes. The
[Session design](../../../../docs/design/task-session-protocol.md#服务端归档布局)
owns the address rule; the
[Bot design](../../../../docs/design/assistant.md#删除与清理事务) owns deletion.

## Alternatives

**Keep the flat Session directory.** Its immediate directory size continues to
grow with all archived Sessions and does not express recorded ownership.

**Shard only by Session UUID.** It bounds the bucket entries but mixes all
projects and independent owners in the same shards. Ownership grouping follows
the existing attachment arrangement without changing Session identity.

**Use project directories for every Session.** Independent Test and Bot Sessions
have no project. Assigning one would change their domain; the existing user owner
provides their grouping instead.

## Consequences

New archive directories are grouped by existing owner and Session UUID prefix.
Stored object locations continue to govern reads, so existing archives retain
their original read behavior. No startup, read, upload-retry or control policy is
added. Bot physical cleanup covers its current derived namespace and leaves old
direct-directory bytes outside that cleanup scope.

Preserving `object_path` and one canonical namespace rule keeps this directory
change separate from later existing-data work. A later bulk move or cleanup needs
its own ownership and scope decision; retained metadata or paired backups may be
needed because ordinary Bot SQL deletion can remove an old file's association.
Files and PostgreSQL metadata retain their paired-backup and non-atomicity
boundary. Group directories are storage organization, not separate OS sandboxes
or additional authorization. Existing-data conversion, retention and incremental
backup remain outside this directory change.
