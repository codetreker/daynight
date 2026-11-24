# Agent Note: Parent Resource Lifecycle

Status: implemented

## Problem

Thread, attachment and Session operations do not all take the Project write
lock. A child Task can become unavailable when its Goal is deleted, while an
existing execution still needs to record its stop and finish its archive.
Checking a parent without holding its row lock allows deletion to race with
resource writes; locking rows in inconsistent order can deadlock with Project
deletion or another registration.

## Decision

The original resource lock plan made independent transactions pre-read the
target's Parent, acquire target and Parent physical row locks in UUID order with
their final modes, and reread the relationship and effective deletion after
locking. A changed Parent caused `resource_conflict` before side effects. Session
registration took UPDATE on the target and SHARE on the Parent; other operations
used SHARE. This protected the then-dynamic immediate-Goal deletion projection.

The [subtree visibility decision](2026-11-23-task-subtree-visibility.md) supersedes
that two-row plan: ancestor deletion updates the descendant marker under its
physical row lock, so independent transactions lock only the target.
Authorization, Session and file operations retain their downstream ordering.
The [server design](../../../../docs/design/daynight-server.md) and
[attachment design](../../../../docs/design/daynight-task-attachments.md)
describe the resulting scopes.

Session access uses the same effective deletion facts. Ordinary access is
unavailable after deletion, while the original owner's existing stopped ledger,
stop proof, closed recording and archive finalization paths remain available.
Goal reads have no execution Session. The [typed read decision](2026-11-11-typed-task-resource-reads.md)
owns the common projection and retained dependency facts.

## Alternatives

**Lock the target first and acquire its Parent later.** This can reverse the
order used by Project deletion and other transactions. Taking SHARE first and
upgrading registration's target also introduces competing lock upgrades.

**Check the Parent without retaining its lock.** Deletion can commit between
the check and a file or Session operation, exposing or changing a hidden child.

## Consequences

Ancestor deletion waits for in-flight resource transactions and later operations
observe the inherited marker. The original plan held two row locks and could
return a conflict after a concurrent Parent move; the replacement locks the
actual target throughout file I/O. Existing cross-storage and unknown-commit
boundaries still apply.
