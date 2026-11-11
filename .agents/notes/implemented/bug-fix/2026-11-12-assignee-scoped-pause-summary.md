# Agent Note: Scope the task list pause count by assignee

Status: implemented

## Problem

The task list heading showed the full project's paused total even when the
assignee filter restricted the tasks being browsed. The number could include
only other people's work and misrepresent the selected scope.

## Decision

The project page applies the existing assignee matching rule to all ordinary
project tasks before using the shared pause summary selector for the task list
heading. Status, category and pagination do not narrow that count. The project
overview retains its complete-project scope; chain counts retain complete
ordinary components, excluding external prerequisites. Raw task pause badges
remain independent of summary eligibility and filtering.

This partially replaces the filter-independent list heading scope in the
[pause summary eligibility decision](2026-11-10-paused-summary-eligibility.md),
whose status eligibility and distinction from raw task properties still apply.
The [Web requirements](../../../../docs/spec/daynight-web.md#暂停展示与解除) and
[design](../../../../docs/design/daynight-web.md#暂停展示与解除) own the behavior
and data flow.

## Alternatives

**Count the visible rows.** Status filtering, pagination and chain expansion
would then hide eligible tasks and make the total change with navigation.

**Keep the complete-project heading count.** This preserves consistency with the
overview but includes tasks outside the assignee scope selected for the list.

## Consequences

Switching assignees immediately updates the heading without changing overview,
chain or task-level pause presentation. The heading can differ from the overview
and chain totals because each expresses a different scope.
