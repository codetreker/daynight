# Agent Note: Goal Execution Summary

Status: implemented

## Problem

A collapsed Goal shows its own status and child progress, but does not reveal
how many direct children are in progress or whether a Worker has claimed one.
Those facts are independent of the Goal's lifecycle and completion progress.

## Decision

The Goal heading displays the in-progress count and an active Worker indicator
derived from its direct ordinary children in the existing project snapshot. The
count includes paused and manually executed tasks, while the indicator requires
an active claim. Both remain visible and accessible when the Goal is collapsed.
The [Goal browsing decision](2026-11-11-goal-browsing.md) owns the scope
projection; the [chain indicator decision](2026-11-11-chain-active-worker.md)
uses the complete ordinary component for a chain instead. The [Goal
specification](../../../../docs/spec/daynight-goals.md) owns the visible rules.

## Alternatives

**Aggregate the indicators of the displayed child chains.** A chain's Worker
indicator includes its complete ordinary component, which can include members
outside the Goal. Aggregation could therefore attribute another scope's claim
to this Goal.

**Infer execution from permission or Session activity.** Permission does not
establish a claim, and Session activity has a separate lifecycle. Neither
represents the active Worker ownership shown by the shared indicator.

## Consequences

Readers can inspect direct-child status and ownership without expanding the
Goal. The existing snapshot supplies both facts without per-Goal requests or a
new polling channel. The indicator describes a claim, not whether an Agent is
currently producing output; it can differ from an expanded chain's indicator
because their scopes differ.
