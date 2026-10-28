# Agent Note: Project Overview Progress

Status: implemented

## Problem

Project totals show how much work is complete without identifying which ongoing
outcome needs attention. Readers must enter task browsing and find the relevant
chain themselves. A cumulative standalone percentage also lets old completions
dominate the current backlog, obscuring recent work.

## Decision

Overview presents ordinary-dependency components with representative titles,
complete progress and ordering from the same index as Task list. A completed
representative does not complete its remaining group; external prerequisites
remain outside progress. Percentages are floored. The standalone aggregate
combines recent known completions with every unfinished standalone task, keeping
old throughput out of the denominator. Project statistic cards retain complete
history. The [status ordering decision](../bug-fix/2026-10-28-project-status-order.md)
places chain and standalone progress together by aggregate status, retaining
existing order within each status.

The original overview decision showed unfinished components only, kept the
standalone row only while unfinished work remained, and used an inclusive
rolling seven-day window for its recent count. The [recent browsing and
pagination decision](2026-10-27-recent-task-pages.md) replaces those policies with
seven local calendar days, recent completed Goal rows and 100% standalone
aggregates. It also makes that recent subset the task lists' default, while
Show all preserves explicit historical access. Component identity and the recent
standalone denominator retain their original purpose.

Current time uses the snapshot's server observation plus monotonic elapsed time.
The [local summary display decision](../architecture/2026-10-27-project-cache-display.md)
allows provisional classification using client wall time before that first live
sample; successful synchronization replaces this provisional time basis. The
shared project deadline applies local calendar boundaries in both sections,
pauses while the page is hidden and recalculates on visibility recovery even
without another successful sync. Execution-duration subscriptions retain their
separate owner; no second network loop or index is introduced.

Overview navigation sets a one-use task witness or standalone destination. The
project owner selects both levels, lets the existing scroll hook restore its
position, selects the destination page, then positions and focuses the mounted
target before paint and records that new location. A chain witness resolves
against the latest component; an unavailable target returns focus to its
category with a message. Positioning remains separate from graph opening,
preserves Show all preferences, and clears its brief highlight on timeout or
cleanup. Required behavior belongs to the [Web specification](../../../../docs/spec/daynight-web.md#项目整体进度);
the [Web design](../../../../docs/design/daynight-web.md) owns composition.

## Alternatives

**Count all historical standalone completions.** This was the original aggregate
proposal, but an accumulating denominator would emphasize old throughput over
ongoing work. A recent completion window includes every unfinished task without
letting historical completions dominate. Its original rolling-duration boundary
is superseded by the local-calendar decision above.

**Recognize only titles prefixed with `[Goal]`.** Titles are not an authoritative
Goal type, and a newly registered single-task Goal has no ordinary chain yet.
Reusing existing membership keeps Overview and Task list consistent without
introducing a second ownership rule.

**Use execution-clock subscriptions for recent completion.** Those subscriptions
are active for running durations and live inside Task list. Recent-completion
expiry must also work in Overview when no task is running, so it shares the time
basis with a separate deadline owner.

**Navigate through new project routes.** Existing section and category choices
are local project preferences. A one-use target fits those owners and preserves
URL/history and stored formats; a new routing contract is unnecessary for the
in-project positioning action.

## Consequences

Readers can compare ongoing and recently completed outcomes and move directly to
their task group. The recent aggregate can change as completed work ages out
without a task-data change. Unknown completion timestamps cannot establish
recency. Provisional local classification can reflect device-clock skew until
the first successful sync. The server anchor then avoids that skew, while
monotonic time and visibility recovery keep deadline work independent of polling
success; local calendar interpretation still belongs to the browser time zone.

Explicit navigation overrides saved scroll for one activation only, including
when its Goal is on another task-list page. Ordinary browsing restores
independent positions, and graph opening remains a separate operation. Regression
coverage exercises local calendar expiry without new data, first-use mounting,
old saved positions, changed representatives, unavailable targets, cross-page
focus, both languages and narrow layouts.
