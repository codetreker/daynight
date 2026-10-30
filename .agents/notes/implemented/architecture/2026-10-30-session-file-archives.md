# Agent Note: Completed Session File Archives

Status: implemented

## Problem

A completed task stops its Controller and can remove its worktree. Requiring that
Controller to stay online prevents reading the execution that produced the task
result. Restarting the native Agent to display a finished task can create new
work and still cannot reconstruct every transient approval or error event.
Keeping another full timeline in SQLite does not survive execution-container
loss and gives the database a content-retention responsibility it does not need.

## Decision

The standardized Controller timeline is the display-history source. Live updates
write private, atomic per-entry files beside the execution journal; registered
resources use the same pending-upload directory. SQLite keeps execution identity,
operation evidence, content hashes and revisions, and a bounded transport outbox.
Migration exports legacy content before dropping its SQL tables. File commits
precede SQL delivery metadata; recovery rejects missing or regressed content and
resynchronizes file updates that survived a rolled-back SQL transaction.

After native stop is confirmed, the launcher uploads one versioned archive to the
service's existing file-storage abstraction. PostgreSQL stores only identity,
status, object location, size and checksum. A matching ready receipt permits
normal Worker worktree cleanup. Failed uploads retain their source and retry
without restarting the Agent or repeating the task. Historical catch-up attempts
at most one execution per round and advances an in-process execution cursor on
both success and failure, while preserving each execution's retry delay. A
damaged source cannot monopolize later attempts. Shutdown confirms process stop
without archiving or deleting worktrees, including executions already awaiting
terminal finalization; their terminal responsibility survives for normal
reconciliation after restart. Completed archives are
immutable display records; they do not carry control or native resume authority.

This partially supersedes the
[Controller-owned content decision](2026-10-28-local-session-content.md). That
decision deliberately accepted online-only reading to remove PostgreSQL content
growth and backup exposure. The requirement to read completed tasks changes the
content lifetime, while the database exclusion and live ownership remain useful.
The [Session design](../../../../docs/design/task-session-protocol.md#完成后的文件归档)
owns the format, limits, authorization and lifecycle details.

## Alternatives

**Keep a complete timeline only in Controller SQLite.** It requires the execution
environment for playback, remains vulnerable to container deletion, and cannot
serve a finished task after Controller shutdown without another content server.

**Store the full history in PostgreSQL.** It makes database size and backups grow
with Agent output. File storage already separates attachment payloads from task
metadata and permits a future object-store implementation without changing the
read-only Session View contract.

**Rebuild the archive from native history after stopping.** Native transcripts
omit some transient events and vary by Provider. They can help recover native
context, but cannot prove a complete representation of the standardized live
view. Capturing the common timeline preserves the data already shown to users.

**Upload every live delta remotely.** This would improve protection against
sudden container loss but adds remote checkpoints, event synchronization and
retention policy to the execution path. Normal-completion archival does not
require that guarantee; failed final uploads retain the local source.

## Consequences

Completed Session URLs can render messages, tools and resources without a live
Controller. The same renderer is used with all write operations disabled, and
the server independently denies terminal-session control. Archive integrity and
original execution authorization are checked on both upload and read.

File storage now contains code and tool output and must be protected and backed
up with its metadata. A shared database alone does not make archives available
on another server instance; the file-storage backend must also be shared. No
automatic archive retention or object-store product is introduced.

The archive preserves the final supported timeline, not token-by-token playback
or native data that the Provider never projected. Explicit size and resource
bounds can cause archival to fail; failure never means silently truncated
success. The pending source remains local until upload is confirmed. Sudden
loss of that source before upload remains unrecoverable under this guarantee.
