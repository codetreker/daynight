# Agent Note: Task Steps status writes in the shared detail session

Status: implemented

## Problem

Step status and ordinary Task settings share a parent version. A successful Step
write returns the independent Steps resource, not a Task detail or project
summary. Concurrent writers, late receipts and uncertain outcomes must not let
one resource masquerade as another or make a stale version writable.

## Decision

The existing `TaskDetailSessions` owner serializes status and Task mutations.
It validates a complete Steps receipt against the submitted operation and keeps
its actual version distinct from parent detail and summary versions. A status
write triggers parent and project reads; the common submission gate opens when
all three resources converge under the same identity and cache generation.
A newer observed version invalidates the older collection and schedules a read.
If the parent GET finishes before the other resources advance, the owner
coalesces a new parent read at that floor and opening generation. Reopening
requires a fresh parent read even at the same version; repeated stale responses
fail visibly instead of leaving an unbounded retry or a permanently busy gate.
Task and Steps state publication both check convergence, including when a
same-version summary mismatch clears.

A conflict, malformed success or uncertain transport result is reconciled by
reading current resources under the original identity, without replay. A failed
readback keeps recovery available and the gate closed. A child 404 checks the
parent before retiring access. A confirmed parent deletion remains visible across
a cache generation replacement; the authorized cache index, rather than a
lagging rendered graph, establishes removal. Request IDs correlate recovery reads with their
write without asserting what caused the current state. The four-state menu
retains the confirmed state until validation and uses a browser top-layer
popover so the detail surface cannot clip its keyboard-accessible options.

The [reading decision](2026-11-04-task-steps-web-reading.md) retains the lazy,
independent in-memory collection and bounded DOM. An in-flight operation retains the collection across a reader's departure; an
unresolved operation retains its identity and recovery ownership while releasing
the collection when no reader needs it. Retirement clears private state.

## Alternatives

**Give the Steps panel a separate writer.** This would split the shared version
and authorization lifecycle, allowing Task and Step submissions to race from
different baselines and making late responses harder to fence.

**Treat a successful HTTP status as confirmation.** An invalid or mismatched
body cannot establish the complete collection or the resulting parent version;
readback preserves the uncertainty without inventing a result.

## Consequences

Status changes require convergence of three independently returned resources,
so synchronization or read failures remain visible and temporarily prevent
further writes. The [append form](2026-11-04-task-steps-web-add.md) reuses the
same owner; editing, ordering and deletion can do so without another gate.
