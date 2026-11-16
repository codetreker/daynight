# Agent Note: Goal graph continuity after Task deletion

Status: implemented

## Problem

Deleting a Task from Details above a Goal graph rotates the project's task cache
epoch. Project history retirement clears both the deleted Task reader and the
Goal graph witness, even though the Goal remains readable. Readers lose the
whole Goal context after removing one member, including when removing its final
member should leave an empty Goal graph.

## Decision

Project history and resource contents retain their existing retirement rules.
`ProjectPage` separately retains the current Goal graph's navigation intent and
list focus origin while its old snapshot and detail retire. A distinct snapshot
with a successful online read receipt must still identify the same Goal before
the graph can reopen. Recovery replaces the current reading selection, clears
the old detail and preserves the original section and category. It applies only
while the reader has continuously remained at the original navigation entry and
no other graph or detail has been selected. `ProjectPage` observes committed
`BrowserNavigation` location changes and permanently cancels this recovery on
the first admitted departure. Returning to the original entry with Back does not
restore eligibility; cancelled or refused navigation does not cancel recovery.
Access revocation and identity changes cancel recovery.

An empty Goal remains a valid graph resource; an absent Goal does not. The new
canvas uses the admitted snapshot, so this recovery does not preserve old
geometry, viewport or inspection selection. Ordinary chain graph eligibility,
direct Task reader deletion and retirement of older browser history entries keep
their existing behavior.

The [Goal overview decision](../feature/2026-11-13-goal-overview-graph.md) owns the
complete Parent projection. [Goal requirements](../../../../docs/spec/daynight-goals.md#goal-整体依赖图)
and the [inspection design](../../../../docs/design/daynight-task-inspection.md#goal-整体图)
own the behavior and mechanism.

## Alternatives

**Keep all project reading state across epoch changes.** This retains stale
Task details and nested readers as well as navigation intent. An epoch change
retires their original resource qualifications, so graph continuity cannot
exempt the old contents or history entries from that transition.

**Leave the graph closed after every deletion.** This preserves the existing
retirement behavior but forces readers to locate and reopen an unchanged Goal
after each member removal. The Goal has a stable resource identity independent
of the deleted member and its dependency component.

## Consequences

Deleting a member returns readers to the same Goal graph after fresh admission;
deleting the last member produces its empty state. A failed fresh synchronization
cannot qualify recovery with the retired snapshot. Tracking the first committed
departure prevents delayed recovery from reopening the graph after a leave-and-Back
round trip; checking only the entry ID when the snapshot arrives cannot detect
that intervening navigation. The graph can remount while the new
epoch is confirmed, so this decision preserves navigation context rather than
continuous rendering of retired content. The later [data-update continuity rule](../process/2026-11-16-ui-data-update-continuity.md) requires continuous presentation and retained valid viewport, which this recovery does not yet satisfy. Existing synchronization and focus
owners provide the recovery without a new API or stored history format.
