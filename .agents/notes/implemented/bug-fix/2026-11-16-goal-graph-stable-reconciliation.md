# Agent Note: Stable Goal graph reconciliation

Status: implemented

## Problem

Deleting a Task changes the project epoch. Retiring the old reading state and
reopening the Goal after a fresh snapshot interrupts the graph, resets its
viewport and can disturb valid interaction state even when the Goal remains.
The old history and its write qualifications must still retire, and actual
access or identity loss must immediately withdraw private content.

## Decision

The original decision separated current project reads from the last displayed
projection. History replacement retired receipts, tickets and detail while the
same identity, project, scope and access lifetime retained the displayed Goal
until a validated replacement snapshot arrived. Only the current displayed Goal
could carry its navigation witness, with detail cleared; a separate access-retirement
count rejected that witness after revocation. Other old entries remained retired
and admitted navigation stayed authoritative.

The [ordinary-subtree retirement decision](../architecture/2026-11-24-web-subtask-lifecycle-retirement.md)
replaces cross-history display retention. A shared cache may omit ordinary parent
edges and cannot prove that an old Goal projection excludes newly hidden
descendants. Trusted deletion or history change therefore withdraws old project
presentation immediately. Still-admitted same-history refreshes continue to retain
valid content, geometry and interaction state.

Mutation and internal history reconciliation replace active reads silently;
periodic checks remain deduplicated and explicit refresh retains its progress
semantics. The Goal graph recalculates geometry on topology changes without
changing framing identity. Empty Goals keep the same canvas host and do not fit
empty bounds. The [synchronization design](../../../../docs/design/daynight-task-sync.md#6-投影时钟与详情)
and [inspection design](../../../../docs/design/daynight-task-inspection.md#goal-整体图)
own the detailed boundaries. This replaces the earlier [reopen decision](2026-11-16-goal-graph-deletion-continuity.md).

## Alternatives

**Reopen after fresh admission.** The previous decision retained only navigation
context and safely retired contents, but interrupted the dialog and reset its
viewport during every epoch replacement.

**Use the displayed snapshot as the current read.** This would let stale receipt,
revision and resource type observations qualify detail reads or writes after a
history change, including a restore with matching IDs and versions.

**Avoid rotating the epoch on deletion.** Delta sync has no deletion tombstone;
other clients could retain deleted nodes indefinitely.

## Consequences

Separating current and display consumers preserves continuity during ordinary
same-history updates without turning presentation into a permission grant. The
original cross-history retention reduced graph interruption but depended on the
remaining projection being safe to display; ordinary subtrees invalidate that
assumption. History, access, identity and scope retirement now remove old display
content, and readers or mutation owners must still use current qualification.
