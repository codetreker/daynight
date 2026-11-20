# Agent Note: Open paused tasks from project headings

Status: implemented

## Problem

The task list heading reported a paused count but did not identify its tasks.
An operator had to search the project or navigate through categories and pages
before opening a particular paused task. The count can include Goal children and
cancelled tasks that are not in the visible list.

## Decision

Overview and Task list share an anchored native popover containing the same
ordered, deduplicated ordinary tasks as their respective counts. Overview uses
the complete project scope; Task list applies its assignee filter. A single
eligible task still opens the menu. The project snapshot supplies each
row's preview, truncation indication, short ID and status without additional reads.
Selecting a row closes the popover and opens that exact task through the existing
summary detail and history path. The stable badge is the detail focus return
point together with its originating section. If the badge vanishes, Overview
returns to its visible section tab and then the project heading; Task list keeps
its existing category and section fallbacks. Empty open menus use the same source
fallback. Leaving the originating section closes its menu.

The [pause eligibility decision](../bug-fix/2026-11-10-paused-summary-eligibility.md)
retains the distinction between raw pause markers and summary eligibility; the
[assignee-scoped summary decision](../bug-fix/2026-11-12-assignee-scoped-pause-summary.md)
retains the heading's scope. The [Web requirements](../../../../docs/spec/daynight-web.md#暂停展示与解除)
and [design](../../../../docs/design/daynight-web.md#暂停展示与解除) own the
interaction and data flow.

## Alternatives

**Open the first eligible task from Overview.** This was the original Overview
behavior, but it gave no direct choice among the remaining blocked tasks. Sharing
the existing menu makes every counted task selectable and keeps the same
keyboard, layout and focus behavior across both entry points.

## Consequences

Users can distinguish and open eligible tasks without changing their current
list category, filters, page or expansion. The menu must track real snapshot
changes while preserving focus and scroll across unchanged refreshes; a removed
focused row needs a nearby target, and an empty collection needs a visible
fallback. The preview can be truncated, so the complete title remains owned by
the task detail. Overview retains its complete-project scope and does not change
list filters or navigate categories when a task is selected. Chain summaries, raw
pause markers and pause writes keep their existing semantics.
