# Agent Note: Ordinary Task Parent Lifecycle

Status: implemented

## Problem

Ordinary parent Tasks can retain independent execution and records while their
children are unfinished. Completion, reopening, cancellation and deletion must
observe the same parent-child facts as creation and Worker completion. A partial
recursive cancellation would leave the tree and its Session and event history in
conflicting states.

## Decision

The [parent write design](../../../../docs/design/daynight-task-parent-writes.md)
defines creation intent, immutable ordinary parent edges, direct-child admission
and the Project transaction for confirmed recursive cancellation. The Project
lock serializes lifecycle operations with child creation and reopening. The batch
plans and locks the actual write set in UUID order, validates it before writing,
and freezes the Webhook audience once for all changed Tasks. Each Task retains
its existing status, Session and event responsibilities. This extends the
[subtree visibility decision](2026-11-23-task-subtree-visibility.md) and the
[parent read and claim decision](2026-11-23-task-parent-read-projection.md).

## Alternatives

**Cancel each descendant independently.** A later claim or capture failure could
leave earlier Tasks cancelled, and separate audience snapshots could differ for
one confirmed operation.

**Treat parentage as dependency edges.** Parent and child have independent
execution, while explicit prerequisites already have their own rules and can be
changed independently of the immutable parent relationship.

## Consequences

Completion and deletion must query visible direct children under the Project
lock. A recursive cancellation holds that lock and locks each changed row, so its
cost grows with the visible subtree and is bounded by the operation deadline.
Public creation and confirmation inputs remain separate protocol work; existing
status and deletion operations enforce the new lifecycle admission.
