# Agent Note: Goal pause presentation

Status: implemented

## Problem

Goal details can display ordinary tasks and their dependency graph, but their
pause presentation must reflect the same admitted snapshot as other task entry
points. Without that connection, paused children and chain counts disappear in
both the project dialog and the standalone Goal page. A collapsed Goal row also
needs to reveal paused direct children without opening the Goal.

## Decision

Goal details provide the snapshot's raw paused task IDs to their content and
chain dialog through `TaskPauseProvider`. Child rows read their own IDs from
that snapshot and use the standard badge. The existing graph consumers and
summary selector retain their separate raw badge and count semantics described
in the [pause summary decision](2026-11-10-paused-summary-eligibility.md). The
project Goal row uses the workspace provider and the same selector over its
direct ordinary children, exposing a nonzero count as the toggle description.

## Alternatives

**Rely on the project workspace provider.** The Goal dialog is a sibling of
that provider and the standalone page has no such ancestor, so neither entry
can depend on it.

**Extend graph nodes with pause properties.** The admitted snapshot already
contains the raw IDs; changing the graph schema would duplicate projection and
couple graph data to this presentation.

## Consequences

Both Goal entry points, the project row and nested portals share the current snapshot without a
new request or global state. Snapshot changes update the existing chain without
remounting it. Completed tasks retain their own badge while summary counts
exclude them; external prerequisites remain outside the ordinary chain and Goal counts. Goal
row counts do not depend on expansion or the child tag filter.
