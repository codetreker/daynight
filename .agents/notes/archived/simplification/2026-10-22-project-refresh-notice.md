# Agent Note: Project Refresh Feedback

Status: implemented

## Problem

A separate loading notice appears between the project heading and statistics
during manual refresh. Its temporary row moves the retained task content while
the refresh button already indicates the active request.

## Decision

Manual project refresh uses the existing button's busy text and disabled state.
It does not insert an informational loading notice. The last successful snapshot
remains visible, and refresh failures retain their error and retry action.
Preference failures, removed-task notices and detail/graph mismatch feedback
retain their existing presentation. The unused loading-notice message is removed
from the shared message type and both locales.

This decision partially supersedes the refresh presentation in the
[project dashboard decision](../feature/2026-10-20-project-task-dashboard.md).
The original separate notice made retained snapshot freshness explicit during a
request. Button feedback and the existing failure state preserve request and
failure visibility without inserting a temporary row. Request scheduling,
cancellation and snapshot ownership continue to follow the
[automatic refresh decision](../feature/2026-10-22-project-task-auto-refresh.md).

The [requirements](../../../../docs/spec/daynight-web.md) own the visible behavior;
the [design](../../../../docs/design/daynight-web.md#请求刷新与故障) owns request
and rendering responsibilities.

## Alternatives

**Keep the separate loading notice.** It explicitly describes the retained
snapshot, but duplicates the button's request feedback and shifts the statistics
and task content on every manual refresh.

## Consequences

Starting a manual refresh preserves the vertical position of statistics and task
content. The button identifies the pending request; a retained snapshot is no
longer accompanied by a loading explanation. Initial loading and recoverable
failure remain distinct states, and the shared notice styling remains available
for other project notices.
