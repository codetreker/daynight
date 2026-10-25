# Agent Note: Uniform Channels for Dependency Inspection Routes

Status: implemented

## Problem

Smooth dependency inspection needs stable geometry, clear edge direction and
routes outside visible task-card interiors. Node placement and routed edge
points are different guarantees. Preserving a layout library's raw endpoint
spans does not itself establish the product's card-clearance requirement, while
multiple per-edge repair strategies make that requirement difficult to verify.

## Decision

The original uniform planner separated Dagre's visible-node placement from
product-owned fixed right-center/left-center ports and card avoidance. It used
each CanvasNode's actual width and height: 220 by 96 without expansion controls,
or 220 by 136 with the footer. Columns and sixteen-unit expanded occupied-row
intervals were built once; interpolation at each intermediate column center
selected the nearest free row. Horizontal/vertical transitions at gap midpoints
and quadratic corners of at most twelve units made avoidance uniform without
per-edge collision repair or raw-port compatibility branches.

The [Bézier routing decision](2026-10-25-bezier-task-dependency-routing.md)
replaces that bend geometry with complete cubic curves across column gaps. It
retains this note's node/route ownership, fixed lateral ports, free-row planning
and sixteen-unit intermediate clearance. Current routes cross empty gaps with
horizontal endpoint tangents and cross intermediate columns on horizontal free
rows. The curve convex hull stays within the empty gap, so avoidance no longer
depends on bounded corner radii. Equal rows still coalesce into straight spans.

This uniform-planning decision replaced the raw-Dagre-point retention target in
the [inspection design decision](2026-10-22-task-inspection-design.md). That
initial choice preserved lane intent and long straight spans so local-axis dash
painting could be reused. Assigning ports and avoidance to one planner removed
the need to preserve invalid endpoint shapes through special repairs. Dagre
continues to own node placement; product routing owns all edge geometry.

Route compilation remains tied to visible layout changes. Graph-local inspection
Context updates only node, body and arrow presentation while controlled geometry
remains stable. True curve arc length preserves the existing 5/4 dash phase and
maximum-zoom tolerance; long straight spans retain local-axis paint. The Bézier
compiler also bounds native cubic paint pieces. Independent checks validate
actual rendered routes rather than treating planner output as expected valid
geometry.

The [progressive overview](../feature/2026-10-22-progressive-task-graph.md) remains
the delivered PR134 baseline: fifty tasks/one hundred induced edges initially,
explicit twenty-neighbor batches, global reset, full P and actual visible S.
Highlighting does not expand, relayout or move the viewport. Details continues
through the current centered dialog, attachment panels/reader, locale and
resource owners.

The abandoned [PR #121](https://github.com/codetreker/daynight/pull/121) is history,
not a required integration or current verification artifact. Its runtime results
do not establish this replacement's geometry or performance. The
[requirements](../../../../docs/spec/daynight-task-inspection.md) and
[design](../../../../docs/design/daynight-task-inspection.md) own the new observable
acceptance and mechanism. [PR #143](https://github.com/codetreker/daynight/pull/143)
retains source-bound evidence for the original uniform-channel implementation.

## Alternatives

**Round raw library edge points.** This retains the existing waypoint sequence
and was the original target because it preserves long paint spans. It leaves
endpoint choice and clearance dependent on raw routes instead of one explicit
product rule.

**Repair only blocked spans or preserve old ports with special stubs.** This
creates multiple path-construction cases around an endpoint rule that does not
match the intended lateral entry/exit. Uniform channels make the same port,
clearance and rounding guarantees apply to every edge.

**Move task cards to accommodate edges.** That changes the established visible
layout while solving a routing problem. Keeping node geometry and inspection
state separate preserves spatial context and makes selection stability testable.

## Consequences

Node placement, route planning, smooth compilation and inspection paint have
explicit owners. The channel planner adds geometry work only when visible
structure changes; selecting a task must not repeat it. Actual opening and local
feedback remain subject to the existing production budgets.

Independent geometry and negative controls must cover all visible dependencies,
ports, tangency, card avoidance, real body coverage, dash phase and arrows.
Recorded runs are evidence only for their exact source; neither the adopted
design nor the abandoned attempt supplies a replacement pass.
