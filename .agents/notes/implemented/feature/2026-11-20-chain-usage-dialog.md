# Agent Note: Chain usage dialog

Status: implemented

## Problem

Chain usage is an accounting summary, but reaching it through the dependency
picture requires opening the graph even when the user only needs the total and
its incomplete members. Graph cards also compete for limited space with
relationship and task information. Filtered or cross-Goal chain rows need the
same whole-chain accounting without mistaking their visible subset for the
complete membership.

## Decision

Project chain rows open a separate usage dialog from a readable task anchor;
the service computes the current ordinary dependency component. Project-list
chain graphs omit aggregate and node usage in both normal and fullscreen modes.
The ordinary graph nested in Goal detail retains its usage because it may have
no corresponding project-list entry; Goal graphs and other usage surfaces keep
their existing behavior. The [usage specification](../../../../docs/spec/task-token-usage.md)
and [design](../../../../docs/design/task-token-usage.md) describe the interaction,
identity boundaries and data flow.

This limits the graph node display decision in
[graph node usage visibility](../bug-fix/2026-11-19-graph-node-usage-visibility.md)
to graph hosts that provide usage.

## Alternatives

**Keep usage in project chain graphs.** Requiring a graph to read totals adds an
unnecessary navigation step and occupies node space needed for the dependency
view. The dedicated entry remains alongside the chain's task-detail action.

**Remove usage from every ordinary chain graph.** A chain nested in Goal detail
may not have an equivalent project-list entry. Removing that graph's usage
would make its accounting harder to reach, so that host retains it.

**Sum the displayed rows.** Filtering and Goal boundaries can hide members, and
shared dependencies must be counted once. The existing server aggregate owns
membership, authorization and exact totals.

## Consequences

The project list exposes totals without opening a graph, while still allowing
members and relationships to be inspected independently. The selected anchor
must remain scoped to its account and project, and stale or unauthorized data
must be discarded. Graph hosts explicitly select whether to provide usage, so
retained Goal entry points continue to incur their existing reads.
