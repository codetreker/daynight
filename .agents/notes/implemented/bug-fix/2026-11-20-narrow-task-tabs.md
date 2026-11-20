# Agent Note: Narrow task detail tabs

Status: implemented

## Problem

Wrapping the ordinary task detail tabs adds a full row above the reading area
when the last label does not fit on a narrow screen. Available height is
especially valuable in short viewports, and translated labels and optional tabs
have different widths.

## Decision

Ordinary task detail uses a single horizontal tab strip. When its container is at
most 600px wide, reduced spacing gives labels room before overflow; scroll edges
indicate remaining content. Selection and geometry changes reveal the selected
tab within that strip alone. Manual scrolling does not change selection. The
[detail design](../../../../docs/design/daynight-task-inspection.md#居中详情)
describes its surface and interaction boundaries.

## Alternatives

**Keep wrapping.** This makes every label immediately visible but consumes a full
reading row even when only one short label wraps.

## Consequences

The reading panel retains height and labels remain complete, at the cost of a
horizontal gesture when all tabs do not fit. Goal tabs retain their independent
layout. The short-height layout also supports scrolling on wider surfaces.
