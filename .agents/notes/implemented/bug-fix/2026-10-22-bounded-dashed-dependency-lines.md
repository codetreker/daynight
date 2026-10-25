# Agent Note: Bound Dashed Dependency Line Length

Status: implemented

## Problem

Locally horizontal SVG lines avoid the expensive CPU raster path identified by
the [original paint decision](2026-10-20-long-dashed-dependency-paint.md), but a
long line can still occupy the macOS Metal GPU pipeline after a drawer closes.
Input for a later viewport operation then waits for preceding presentation work.
Equivalent graph sizes can produce different route lengths because generated
task IDs affect layout ordering. A simpler graph that passes does not establish
that the failing graph is supported.

## Decision

The line-paint mechanism retains canonical routes, native arrow markers and
local line transforms. Extracted straight regions are split into pieces no longer
than 8,192 graph units. Additional cuts use the same global phase-seven gap
midpoint as the original decomposition. Each piece retains its cumulative arc
distance and positive dash offset; a final piece may be shorter than the
128-unit extraction threshold. The route compiler validates full cumulative arc
length before expanding paint pieces, so overflowing geometry fails before
allocating bounded segments.

The [Bézier routing decision](../architecture/2026-10-25-bezier-task-dependency-routing.md)
replaces the former short rounded bends with complete cubic curves across column
gaps. It retains this line mechanism and extends the same arc-length bound and
gap-midpoint seam rule to exact cubic paint subcurves. Canonical route geometry
and arrow ownership remain independent of the paint decomposition.

The bound limits work for an individual GPU stroke without depending on viewport
state or CPU-specific dash clipping. It applies on both Linux and macOS. Every
route remains complete, including offscreen geometry, and viewport operations
reuse the same immutable pieces. The existing 5/4 dash pattern, stroke width,
native joins, arrowheads, accessibility and interaction semantics remain intact.

This extends the original paint decision with a length bound; its historical
CPU raster evidence still explains the local coordinate representation. The
[macOS acceptance decision](../testing/2026-10-22-macos-web-acceptance.md) owns
platform execution and recovery. Fixed capacity datasets, five repetitions,
event-to-feedback timing and the 3,000ms/300ms budgets remain unchanged.

## Alternatives

**Add paint containment.** The original failing graph still incurred the long
GPU task with containment. A paint boundary alone does not bound stroke work.

**Render the long lines as solid strokes.** This isolated dashed body paint as
the expensive operation but removed required external-dependency appearance.
It is a diagnostic comparison, not a supported rendering mode.

**Change graph IDs or delay later interactions.** Different ordering can make
routes cheaper, and waiting can move work outside a measured interval. Neither
removes the cost of the actual failing graph. Diagnosis reuses its original IDs
and dependencies; acceptance continues to exercise the unchanged input sequence.

## Consequences

Long routes add SVG paint elements, increasing layout preparation and DOM costs.
The 8,192-unit bound balances those costs against individual stroke work; complete
capacity acceptance must assess both opening and subsequent interactions. Smaller
pieces are not automatically faster. A future renderer or browser change requires
renewed geometry, pixel and performance verification before changing the bound.

Tests cover full arc coverage, rotation/translation, dash phase at internal cuts,
exact canonical geometry retention and short final pieces. Browser comparisons must verify
complete canonical edges and visible output. Local diagnostic improvements do
not replace native production and Linux CI acceptance evidence.
