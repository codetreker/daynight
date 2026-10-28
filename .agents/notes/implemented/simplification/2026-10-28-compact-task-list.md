# Agent Note: Compact Task Lists

Status: implemented

## Problem

A separate duration line and repeated chain labels consume vertical space without
helping users scan current activity. Unfinished counts combine pending and active
work, so they cannot show how many tasks are running. Task-list pages also need
a smaller top-level limit without changing overview browsing or complete chain
membership.

## Decision

Standalone duration and warning indicators follow creation time inside the
wrapping ID and creation-information line. Existing execution-clock, missing-time
and accessible-description behavior remain shared with the timing presentation.
Chain headers omit the Goal label and total/unfinished summary. A localized
in-progress member count follows the title, including zero. `ChainRow` reads the
ordinary component's complete member IDs and counts only `in_progress` tasks,
including its representative and excluding external-only context. Aggregate
status and completed progress retain their separate meanings.

Both task categories use 15 top-level entries per page. `usePagination` accepts a
page size so overview retains 20; overview navigation calculates its destination
using the task-list size. Complete chain children stay inside one parent entry.
The [recent browsing decision](../feature/2026-10-27-recent-task-pages.md) retains
filtering, ordering, page retention, reset and clamping. The
[Goal-list decision](../feature/2026-10-26-goal-task-lists.md) retains disclosure,
member ordering, detail access and graph controls. Required behavior belongs to
the [Web specification](../../../../docs/spec/daynight-web.md), and composition
to the [Web design](../../../../docs/design/daynight-web.md).

## Alternatives

**Change the shared page size for every list.** That also changes overview page
boundaries. Passing a size to the existing hook preserves overview behavior and
keeps one pagination lifecycle.

**Reuse unfinished count as active count.** That includes pending tasks, and
aggregate in-progress status can persist when every remaining task is pending.
Counting individual member status expresses current activity accurately.

## Consequences

Desktop rows use less vertical space. Long titles and metadata can still wrap.
When the row container is at most 600px wide, the title and count occupy the
disclosure row, with progress and status on a separate line. A container query
uses the actual row width because expanded workspace and project navigation can
leave a narrow row even in a wider viewport. This keeps short English titles
from squeezing the count into adjacent metrics. Counts refresh with
the existing index rather than introducing a new state or backend field. A page
still bounds parent entries rather than expanded children, and synchronization
retains the complete graph.
