# Agent Note: Serialize Attachment Mutations with Task Deletion

Status: implemented

## Problem

Task soft deletion retains attachment files and metadata, but an attachment
mutation admitted by an earlier snapshot can change those files after deletion
commits. A fresh check before file I/O alone leaves another race between that
check and the physical change.

## Decision

Ordinary attachment Put and Delete hold a Task SHARE lock through fresh project
authorization, the Task deletion check, path validation, file I/O, and the
transaction-bound metadata write and completion. Authorization precedes the
Task absence or deletion response. The transaction does not take a Project lock
after the Task lock, preserving the existing Project-before-Task write order.
The driver-independent store contract exposes the scoped DAOs; PostgreSQL owns
locking and transaction completion. The [attachment design](../../../../docs/design/daynight-task-attachments.md)
describes the resulting behavior.

Fresh project authorization reads both access sources without locking them.
The [attachment admission decision](../bug-fix/2026-11-06-attachment-admission-locks.md)
narrows the authorization locks used by the original implementation while
retaining this Task deletion boundary and its lock-order rationale.

The [Task deletion decision](../../archived/feature/2026-10-25-task-soft-deletion.md)
retains the data and the distinct authorized deletion response. This decision
extends its guarantee to ordinary attachment mutations already in flight. The
[upload deletion barrier](2026-11-06-upload-deletion-barrier.md) applies
this lifecycle ordering to MCP upload commits while preserving their admitted
identity semantics.

## Alternatives

**Check deletion in a snapshot before file I/O.** Deletion can commit after the
snapshot and before a physical mutation, so the retained bytes can still change.

**Take a Project lock for every attachment operation.** Existing Task-first
paths would need a wider lock-order redesign; adding that lock after Task would
instead risk deadlock with ordinary Project-first writes. Task row locks supply
the required deletion boundary without serializing unrelated tasks.

## Consequences

Deletion can wait for an in-flight file stream, and cancellation must preserve
the observed transaction outcome. A database rollback cannot undo a published
file or deletion, and an unknown commit cannot justify guessed compensation.
The accepted cross-storage failure boundary remains; this boundary serializes
lifecycle changes. The [target gate](2026-11-06-attachment-target-gate.md)
separately protects successful same-path publication. The PostgreSQL transaction releases its locks at completion,
while unrelated tasks remain independently writable.
