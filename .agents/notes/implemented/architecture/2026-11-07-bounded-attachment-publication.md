# Agent Note: Bounded Attachment Publication

Status: implemented

## Problem

An attachment upload can consume an unbounded body and hold resources while a
reader stalls. Length headers do not describe chunked or otherwise untrusted
streams, and merely entering file storage does not establish that the target
file changed. MCP's persistent transfer tickets also outlive individual file
I/O operations, so counting tickets as active I/O would prevent useful work.

## Decision

The attachment domain owns a 5 MiB actual-content limit, enforced by the shared
publication stream and by MCP's cumulative chunk admission before private writes.
The local storage implementation reports publication facts independently of
database completion and preserves the underlying and cleanup errors. The
[attachment design](../../../../docs/design/daynight-task-attachments.md) owns
its stream, transport, slot and transfer contracts.

Upload I/O acquires nonblocking instance, user and Task capacity after admission.
Cross-instance slots use exact-key persistent lock files, while the existing
[target gate](2026-11-06-attachment-target-gate.md) continues to serialize
same-path operations and the [private transfer lifecycle](2026-11-06-private-transfer-lifecycle.md)
continues to own idle tickets, reservations and cleanup. REST applies a real
socket read deadline and holds its slot through response delivery and cleanup.

## Alternatives

**Trust Content-Length or truncate the stream.** Chunked bodies have no reliable
length and a truncated EOF would falsely confirm a partial file. Counting actual
bytes and returning an explicit error keeps over-limit publication from starting.

**Reuse striped target gates as quotas.** Unrelated owners can collide in a
stripe and receive false busy responses. Exact-key locks avoid that coupling.

**Remove lock files after release.** Another instance may already have the old
inode open; recreating the path would let two holders lock different inodes for
the same slot. Stable control files preserve cross-instance exclusion.

## Consequences

The limit applies to new writes without modifying or hiding existing files.
Confirmed pre-publication failures remain distinct from uncertain publication,
and a database failure after publication remains a cross-store inconsistency
rather than an invented rollback. The slot budget bounds simultaneous upload
I/O, not total stored bytes; persistent control files also consume disk space.
