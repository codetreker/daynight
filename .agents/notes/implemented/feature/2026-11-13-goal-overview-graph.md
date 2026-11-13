# Agent Note: Goal overview dependency graph

Status: implemented

## Problem

A Goal owns direct Tasks independently of ordinary dependency components. Its
work may contain disconnected chains, standalone Tasks and prerequisites outside
the Goal. A chain graph cannot show that complete ownership scope in one view,
and readers need to inspect actual prerequisites without losing their list and
reading context.

## Decision

The project Goal row opens a graph of every direct Task and each distinct,
accessible direct prerequisite outside the Goal. Edges retain their actual
ordinary or external classification and end at a member; external context does
not recursively expand. Every card opens its Task details. The graph shares the
canvas, layout and dialog mechanisms with ordinary chains while owning its own
complete projection and full-bounds framing. Goal and chain resource UUIDs use
the existing history witness and project-scoped direction preference.

The [Goal requirements](../../../../docs/spec/daynight-goals.md#goal-整体依赖图)
own the user-visible contract and the [inspection design](../../../../docs/design/daynight-task-inspection.md#goal-整体图)
owns projection, framing and reading ownership. The existing
[Goal browsing decision](2026-11-11-goal-browsing.md) owns direct Parent scope
and Goal detail classification. The [flat Goal list decision](../simplification/2026-11-13-goal-flat-list.md)
presents those members without chain groups; this graph remains a distinct Goal
view. The
[shared graph presentation decision](../architecture/2026-11-13-shared-task-graph-presentation.md)
retains the shared mechanical layer and ordinary chain policy.

## Alternatives

**Use a chain root as the Goal graph.** A Goal is not a Task and may have no
members or several disconnected components. A root and chain visibility would
omit valid members and conflate ownership with dependency connectivity.

**Duplicate the canvas and dialog.** A separate rendering and modal stack would
duplicate viewport, focus, Escape and overlay behavior and could diverge from
ordinary graph reading.

**Expand external prerequisites into their chains.** This would include work the
Goal's members do not directly depend on and obscure the scope being examined.
The existing chain graph remains available for navigating that context.

## Consequences

Readers see the full Goal scope and direct external prerequisites without
changing the background list. Complete DOM and layout costs grow with the full
projection; unlike a chain graph, this view does not progressively limit its
initial node set. The viewport must accommodate the full bounds even when that
requires a very small zoom, with pan and zoom available for detail reading.
