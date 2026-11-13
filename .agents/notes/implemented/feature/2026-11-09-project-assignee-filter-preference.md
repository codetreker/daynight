# Agent Note: Project Assignee Filter Preference

Status: implemented

## Problem

A person browsing a project by assignee loses that selection after a reload or
return visit. Reapplying it interrupts the task list workflow, and restoring a
selection after displaying the unfiltered first page would briefly expose the
wrong list. Different accounts using the same browser also need independent
choices, including the meaning of “me”.

## Decision

The shared task-list assignee filter is stored in localStorage per origin,
project and authenticated user. The saved union admits all, me, unassigned and
a specific user; missing or invalid values fall back to all. The selection is
read before list matching and pagination, and “me” is interpreted using the
current authenticated user. Choosing all saves the unrestricted choice.
Overview navigation also saves the resulting assignee condition when it must
clear an obstruction. Read, validation and write failures leave current-session
interaction available and report the preference error.

Only this filter is added to browser persistence; status, search and page
numbers retain their existing lifetimes. The [filter decision](2026-11-05-task-list-status-filter.md)
retains the combined matching, pagination and complete-chain guarantees. The
[original browsing preference decision](../../archived/feature/2026-10-21-task-browsing-preferences.md)
explains why browser-local, independent records were chosen for viewing
preferences and why temporary graph opening has a separate lifetime. The
[original task-view decision](../../archived/feature/2026-10-22-project-task-views.md)
records the earlier in-memory list filters; assignee selection now has a longer
lifetime and an additional account boundary.

## Alternatives

**Keep the assignee filter in project component memory.** It avoids storage and
is sufficient during a visit, but loses the selection on reload or navigation
away from the project. The local preference preserves that browsing intent while
leaving task data and access rules unchanged.

## Consequences

Restoration is local to one browser origin and does not synchronize across
browsers. Account and project isolation prevent one choice from becoming
another account's or project's default. Browser storage can be unavailable or
contain invalid data; an error is visible and the session remains usable without
claiming the value was saved. The full project snapshot, graph context and overview statistics remain
independent of the displayed filter. The [tab count decision](../bug-fix/2026-11-13-assignee-scoped-tab-counts.md)
uses the restored assignee selection when deriving tab counts.
