# Agent Note: Goal Task Entrances

Status: implemented

## Problem

Goal detail's Task tab places creation and membership actions above the work a
reader came to browse. The project already provides Task creation with a Goal
choice, while the Goal tab needs to present its existing tasks and their states.

## Decision

Goal detail's Task tab presents loading, empty and error states, task chains and
independent Tasks without creation or add-existing entrances. Project Task
creation retains its Goal and assignee choices; Goal creation remains available
in the Goal list. Shared forms, membership operations and APIs remain owned by
their existing consumers.

This partially supersedes the [Web Goal operations decision](../feature/2026-11-11-web-goal-operations.md)
and the [read-only Goal link decision](2026-11-12-task-detail-goal-link.md),
which described the Goal detail membership entrance. The [shared form skin](../bug-fix/2026-11-12-shared-form-dialog-skin.md)
continues to serve the remaining forms.

## Alternatives

**Hide the controls with CSS.** This would leave their mounted dialog entrances
and associated behavior in the Goal view instead of removing the actions.

**Remove shared form and membership code.** The project Task and Goal creation
flows still use the shared form, and other interfaces retain membership writes;
removing those owners would exceed the Goal detail boundary.

## Consequences

The Goal Task tab has no action toolbar or replacement creation entrance. Users
can create a Task with a Goal from the project page; this decision does not add a
Web entrance for assigning an existing Task from Goal detail. Existing Goal
reading, navigation and task presentation remain independent of these controls.
