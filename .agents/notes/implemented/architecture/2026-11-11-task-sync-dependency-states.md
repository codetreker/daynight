# Agent Note: Task Sync Dependency States

Status: implemented

## Problem

A visible Task can retain a dependency on a Task hidden by its deleted Goal.
Deriving readiness from visible summaries alone loses that prerequisite's actual
state, while a prerequisite can change without changing its successor's version.

## Decision

Task sync returns a separate dependency state map from the same database
snapshot as its summaries and epoch. Snapshots cover visible ordinary Tasks;
deltas include owners whose own or direct prerequisite's update intersects the
window. Each state carries the owner's exact version, retained blockers and
readiness. A bulk query reads physical prerequisite facts without loading Task
bodies. The Web cache stores intrinsic summaries separately from owner-versioned
dependency states. It merges intrinsic versions first, then applies each state
only when its owner version matches; state-only changes persist and publish.
The typed resource map includes Goals, while the ordinary graph connects only
visible endpoints and retains unavailable prerequisite references. Schema 10
rebuilds incompatible task data while preserving unrelated profile and compatible
Session history data. The [sync design](../../../../docs/design/daynight-task-sync.md) owns the
wire contract and the [typed read decision](2026-11-11-typed-task-resource-reads.md)
owns visibility and retained dependency semantics. This refines the Web
projection described in the [cancellation decision](../feature/2026-11-06-task-cancellation-terminal.md),
whose terminal-state rules remain in force.

## Alternatives

**Derive from visible summaries.** A hidden unfinished prerequisite would be
lost and its successor could appear ready even though the server rejects it.

**Add a global apply revision or prerequisite version witnesses.** These can
order derived updates more strongly, but add cross-window state and coordination
to the existing sync protocol. Matching the owner version preserves the selected
bounded contract without those additions.

## Consequences

The map preserves authoritative retained facts without requiring a query per
Task, and an unchanged successor can receive a readiness patch. Large change
sets can still produce large responses. Owner-version matching cannot order two
different prerequisite observations for the same owner version; a late response
may temporarily restore an older derived state. A later relevant change or full
snapshot can refresh it, without a guarantee that the next poll will do so.
