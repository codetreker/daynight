# Agent Note: Aggregate Task Chain Status

Status: implemented

## Problem

A task-chain row can show a completed label while its progress reports unfinished
work. The original dashboard placed the root task's own status beside aggregate
progress. A finished first prerequisite can still lead to many unfinished tasks,
so that badge misrepresents completion of the chain being browsed.

## Decision

`ComponentProgress` contains aggregate status alongside total and done counts.
The ordinary-component traversal derives all three: all members done means
done; any done or in-progress member with unfinished work means in progress;
otherwise the chain is pending.
The historical [reader preparation](../feature/2026-10-22-proposed-task-readers.md)
added a proposed-only case; the [status assignment decision](../architecture/2026-10-24-task-status-assignment.md)
removes it and restores three-state aggregation. The
[external dependency decision](../architecture/2026-10-23-external-dependency-design.md)
replaces the original distinct root-and-descendant main set with an exclusive
ordinary weak component. All-edge ancestor context stays outside that count.

The row badge, completed-chain count and visibility filter in the task-chain
tab consume the same aggregate status. The [task view decision](../feature/2026-10-22-project-task-views.md)
separates ordinary singleton components into direct-detail standalone rows,
whose badge and completion filter use individual status. The original unified
list remains the historical context for the incorrect badge. Graph nodes, task details, project counters and the server API
retain individual task semantics. A new snapshot rebuilds the derived values;
selection, pan and zoom do not trigger domain recomputation.

This replaces the original badge semantics described by the
[presentation decision](../../archived/feature/2026-10-21-task-chain-presentation.md).
The [projection decision](../../archived/feature/2026-10-20-task-graph-projection.md) records the
component, projection and distinct-count choices retained here; the
[complete context decision](../feature/2026-10-22-complete-prerequisite-context.md)
expands displayed ancestors without changing that counted membership.
Requirements and current structure belong in the [specification](../../../../docs/spec/daynight-web.md)
and [design](../../../../docs/design/daynight-web.md).

## Alternatives

**Keep the root's status next to chain progress.** This preserves the original
presentation but labels a chain completed as soon as its first task finishes.
The task's own status remains available on its graph node and in details.

**Treat every unfinished chain as pending.** This avoids a premature completed
label but hides activity once a task has started or finished. Aggregate in-progress
status preserves that information without introducing another task state.

**Derive state separately in each view.** The model already traverses each main
set to compute progress. Deriving state there shares the same task membership
and completion rule across the badge and visibility consumers without adding
another graph traversal during rendering.

## Consequences

A chain can remain in progress after its representative finishes and becomes
completed only when every component member finishes. Chains containing pending tasks remain
pending, even when an external
prerequisite from another chain is active. Aggregate status is a frontend snapshot
projection, not stored task data or a new API field, so the original aggregation
fix required no migration. The later status migration removes proposed while
preserving counted membership and progress. Completed-chain visibility behavior is
preserved for multi-member ordinary chains while its badge agrees with that behavior.
The task view decision changes category presentation without changing the
aggregate status computation.
