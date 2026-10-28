# Agent Note: Goal Task Lists

Status: implemented

## Problem

A dependency graph explains execution order, but opening it for every task
inspection makes routine status browsing require a modal and a second action.
The chain list needs direct access to its tasks while keeping aggregate progress
and the complete dependency graph available. Changing that entry must preserve
ordinary-component membership, including multiple starting tasks that merge,
and keep external prerequisite context separate from actual chain members.

## Decision

Each existing chain representative supplies a top-level Goal row with its
original title, aggregate status and progress. The original Goal browsing label
helped distinguish the new disclosure hierarchy; the
[compact-list decision](../simplification/2026-10-28-compact-task-list.md) removes
that extra header label and summary while showing the actual in-progress member
count. Task
classification, representative selection and membership continue to come from
the ordinary-dependency component. A singleton remains a standalone task even
if its title contains `[Goal]`.

The row body toggles a compact task list with `aria-expanded` and an associated
`aria-controls` target. The list contains every component member except the
representative exactly once, ordered by status: `in_progress`, then `todo`,
then `done`. Equal-status tasks retain complete snapshot order. The [status ordering decision](../bug-fix/2026-10-28-project-status-order.md)
applies the same priority to top-level Goals using their complete aggregate
status, with exact newest-first ties; children retain snapshot-order ties. Other starting tasks and merged descendants are included;
chain-external context remains in the graph. The list retains `done`, `in_progress` and `todo` children, including
completed tasks. The chain-level Show all control changes whole-Goal visibility; it never filters
child rows by status or completion date. The [recent browsing and pagination
decision](2026-10-27-recent-task-pages.md) owns the shared local-calendar default
while the compact-list decision sets 15-Goal pages. Expanded children remain complete and do not consume separate
parent-page entries; standalone rows apply the same recent policy individually. Child rows show
individual task status, applicable ready or blocked markers and known execution
duration immediately after the title. They open the existing task-detail dialog,
and the list heading offers the representative task's own details. Aggregate
progress still counts that representative, so the child count is one less than
the aggregate total.

Each memoized child row consumes the existing project execution clock. Running
intervals advance from the server sample and monotonic elapsed time; completed
intervals retain their persisted endpoint difference. Todo and incomplete
intervals have no duration, regardless of automatic-execution permission. A muted
clock icon and localized semantic time follow the title inline, wrapping full
text as space requires without covering status or row actions. The timing subtree
is excluded from the native button name and has no live announcements, preserving
focus and keyboard access. The shared duration component's duration-only tooltip
keeps threshold and possible-stall meaning with the existing graph-card and
standalone-row consumers. No per-row timer, network read or aggregate duration is
introduced; the [timing requirements](../../../../docs/spec/daynight-task-timing.md)
and [timing architecture](../../../../docs/design/daynight-task-timing.md) own the
shared interval and clock contracts.

Each mounted row owns an initially collapsed disclosure choice. Several rows
can be expanded together. Same-row refreshes update the member list while
preserving disclosure, as do task-detail and graph round trips. The retained
outer Task list subtree preserves those choices while Overview is visible.
Inner category departure, paging, filtering or representative replacement can
unmount a row; its next mount starts collapsed. Disclosure has no browser storage record.

A sibling View dependencies / 查看依赖关系 button opens the existing
`TaskChainDialog` without changing disclosure. The disclosure and graph actions
are native sibling controls, and the graph action's accessible name identifies
its Goal. `task-root-<id>` remains the overview navigation target on the
disclosure button. Closing the graph restores its original graph button, then
falls back to an available Goal disclosure, filter or list control when that
entry has disappeared. Task-detail closure restores the original detail entry
when visible and otherwise uses the existing project fallback.

This partially supersedes the whole-row entry in the
[graph-dialog decision](2026-10-26-task-chain-graph-dialog.md). That decision
continues to own dialog geometry, graph witness reconciliation, fullscreen,
focus containment, layered Escape and scroll locks. The
ordering and compact readable text chosen in the
[presentation decision](../../archived/feature/2026-10-21-task-chain-presentation.md) remain, as do the
independent project records chosen in the
[browsing-preference decision](../../archived/feature/2026-10-21-task-browsing-preferences.md). The
[Web requirements](../../../../docs/spec/daynight-web.md) and
[Web design](../../../../docs/design/daynight-web.md) own observable behavior
and current composition.

## Alternatives

**Keep graph-first task inspection.** The whole-row graph action gives the
dependency view a large target, but reading a task's status and details still
requires entering the graph. Direct task rows satisfy routine browsing while
the explicit graph action retains dependency inspection.

**Infer Goal membership from titles or representative descendants.** A title
prefix is not a stored task kind, and a valid component can have several
ordinary roots. Title matching would reclassify existing tasks, while following
only the representative's descendants would omit other roots. Reusing the
complete component preserves the established membership contract.

## Consequences

Routine task browsing and dependency inspection have independent controls and
state. Opening a graph preserves the expanded list and its page position.
Child-task access shares the existing details, requests and write sessions;
the list introduces no API, stored task type or preference migration. Local child
timing updates do not rebuild component membership, ordering or aggregate progress.
Mounted running rows add subscribers to the project clock while sharing its
single visible-page ticker; completed rows do not subscribe to clock ticks.

An expanded list presents all actual members rather than the graph's bounded
visible subset. Long chains therefore create long document lists, and narrow
screens allow titles and graph actions to wrap. External prerequisite context
and progressive graph expansion keep their existing graph ownership. Row-local
disclosure is intentionally transient when a row is unmounted; graph witness
reconciliation remains independent and can continue across a representative
change even when the new row starts collapsed.
