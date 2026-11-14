# Agent Note: Assignee-scoped Task List Tab Counts

Status: implemented

## Problem

The project task list lets a person select an assignee, but its three tab
counts included other assignees. The counts could therefore misrepresent the
work in the selected scope even though the lists were filtered correctly.

## Decision

The project page derives all three counts from the complete snapshot using the
same assignee predicate as the lists, including the current viewer for `me`.
The standalone count includes matching, unfinished ordinary Tasks with no Parent,
classified by their full ordinary component and counted once by ID. The chain
count includes each multi-member component once if a no-Parent member is both
unfinished and assignee-matching. The Goal count uses each Goal's own assignee
and counts unfinished containers, as specified by the [unfinished Goal decision](2026-11-14-unfinished-goal-tab-count.md).
The [unfinished chain decision](2026-11-14-unfinished-chain-tab-count.md)
owns the chain unit. The original assignee-scope decision counted unfinished
Tasks within chains and retained Goals in every status; it addressed whose work
the badge represented. Status selection, search, pagination, category, graph and
expansion do not affect these counts. Full graph classification
precedes Parent scoping, so a cross-Goal component with one unparented member
remains a chain; external edges do not combine components.

This partially replaces the filter-independent badge scope of the archived
[unfinished count decision](../../archived/feature/2026-10-22-unfinished-task-tab-counts.md),
while retaining its complete-snapshot rationale. The later
[chain count decision](2026-11-14-unfinished-chain-tab-count.md) replaces the
chain badge's original unfinished-task unit with unfinished chains.
The [list filtering decision](../feature/2026-11-05-task-list-status-filter.md)
retains same-member matching and full chain context. The [assignee preference](../feature/2026-11-09-project-assignee-filter-preference.md)
is restored before the first matching and count projection. The related
[pause summary decision](2026-11-12-assignee-scoped-pause-summary.md) has its own
eligibility and project-wide ordinary Task scope. The [Web requirements](../../../../docs/spec/daynight-web.md)
and [design](../../../../docs/design/daynight-web.md) own the current behavior
and data flow.

## Alternatives

**Count the filtered list or its visible rows.** Status selection, pagination and
chain visibility would change the badges, while a matching chain can contain
other assignees' members. These projections do not represent the selected
assignee's unfinished tasks.

**Keep complete-project tab counts.** This preserves the former badge scope but
includes work assigned to others when the list is restricted by assignee.

## Consequences

Changing assignee immediately changes the three badges without changing the
complete graph, chain and Goal progress, or project overview statistics. The
chain count represents qualifying chains; the Goal count excludes terminal
containers under the later decisions. Snapshot and identity changes recompute
the projection without new requests or persisted data. A failed refresh retains the last
successful snapshot and its existing error feedback.
