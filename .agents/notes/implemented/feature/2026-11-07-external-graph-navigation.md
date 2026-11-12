# Agent Note: One-Hop External Graph Context and Navigation

Status: implemented

## Problem

A Goal's dependency canvas can grow through several external workflows even
though those tasks belong to other ordinary components. Recursive context makes
it harder to see the Goal's own work and direct blockers. Readers still need to
inspect complete prerequisite meaning and reach the workflow that owns an
external task, including when its Goal is filtered out or on another list page.

## Decision

A Goal projection contains its complete ordinary-edge weak component M and the
union of M's direct external prerequisites outside M. Context is deduplicated by
task ID and never traversed recursively. Every real edge with both endpoints in
the projection remains present; its dashed style follows the persisted external
marker, even when an external shortcut has both endpoints inside M. Progress,
status and membership continue to count ordinary members only.

External cards have an independent native Expand button beside inspection and
Details. The project owner resolves the card's actual task ID through the current
ordinary-component index. An unparented multi-member destination opens its
chain graph using the destination representative's graph-direction preference.
An unparented standalone destination closes the original graph and opens the
existing task reader. A destination with a readable Goal Parent opens that Goal
and the complete chain graph for a multi-member target, or its Task reader for a
single member. Details remains a separate action that opens the target Task
under its actual Goal. Expand does not append external ancestry to the original
canvas. Ordinary member cards retain bounded direction expansion within the
projection.

The original navigation decision located the destination list page and cleared
only filters that hid its Goal. That made a destination outside the displayed
list reachable while graph opening depended on list visibility. The
[list-state preservation decision](../bug-fix/2026-11-07-external-graph-list-state.md)
replaces that navigation coupling: the graph now resolves independently from the
complete index, while the original list state and opener remain intact. The
one-hop projection, complete inspection and per-Goal direction rules continue.

Complete prerequisite inspection still computes H from the full project index.
Only visible ancestors and their real visible edges highlight; hidden H minus S
is deduplicated by task ID and includes ancestors outside the one-hop projection.
Inspection and Details remain independent actions that preserve graph structure.

This replaces the recursive external context described in the archived
[complete prerequisite context decision](../../archived/feature/2026-10-22-complete-prerequisite-context.md).
That decision's original purpose was to let readers trace all upstream meaning
within one canvas. Complete inspection and explicit navigation now provide that
meaning while giving each external workflow its own canvas. The
[graph direction decision](2026-11-05-task-graph-direction.md) retains its geometry
and per-Goal preference rules. The [external dependency requirements](../../../../docs/spec/daynight-external-dependencies.md)
and [inspection design](../../../../docs/design/daynight-task-inspection.md) own the
observable behavior and current mechanism.

## Alternatives

**Keep recursive context with local external expansion.** This lets one canvas
contain the entire prerequisite closure, but continues to grow the selected
Goal's graph through other workflows and does not provide the requested move to
the external task's owning Goal or task.

**Open a Goal only through the current list page's graph entry.** The destination
can be absent because of pagination or filters. Resolving the actual task through
the complete index made navigation reliable; the original implementation also
located the destination in the list to satisfy its graph-opening eligibility.
That list mutation is superseded by the independent resource ownership above.

## Consequences

The one-hop boundary limits context depth without limiting the number of direct
external prerequisites or removing ordinary Goal members. The complete project
snapshot and its client structural checks remain required. A large ordinary
component increases traversal and layout work without a stored node/edge limit,
as recorded in the [batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md). Context cards use the existing 136px
action-footer geometry so their navigation is available even when no local
neighbors are hidden.

Navigating to another unparented chain initializes that resource's graph
exploration and inspection state. It preserves list filters, pagination,
disclosure and scroll, and the project reading owner retains the original list
source through graph navigation and standalone task details. External
context does not add members to Goal progress and does not change execution
blocking, cycle detection or dependency classification. The archived dense
external ancestry workload remains historical input evidence; current validation
distinguishes the complete input, the one-hop projection and visible S, and
independently checks complete hidden H.
