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
not recursively expand. Cards share body inspection and independent Task Details
with ordinary chains, as defined by the
[Goal graph inspection decision](2026-11-15-goal-graph-inspection.md). The graph shares the
canvas and dialog mechanisms with ordinary chains while owning its complete
projection, compact layout and framing. The original implementation shared the
chain layout and fitted full bounds on opening; the [compact layout decision](../architecture/2026-11-14-compact-goal-graph-layout.md)
replaces that choice to preserve readability. The original card body opened Task
details directly; chain graphs supplied dependency inspection. The later
inspection decision replaces that action to let readers trace dependencies
within the Goal scope. Goal and chain resource UUIDs use
the existing history witness and project-scoped direction preference. The
[stable reconciliation decision](../bug-fix/2026-11-16-goal-graph-stable-reconciliation.md)
keeps the displayed Goal graph mounted through project epoch retirement while old
resource qualifications and details retire.

The Goal graph header also opens its own Goal through a secondary Goal details
button below the close control. It passes the actual button and Goal ID through
the existing graph reader, retaining the graph witness, overlay owner, browser
history and focus return target. The same header is used in normal and fullscreen
modes; a separate action column keeps both controls reachable beside a wrapping
title. Empty Goals and retained graphs with refresh errors use the same action.
Ordinary chains and embedded graphs keep their existing entrances.

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

**Create a separate Goal reader or navigate away from the graph.** The existing
typed reader already owns permission checks, drafts, layered Escape and history.
Another reader would duplicate those rules, while leaving the graph would lose
the retained reading and focus context.

**Expand external prerequisites into their chains.** This would include work the
Goal's members do not directly depend on and obscure the scope being examined.
The existing chain graph remains available for navigating that context.

## Consequences

Readers see the full Goal scope and direct external prerequisites without
changing the background list. They can read the owning Goal directly and return
to the same graph control without resetting graph state. The header reserves
additional vertical space for its close and detail actions. Complete DOM and layout costs grow with the full
projection; unlike a chain graph, this view does not progressively limit its
initial node set. The initial viewport preserves readable scale, while explicit
overview can fit the full bounds at a smaller zoom.
