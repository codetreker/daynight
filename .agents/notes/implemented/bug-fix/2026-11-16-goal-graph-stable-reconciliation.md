# Agent Note: Stable Goal graph reconciliation

Status: implemented

## Problem

Deleting a Task changes the project epoch. Retiring the old reading state and
reopening the Goal after a fresh snapshot interrupts the graph, resets its
viewport and can disturb valid interaction state even when the Goal remains.
The old history and its write qualifications must still retire, and actual
access or identity loss must immediately withdraw private content.

## Decision

The project graph separates its current read observation from the last displayed
projection. Content history replacement retires the current receipt, tickets and
detail content while the same identity, project, cache scope and access lifetime
retain their displayed projection until a validated new snapshot replaces it.
Only the current already displayed Goal reading may carry its navigation witness
into the new generation, with detail cleared. A separate access-retirement count
prevents carrying that witness after revocation even when another history event
follows. Other old entries remain retired and admitted navigation is authoritative.

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

A full synchronization can update the existing graph without an API or database
change. Ordinary errors remain visible while the last displayed data remains
stable; the display projection is not a permission grant. Access revocation and
identity or scope replacement still remove it. Keeping separate display and
current consumers requires each reader or mutation owner to use current
qualification, while layout and navigation must preserve only still-valid state.
