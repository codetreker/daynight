# Agent Note: Goal Graph Inspection

Status: implemented

## Problem

A complete Goal graph shows ownership and direct prerequisites, but opening Task
details from its card body prevents readers from selecting a Task and tracing
its dependencies in that view. Using a different card action from ordinary
chains also makes the same visual control behave differently across graphs.

## Decision

Goal and chain cards share native body inspection and an independent sibling
Details button. Goal cards use shared compact geometry, scaling with larger root fonts, and retain status and
execution presentation, and separate room for Details. They retain the complete
Parent projection and provide no progressive expansion or external navigation.

`GoalTaskGraph` owns selection for its Goal and derives complete upstream H from
the project index through `tracePrerequisites`. Shared inspection Context and
node/edge presentation highlight only visible H nodes and real visible edges
whose endpoints both belong to H. Hidden upstream Tasks are counted outside the
current projection, including ancestors beyond its one-layer prerequisite scope.
A still-visible selection survives same-Goal snapshots and is recomputed against
the current index; removal or a different Goal clears it. Direction changes,
explicit fit, Details and fullscreen retain a valid selection. Inspection remains
separate from layout requests and viewport policy.

Details uses the existing Task reader and passes its actual button as the focus
return target. Existing browser history and draft protection remain owned by
the reader. The [Goal requirements](../../../../docs/spec/daynight-goals.md#goal-整体依赖图)
and [inspection design](../../../../docs/design/daynight-task-inspection.md#goal-整体图)
own the full behavior and mechanism.

This partially supersedes the body-opens-details action from the
[Goal overview graph decision](2026-11-13-goal-overview-graph.md), while preserving
its projection. The [compact layout decision](../architecture/2026-11-14-compact-goal-graph-layout.md)
still owns geometry and framing, and the [shared presentation decision](../architecture/2026-11-13-shared-task-graph-presentation.md)
still owns the shared mechanical layer.

## Alternatives

**Keep body-only details.** This preserves the original direct reading action,
but readers must leave the complete Goal view to inspect a dependency chain and
cannot highlight the relationships already visible in that scope.

**Adopt chain expansion and external navigation with inspection.** These actions
would change the Goal view's complete ownership projection or replace its graph
resource. Shared inspection and Details do not require either policy change.

## Consequences

Readers can inspect visible prerequisites before opening a Task, with the same
keyboard and selection semantics in both graph types. Complete ancestry can
extend beyond the Goal projection, so the hidden count describes Tasks that the
view deliberately does not add. The card reserves explicit space
for Details beside existing metadata. Selection must stay independent of layout
and details so that inspection cannot move the reader's graph position.
