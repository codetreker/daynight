# Agent Note: Variable Graph Card Height

Status: implemented

## Problem

A fixed graph card body reserves space for readings even when no reading is
visible, reducing how much of a dependency graph fits at a readable scale.

## Decision

Both graph layouts use a shared 240px width and select a 102px body without a
reading row or 124px with visible usage or overdue duration. Action footers
retain their 60px height. The same visibility decision drives rendering and
geometry; value changes alone do not relayout. Geometry updates preserve the
viewport and valid interaction state. The [inspection specification](../../../../docs/spec/daynight-task-inspection.md)
owns the visible contract. This replaces the fixed dimensions of the
[compact readings decision](2026-11-20-compact-graph-readings.md).

## Alternatives

**Retain a fixed body height.** This avoids a geometry update when a reading
appears, but leaves the unused row consuming graph space.

**Hide the row only in CSS.** Layout and edge endpoints would retain the empty
space and disagree with the rendered card.

## Consequences

Cards without readings occupy less canvas space. Changes in row visibility need
real geometry updates in both layouts, while stable values and ordinary clock
ticks must not move the graph. Mixed heights require routing and focus checks.
