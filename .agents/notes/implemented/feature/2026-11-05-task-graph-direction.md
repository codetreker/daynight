# Agent Note: Per-Goal Dependency Graph Direction

Status: implemented

## Problem

A fixed left-to-right graph is difficult to read for some task chains and screen
sizes. A layout change must preserve real dependencies, card clearance and the
reader's explicit exploration. Different Goals in the same project can require
different reading directions, so a single global preference would lose that
choice when switching between them.

## Decision

The graph toolbar selects horizontal or vertical layout. Each browser stores the
choice independently by project and the ordinary-component representative task
used as the Goal identity. Missing or invalid values default to horizontal;
read, validation and write failures remain visible while the current choice is
usable. The preference follows the existing representative and topology-change
semantics rather than introducing a second chain identity.

Dagre places actual-size cards left-to-right or top-to-bottom. The vertical
planner transposes card rectangles and coordinates to reuse the horizontal
channel planner, then transposes results back; text and cards remain upright.
Horizontal routes use right and left centers, vertical routes use bottom and top
centers. Free passages, smooth tangents, bounded dashed paint, native markers
and clearance apply in both directions. The original [Bézier decision](../../archived/architecture/2026-10-25-bezier-task-dependency-routing.md)
and [uniform routing decision](../../archived/architecture/2026-10-22-uniform-task-dependency-routing.md)
record the rationale for separating placement from routing and retaining free
channels across intermediate ranks.

Changing direction keeps the mounted canvas, visible tasks, explicit expansions
and inspection choice, while reframing the new geometry using the initial
viewport policy. The [complete prerequisite context decision](../../archived/feature/2026-10-22-complete-prerequisite-context.md)
records why framing exposes the upstream rank. Fullscreen remains a presentation
of the same graph. The [requirements](../../../../docs/spec/daynight-web.md) and
[inspection design](../../../../docs/design/daynight-task-inspection.md) own the
observable behavior and routing mechanism.

## Alternatives

No alternative was recorded for this decision.

## Consequences

Readers can choose a direction for each Goal without changing task data or
relationships. Local browser storage does not synchronize across browsers or
devices, and changing the component representative follows the existing chain
identity rules. Reusing the planner preserves one clearance algorithm, but both
directions require independent verification of actual ports, curves, arrows,
paint and variable-height card avoidance. A direction change relayouts and
reframes the current visible graph; selection and unchanged background reads
continue to preserve geometry and viewport.
