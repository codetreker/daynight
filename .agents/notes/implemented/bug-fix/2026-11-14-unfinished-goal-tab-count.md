# Agent Note: Unfinished Goal Tab Count

Status: implemented

## Problem

The Goal tab badge included completed and cancelled containers, so it did not
indicate how many Goals remain unfinished for the selected assignee. The list
still needs to expose historical Goals independently of the badge.

## Decision

The project page counts Goal containers from the complete snapshot when their
own assignee matches the selected scope and their own status is `todo` or
`in_progress`. The badge excludes `done` and `cancelled`; child Task assignees,
statuses and progress do not decide whether a Goal counts. The count is
independent of list filters, pagination, search, category, graph and expansion.
The list total retains its complete Goal scope. The existing terminal-status
predicate and snapshot drive the projection without an additional request.

This partially supersedes the [assignee-scoped tab count decision](2026-11-13-assignee-scoped-tab-counts.md),
which retained all Goal statuses while establishing the shared assignee scope.
The [Web requirements](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-web.md) own the current behavior and
its data flow.

## Alternatives

**Keep all Goal statuses in the badge.** This matches the list's historical
scope but counts work that has already ended, unlike the other unfinished-work badges.

**Count the filtered or visible Goal list.** Status and label filters, search or
pagination would change the badge even when the underlying unfinished work had
not changed.

**Derive Goal eligibility from its children.** Goal status is independent of
child progress; an unfinished Goal with no unfinished children would disappear
from the count despite remaining open.

## Consequences

Completing, cancelling or reopening a Goal changes the badge when the snapshot
updates. Changing the assignee or viewer recomputes the same projection. An
empty or all-terminal matching scope displays zero, while a failed refresh
retains the last trusted snapshot and existing error feedback. Historical Goals
remain available in the list and its total is unchanged.
