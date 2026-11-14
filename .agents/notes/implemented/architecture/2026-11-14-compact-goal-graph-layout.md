# Agent Note: Compact Goal graph layout

Status: implemented

## Problem

A complete Goal graph can contain many independent Tasks and wide parallel
branches. A single Dagre rank makes these graphs long and leaves much of the
canvas unused; fitting the entire result can make titles unreadable. The graph
must retain every real dependency and allow readers to keep their position while
content and the canvas size change.

## Decision

The Goal graph uses all visible edges to group weakly connected components,
assigns longest-prerequisite depths, wraps each depth into a grid, and packs
component rectangles against the measured canvas aspect ratio. It plans real
routes inside each component before translating it into the packed graph.
Ordinary chains retain their Dagre layout. The shared canvas accepts an optional
controlled fit action so both Goal fit controls request new geometry before
applying the overview viewport.

The initial Goal viewport keeps a 0.8–1 readable zoom; explicit fit shows the
complete graph. Topology and direction changes create a new readable layout,
while content updates and passive resizing preserve geometry and viewport. The
[Goal requirements](../../../../docs/spec/daynight-goals.md#goal-整体依赖图)
and [inspection design](../../../../docs/design/daynight-task-inspection.md#goal-整体图)
own the full behavior and mechanism. This replaces the original layout and
initial framing choice in the [Goal overview decision](../feature/2026-11-13-goal-overview-graph.md)
while retaining its projection and reading scope, and builds on the
[shared presentation layer](2026-11-13-shared-task-graph-presentation.md).

## Alternatives

**Pack disconnected Dagre components.** This improves independent Tasks but
leaves a wide parallel rank in one long column, so the central readability
problem remains.

**Move existing nodes into a grid after layout.** Arbitrary movement breaks the
router's forward-column and gap assumptions; routing in component-local rank
bands preserves those assumptions.

**Group by status.** Status updates would move cards and separate real dependency
relationships, disrupting reading and implying a structure unrelated to the graph.

## Consequences

Independent Tasks and parallel layers use both dimensions without inventing
edges or hiding Tasks. Layout candidates depend on canvas dimensions, so an
explicit fit can change positions; passive resizing does not. Complete graph
rendering and routing still cost resources proportional to the actual projection;
the validation scale is not a product input limit. Component-local route bounds
and card avoidance are necessary to prevent packing from crossing other cards.
