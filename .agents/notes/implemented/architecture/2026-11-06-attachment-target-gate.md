# Agent Note: Serialize Attachment Target Publication

Status: implemented

## Problem

Concurrent operations on one attachment path can publish file bytes and database
metadata in different orders, leaving a successful result paired with another
operation's content. A database lock alone cannot prove that a live file writer
has stopped after its database connection or lease is lost.

## Decision

The shared attachment use case holds a storage target permit across Put and
Delete through transaction completion, and across Open until it has matching
metadata and an open file object from the same serialized state. All transports
use the same protected use case. A prior failed operation can still have left
those two resources inconsistent.
The local storage gate uses separate target and private domains, each with 256
persistent lock-file stripes and process-local admission. Advisory file locks
coordinate instances sharing a root and remain held independently of database
locks. Lock files are control objects and are not removed during object cleanup.
The private domain permits later transfer operations to acquire their namespace
permit before the target permit. The [attachment design](../../../../docs/design/daynight-task-attachments.md)
owns the current storage and failure semantics.

This partially supersedes the concurrency limitation in the archived
[attachment storage decision](../../archived/architecture/2026-10-21-task-attachment-storage-design.md),
while retaining its non-atomic failure boundary. The
[Task deletion serialization](2026-11-06-attachment-task-deletion-serialization.md)
remains independently necessary for the Task lifecycle.

## Alternatives

**Database locks alone.** A lost connection can release the database lock while
its file writer remains active; another writer could publish before it finishes.

**Immutable object keys and a database publication pointer.** This would require
object identity and reclamation, changing the existing path-based lifecycle.
The target gate preserves that lifecycle without claiming cross-store rollback.

## Consequences

Successful operations on one target cannot interleave their file and metadata
publication. An already opened file remains readable after a later replacement.
Stripe collisions serialize some unrelated operations, and each storage backend
must supply equivalent cross-process admission. A failed operation may still have
changed the file without a matching metadata commit; the gate does not repair it.
