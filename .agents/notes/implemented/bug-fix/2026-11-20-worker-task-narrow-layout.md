# Agent Note: Worker Task Rows at Narrow Widths

Status: implemented

## Problem

The fixed three-column Worker task table leaves too little room for ordinary
status and phase words on a phone. Titles wrap excessively while short Agent
names leave unused space beside them.

## Decision

The shared live and retained task table switches at a 430px container width.
Narrow rows give the task identity the full width and place status, phase and
Agent below it. The table retains its headers, cells and single task link.
The [Web requirements](../../../../docs/spec/daynight-web.md#运行观测) own
the visible behavior.

## Alternatives

**Keep three columns and reduce text size.** This would sacrifice the shared
typography roles and still leave long titles constrained to one column.

**Switch by viewport width.** The available table width also depends on the
workspace layout, so a viewport breakpoint does not reliably identify the
space available to the rows.

## Consequences

Ordinary status and phase words can remain readable without shrinking type.
The narrow layout needs explicit table roles when CSS changes table display,
and browser checks must cover the container threshold and link semantics.
