# Agent Note: Goal graph continuity after Task deletion

Status: implemented

## Problem

Deleting a Task from Details above a Goal graph rotates the project's task cache
epoch. At the time, project history retirement cleared both the deleted Task reader
and the Goal graph witness, even though the Goal remained readable. Readers lost the
whole Goal context after removing one member, including when removing its final
member should leave an empty Goal graph.

## Decision

The original decision retained project history and resource retirement rules.
`ProjectPage` separately retained the current Goal graph's navigation intent and
list focus origin while its old snapshot and detail retired. A distinct snapshot
with a successful online read receipt had to identify the same Goal before the
graph could reopen. Recovery replaced the current reading selection, cleared the
old detail and preserved the original section and category. It applied only
while the reader remained at the original navigation entry and no other graph or
detail had been selected. `ProjectPage` observed committed `BrowserNavigation`
location changes and permanently cancelled recovery on the first admitted
departure. Returning with Back did not restore eligibility; cancelled or refused
navigation did not cancel recovery. Access revocation and identity changes
cancelled recovery.

An empty Goal was a valid graph resource; an absent Goal was not. The new canvas
used the admitted snapshot, so recovery did not preserve old geometry, viewport
or inspection selection. Ordinary chain graph eligibility, direct Task reader
deletion and retirement of older browser history entries kept their existing
behavior.

The [continuous presentation decision](2026-11-16-goal-graph-stable-reconciliation.md)
replaces this recovery mechanism while preserving its historical isolation rationale.

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

The original recovery returned readers to the same Goal graph after fresh admission;
deleting the last member produced its empty state. A failed fresh synchronization
could not qualify recovery with the retired snapshot. Tracking the first committed
departure prevented delayed recovery from reopening the graph after a leave-and-Back
round trip; checking only the entry ID when the snapshot arrived could not detect
that intervening navigation. The graph could remount while the new epoch was
confirmed, so this decision preserved navigation context rather than continuous
rendering or viewport state. The replacement retains presentation through retirement
without restoring old resource qualifications or automatically reopening after navigation.
