# Agent Note: Goal Task Entrances

Status: implemented

## Problem

Goal detail's Task tab placed creation and membership actions above the work a
reader came to browse. The project already provided Task creation with a Goal
choice, while the Goal tab needed to present its existing tasks and their states.

## Decision

The original removal kept loading, empty and error states, task chains and
independent Tasks in Goal detail's Task tab while removing creation and
add-existing entrances. Project Task creation retained its Goal and assignee
choices; Goal creation remained available in the Goal list. Shared forms,
membership operations and APIs remained owned by their existing consumers.

This partially superseded the [Web Goal operations decision](../feature/2026-11-11-web-goal-operations.md)
and the [read-only Goal link decision](2026-11-12-task-detail-goal-link.md),
which described the Goal detail membership entrance. The
[Goal detail information decision](../feature/2026-11-12-goal-detail-information.md)
removes the remaining detail Task panel and keeps child browsing in the project
Goal list. The [shared form skin](../bug-fix/2026-11-12-shared-form-dialog-skin.md)
continues to serve the remaining forms.

## Alternatives

**Hide the controls with CSS.** This would leave their mounted dialog entrances
and associated behavior in the Goal view instead of removing the actions.

**Remove shared form and membership code.** The project Task and Goal creation
flows still use the shared form, and other interfaces retain membership writes;
removing those owners would exceed the Goal detail boundary.

## Consequences

Users can create a Task with a Goal from the project page. Goal detail does not
provide a creation or membership entrance, and shared operations remain available
to their other consumers. The later detail information decision changes task
presentation without withdrawing those operations.
