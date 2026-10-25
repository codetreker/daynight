# Agent Note: Cubic Bézier Dependency Routes Between Task Columns

Status: implemented

## Problem

Dense dependency graphs contain many branches, merges and routes across several
ranks. Long horizontal/vertical segments with small rounded corners make those
routes difficult to follow. Changing the shape must preserve card avoidance,
fixed arrow direction, external-dependency dashes and inspection stability.
Long curved dashed paths also need bounded paint work; the existing straight-line
optimization alone does not bound their raster cost.

## Decision

Dagre retains visible-card placement and ordering. The uniform column planner
retains right-center source ports, left-center target ports and each CanvasNode's
actual dimensions. Intermediate columns use the nearest free row to the
interpolated Dagre route intent, with sixteen-unit expanded occupied intervals.
The planner emits forward passage endpoints at column boundaries. Adjacent
horizontal spans coalesce without deleting a change in passage height.

Each different-height passage across an empty column gap becomes one cubic
Bézier curve. Its first control is at the gap midpoint and source height; its
second control is at that same midpoint and target height. Both endpoint
tangents point horizontally right. The control polygon lies entirely between
the previous column's right boundary and the next column's left boundary, so
the Bézier convex hull cannot enter a card. Horizontal free-row spans cross
intermediate columns, and equal-height passages remain straight lines. All
joins retain a horizontal rightward tangent without moving cards.

This replaces the horizontal/vertical transitions and bounded quadratic corners
from the [uniform routing decision](2026-10-22-uniform-task-dependency-routing.md).
That decision retains the original rationale for separating node placement from
route ownership and choosing one free-row planner over per-edge collision repair.
The [inspection design](../../../../docs/design/daynight-task-inspection.md)
owns the current mechanism and the
[requirements](../../../../docs/spec/daynight-task-inspection.md) own observable
behavior.

`compileDependencyRoute` produces a complete canonical M/L/C path. Solid bodies
and native markers retain that geometry. External dashed bodies retain the 5/4
pattern and positive cumulative arc-length phase. Long straight regions keep
unit-scale local-axis line paint from the
[original paint decision](../bug-fix/2026-10-20-long-dashed-dependency-paint.md).
Curved pieces are exact De Casteljau subcurves, rather than line approximations.
Internal piece boundaries fall at global phase-seven dash-gap midpoints. Every
straight or curved paint piece has at most 8,192 graph units of arc length,
extending the [stroke bound](../bug-fix/2026-10-22-bounded-dashed-dependency-lines.md)
to tall cubic passages. Cumulative phase error remains at most 0.025 CSS px at
maximum 1.8 zoom.

The existing memoized SVG and inspection presentation retain edge identity,
arrowheads, external classification, accessibility and passive paint pieces.
Selection, details, pan and zoom reuse compiled geometry; only visible layout
changes invoke planning and compilation. Independent checks cover actual cubic
geometry, card avoidance, exact painted coverage and true arc-length phase.

## Alternatives

**Keep orthogonal routes and increase corner rounding.** A larger radius still
leaves long vertical channels and must fit existing clearances. Full gap curves
make the entire height transition continuous while keeping bending outside card
columns.

**Connect only source and target with a React Flow Bézier helper.** Endpoint-only
curves discard the intermediate free rows needed by dependencies spanning several
columns. They can cross unrelated cards and do not retain the existing bounded
dash-paint mechanism. Reusing the column planner preserves those guarantees.

## Consequences

Branches and merges use continuous cubic transitions, with an explicit convex-hull
argument for card avoidance. Node placement and selection geometry remain
independent of curve shape. Route compilation now includes cubic arc-length
calculation and exact subcurve splitting; unusually tall routes add paint pieces
rather than leaving a single unbounded dashed curve.

The renderer still represents every visible real dependency. Curves can overlap
or cross other curves; this decision preserves node placement and does not add an
edge-crossing minimizer. Existing production opening and interaction budgets,
full capacity inputs and cleanup rules continue to apply. Historical rounded-route
receipts establish only their tested source; cubic browser, geometry and timing
results require source-bound verification.
