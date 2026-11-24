# Agent Note: In-progress task graph framing

Status: implemented

## Problem

An ordinary chain or Goal task graph can exceed its canvas at a readable scale.
Its initial position may show completed upstream work or the edge of a packed
layout while active work lies outside the canvas. Readers must pan before they
can find the tasks currently in progress.

## Decision

Both graph hosts retain their existing initial zoom and use a shared calculation
of translation to maximize the number of fully visible `in_progress` cards in
the current layout. A tie favors the closest translation to the existing
viewport, then ascending x and y. If no candidate fits, the card whose centering
translation is closest to the baseline is centered on the canvas. No candidates
or an already fully visible set leaves the baseline unchanged. The
[inspection design](../../../../docs/design/daynight-task-inspection.md#初始取景)
owns the geometric calculation and its lifecycle.

This partially supersedes the upstream-first initial position in the
[historical prerequisite context decision](../../archived/feature/2026-10-22-complete-prerequisite-context.md)
and the initial position of the [compact Goal layout](../architecture/2026-11-14-compact-goal-graph-layout.md).
Both remain the baseline when the new priority does not move it; their readable
zoom and layout rationale still apply. The [direction decision](../feature/2026-11-05-task-graph-direction.md)
retains its new-layout framing on direction changes.

## Alternatives

No alternative was recorded for this decision.

## Consequences

Readers can see the largest feasible set of active cards at the existing zoom,
but other work may initially be offscreen. Ordinary chain candidates are
limited to the current progressive overview; Goal candidates include displayed
external prerequisites. Explicit overview reset and fit keep their own policies,
and background status updates do not displace a reader's chosen viewport.
Very large cards may still be clipped when none fits at the existing zoom.
