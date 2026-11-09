# Agent Note: Dismissible Project Task Removal Notice

Status: implemented

## Problem

When a selected task disappears from the next project snapshot, its details
close and a project notice remains above the content. The notice has no manual
close control, so it continues taking space after the user has read it.

## Decision

Only the selected-task-removed notice has a right-aligned native × button with
a localized accessible name. Activation clears the current notice and focuses
the project heading without scrolling. The existing removal effect already
clears the detail selection, so later snapshots cannot recreate that event;
selecting another task allows its subsequent removal to produce a new notice.
Dismissal changes no task data, view preferences or request scheduling.

The text wraps in a shrinking flex item while the button retains its size.
The application supplies the visible keyboard focus style. Other project
notices retain their existing presentation. The
[Web requirements](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-web.md#请求刷新与故障) own the visible
behavior and state responsibilities.

## Alternatives

**Persist dismissal or track removed task IDs.** The cleared detail selection
already prevents replay of the same event. Additional stored state would need
invalidation rules to avoid suppressing a later independent removal.

## Consequences

Users can reclaim the notice's space with a pointer or keyboard, and keyboard
focus has a stable destination when the button disappears. A later independent
event remains visible. This adds a local presentation control without sharing
the task-detail notification layer or changing other project notices.
