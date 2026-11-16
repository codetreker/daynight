# Agent Note: Shared Task Graph Presentation

Status: implemented

## Problem

Graph presentation and modal lifecycle were coupled to the ordinary chain's
root, progressive visibility and inspection policy. Another graph with a
different membership and framing policy needs the same rendering and overlay
mechanisms without inheriting those chain semantics.

## Decision

`GraphProjection` contains main and external node IDs and real edges;
`ChainProjection` also retains its real root and completion count. Both chain
and Goal layouts accept the shared projection. `TaskGraph` owns chain visibility, inspection,
node data and root framing, and supplies those results to the shared canvas and
toolbar. The dialog shell owns the portal, overlay and focus lifecycle, while
the chain wrapper supplies its actual metadata and content. The existing chain
uses these components directly. The [inspection design](../../../../docs/design/daynight-task-inspection.md)
owns the current behavior and data flow.

## Alternatives

**Treat another resource as a chain root.** A resource that is not a Task cannot
provide the chain's actual root or progressive membership, and disconnected
members would be lost.

**Duplicate the canvas and dialog.** This would duplicate viewport, focus,
Escape and overlay behavior and require each consumer to keep those mechanisms
consistent.

## Consequences

The [Goal overview graph](../feature/2026-11-13-goal-overview-graph.md) uses
this shared layer with a complete Parent-scoped projection and its own actions
and framing. Its [compact layout](2026-11-14-compact-goal-graph-layout.md)
remains separate from the chain layout.

Consumers can provide their own projection, nodes, inspection and framing while
the existing chain retains its reading behavior. Each consumer remains
responsible for its own membership, actions and viewport policy; sharing the
mechanical layer does not implement a new graph or change chain geometry.
