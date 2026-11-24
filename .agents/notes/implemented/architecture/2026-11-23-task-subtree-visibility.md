# Agent Note: Task Subtree Visibility

Status: implemented

## Problem

Resource access must agree when deleting a container hides retained descendants.
Deriving deletion from only the immediate Parent cannot represent nested Tasks,
and independent attachment, Thread and Session transactions need a row barrier
against ancestor deletion without locking an unbounded ancestor chain.

## Decision

Tasks store a nullable internal `ancestor_deleted_at`. The effective deletion
time is `COALESCE(deleted_at, ancestor_deleted_at)`, preserving the target's own
tombstone precedence. The shared resource view keeps its original column names,
order and types. Migration 123 validates the formerly Goal-only hierarchy and
backfills visible physical children of already deleted Goals.

Deletion holds the Project write lock, plans the target, visible descendants and
explicitly detached dependency sources, and acquires final Task row locks in UUID
order. It writes one target tombstone and the same inherited timestamp to visible
descendants, pruning already hidden branches. Visibility changes preserve child
business fields; actual dependency detachments retain their one-version update.
All changes share the Session and event transaction. The [activation decision](2026-11-24-activate-task-deletion-deltas.md)
keeps the project cache epoch on ordinary deletion.

Independent resource transactions lock the actual target physical row in their
final mode and read its effective deletion after locking. Ancestor deletion must
update this same row. This replaces the two-row plan in the
[Parent resource lifecycle decision](2026-11-11-parent-resource-lifecycle.md).
Session registration uses UPDATE; ordinary resource operations use SHARE.
Existing owner-only execution and archive finalization exceptions remain owned
by their respective resources. The [deletion design](../../../../docs/design/daynight-task-deletion.md)
owns the transaction and recovery details.

## Alternatives

**Recurse through ancestors for every read.** This moves work into ordinary lists,
counts, pagination and resource checks. The design investigation found materially
higher query costs than persisting a monotonic visibility fact at deletion.

**Build a project-wide hidden set for every query.** This requires each read path
to preserve tenant filtering and visibility before pagination and aggregation.
The existing shared view provides one enforcement point.

**Maintain an ancestor closure table.** Every creation and move would maintain
additional rows. Existing adjacency indexes cover descendant traversal and direct
child queries without adding that write protocol.

## Consequences

Ordinary visibility reads avoid recursive ancestry checks. Deletion writes and
locks each newly hidden descendant, so its cost depends on subtree width; long
resource operations can delay that transaction. The existing project/parent index
serves traversal. Direct SQL fixtures and administrative data changes must maintain
the inherited marker through the same transaction semantics.

The migration requires draining old writers and background delivery before
upgrade. A migrated ledger requires its matching artifact. Restoring an older
artifact requires a paired database and attachment snapshot, reconciliation of
external effects, and cache-epoch rotation before reopening traffic. Public Parent
writes retain their existing Goal-only admission; internal ordinary Parent and
lifecycle rules are defined by the [parent lifecycle decision](2026-11-23-task-parent-lifecycle.md).
