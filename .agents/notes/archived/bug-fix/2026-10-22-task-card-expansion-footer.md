# Agent Note: Conditional Task Card Expansion Footer

Status: implemented

## Problem

Task cards with no hidden direct neighbors still reserved a ruled expansion
footer. Complete small graphs and fully expanded regions therefore displayed a
large blank area below every task body, suggesting an empty content section.
The reserved height also increased graph spacing and viewport bounds.

## Decision

A visible task has a 40px two-column expansion footer only when at least one
direction can add hidden direct neighbors. Cards without controls are 220 by
96 pixels: the existing 94px body and two border pixels. Cards with controls
remain 220 by 136 pixels. An unavailable direction retains its column when the
other direction is available, keeping prerequisite and successor positions
stable.

Each visible snapshot derives its per-task expansion data once. Its dimensions
feed Dagre, the returned node geometry, React Flow, initial viewport fitting,
root anchoring and keyboard reveal. Layout edges terminate at the actual card
boundaries. Expanding the final hidden neighbors can remove the anchor footer;
the action still centers the updated card and focuses its body. Reset restores
the current overview and retains reset-button focus. Selection reuses geometry.

This partially supersedes the uniform card geometry in the
[progressive overview decision](../feature/2026-10-22-progressive-task-graph.md).
That decision reserved footer space to keep direction controls consistently
positioned during explicit expansion. The directional columns remain stable
where controls exist; an empty footer has no interaction to preserve.

## Alternatives

**Hide the empty footer while retaining 136px layout nodes.** The visible card
would disagree with Dagre boundaries, edge endpoints and viewport calculations.
It would also retain the spacing cost that the compact card should remove.

**Shrink every card to the body height.** Cards with hidden neighbors still need
their existing sibling expansion buttons. Removing their space would crowd or
clip controls and compromise the separate body and expansion actions.

**Collapse an unavailable direction into one full-width control.** The remaining
control would change horizontal position as neighbors become visible. Keeping
two columns where a footer exists preserves directional placement.

## Consequences

Complete regions have no empty footer or separator. A graph can contain both
96px and 136px cards, so visibility changes can alter its layout; selection and
ordinary viewport navigation retain geometry. Refresh retains its existing
visible-ID, viewport and focus rules while updating card sizes from the new
snapshot.

Geometry tests cover mixed heights, nonoverlap and exact rectangle boundaries.
Canvas tests cover absent footer DOM, one-direction controls, final expansion
to compact height, keyboard anchor reveal, viewport fitting and reset focus.
Capacity geometry expectations derive the two heights independently from the
visible tasks and hidden incident neighbors.
