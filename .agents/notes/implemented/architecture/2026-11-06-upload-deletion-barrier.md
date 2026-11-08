# Agent Note: Serialize Resumable Uploads with Deletion

Status: implemented

## Problem

A resumable upload admitted before Task or Project deletion can write private
chunks or publish an attachment after deletion succeeds. A check in a completed
transaction cannot fence a later file operation. Project deletion must also
exclude historical soft-deleted Tasks from later publication.

## Decision

A bounded chunk write locks its transfer and then its Task, rechecks Project
lifecycle in a fresh statement, and retains the Task lock through private file
and receipt writes. Final attachment staging, publication and metadata retain
one Task lock after a fresh Project and Task lifecycle check. The private permit
protects the immutable chunk objects and their receipts; the attachment scope
reads those receipts without a transfer row lock, avoiding a Task-to-transfer
lock inversion. A commit admitted before credential or membership revocation
retains its admitted identity, but deletion remains a separate barrier. The
original permit may record an already confirmed result after Project deletion;
normal access still requires a live Project. Existing private transfer cleanup
reclaims temporary chunks without changing retained attachment content.

This replaces the deletion ordering in the [resumable upload decision](2026-11-06-resumable-mcp-upload.md)
and extends the [attachment Task deletion boundary](2026-11-06-attachment-task-deletion-serialization.md).
The [attachment design](../../../../docs/design/daynight-task-attachments.md)
owns the current flow and failure semantics.

## Alternatives

**Allow admitted uploads to finish after deletion.** It avoids long database
locks but changes retained files after deletion has succeeded.

**Acquire a Task lock around transactions that separately lock transfer rows.**
Existing transfer operations take their transfer row before the Task lock; the
opposite order can form a cycle while deletion waits for the Task.

## Consequences

Deletion can wait for a bounded chunk or an entire final stream, and the final
stream holds a database transaction. Credential and permission revocation need
not wait for the stream. PostgreSQL rollback cannot undo a physical file
publication; completion and possible side effects remain distinct facts.
