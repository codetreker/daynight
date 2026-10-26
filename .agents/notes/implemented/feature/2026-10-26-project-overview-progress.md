# Agent Note: Project Overview Progress

Status: implemented

## Problem

Project totals show how much work is complete without identifying which ongoing
outcome needs attention. Readers must enter task browsing and find the relevant
chain themselves. A cumulative standalone percentage also lets old completions
dominate the current backlog, obscuring recent work.

## Decision

Overview adds one row per unfinished ordinary-dependency component and a final
standalone aggregate while standalone work remains unfinished. Chain membership,
representative titles, progress and ordering come from the same complete index
as Task list. A completed representative does not complete its remaining group;
external prerequisites remain outside its progress. Percentages are floored.

Standalone progress counts known completions within the inclusive rolling last
seven days; its total adds all unfinished standalone tasks. Old and unknown
completion times are excluded from this aggregate. The explanatory row copy
identifies the window. Project cards and task-list filters retain their existing
full-history semantics.

The window uses the snapshot's server observation plus monotonic elapsed time,
with precise completion boundaries and a deadline for the next relevant change.
Visibility recovery recomputes the window even without another successful sync;
inactive Overview releases its display timer. Execution-duration subscriptions
keep their separate owner. This extends the [section decision](2026-10-25-project-overview-task-sections.md)
without adding another network loop or index.

Overview navigation sets a one-use task witness or standalone destination. The
project owner selects both levels, lets the existing scroll hook restore its
position, then positions and focuses the mounted target before paint and records
that new location. A chain witness resolves against the latest component; an
unavailable target returns focus to its category with a message. Positioning is
separate from opening a graph, preserves completion preferences, and clears its
brief highlight on timeout or cleanup. Required behavior belongs to the
[Web specification](../../../../docs/spec/daynight-web.md#项目整体进度); the
[Web design](../../../../docs/design/daynight-web.md) owns the composition.

## Alternatives

**Count all historical standalone completions.** This was the original aggregate
proposal, but an accumulating denominator would emphasize old throughput over
ongoing work. The rolling completion window retains recent progress while
including every unfinished task regardless of age.

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

Readers can compare unfinished outcomes and move directly to their task group.
The recent aggregate can change as completed work ages out even when task data
is unchanged. Completion timestamps without a known time cannot establish
recency. The server time anchor avoids device-clock skew, while monotonic time
and visibility recovery keep deadline work independent of polling success.

Explicit navigation overrides saved scroll for one activation only. Ordinary
browsing continues to restore independent positions, and graph opening remains
a separate operation. Regression coverage must exercise boundary expiry without
new data, first-use mounting, old saved positions, changed representatives,
unavailable targets, keyboard focus, both languages and narrow layouts.
