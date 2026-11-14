# Agent Note: Open paused tasks from the project list heading

Status: implemented

## Problem

The task list heading reported a paused count but did not identify its tasks.
An operator had to search the project or navigate through categories and pages
before opening a particular paused task. The count can include Goal children and
cancelled tasks that are not in the visible list.

## Decision

The heading badge opens an anchored native popover containing the same ordered,
assignee-scoped ordinary tasks as its count. The project snapshot supplies each
row's preview, truncation indication, short ID and status without additional reads.
Selecting a row closes the popover and opens that exact task through the existing
summary detail and history path. The stable badge is the detail focus return
point; a visible task tab or project heading is the fallback when the badge
vanishes.

The [pause eligibility decision](../bug-fix/2026-11-10-paused-summary-eligibility.md)
retains the distinction between raw pause markers and summary eligibility; the
[assignee-scoped summary decision](../bug-fix/2026-11-12-assignee-scoped-pause-summary.md)
retains the heading's scope. The [Web requirements](../../../../docs/spec/daynight-web.md#暂停展示与解除)
and [design](../../../../docs/design/daynight-web.md#暂停展示与解除) own the
interaction and data flow.

## Alternatives

No other alternative was recorded for this entry point.

## Consequences

Users can distinguish and open eligible tasks without changing their current
list category, filters, page or expansion. The menu must track real snapshot
changes while preserving focus and scroll across unchanged refreshes; a removed
focused row needs a nearby target, and an empty collection needs a visible
fallback. The preview can be truncated, so the complete title remains owned by
the task detail. The project overview, chain summaries, raw pause markers and
pause writes keep their existing semantics.
