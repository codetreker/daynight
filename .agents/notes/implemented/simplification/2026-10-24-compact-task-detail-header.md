# Agent Note: Compact Task Detail Header

Status: implemented

## Problem

Task reading loses vertical space to a generic dialog label, a second task-title
row, a duplicate ID and a success paragraph that remains after a permission
change. A second language selector also takes header width while details already
subscribe to the application locale. The complete ID is already available in Overview, but transferring it to
another tool requires manual selection. Long task titles and retained read errors
must still leave the dialog controls and reading panels reachable.

## Decision

The loaded task's actual title is the common header's h2 and the dialog's
accessible name. Loading and initial failure use their corresponding state
titles. The complete task title owns bounded native scrolling and keyboard focus;
status, fullscreen, action-menu and close controls stay accessible across supported
viewport sizes. Task details consume the current application locale through the
shared `LocaleProvider`; the modal header contains the title and its adjacent copy
icon, fullscreen toggle, More task actions menu and close control. The `…` trigger sits
immediately left of Close and groups Open in new tab and Delete task, leaving more
width for task reading. The standalone page uses the same menu for Delete task.
The menu retains keyboard navigation, outside dismissal and its own Escape layer.
Selecting deletion focuses the surviving menu trigger before opening confirmation,
so cancellation restores that trigger. The
[standalone-detail decision](../architecture/2026-10-24-standalone-task-detail.md)
owns that link and shares the same complete content with its page container.
The body heading places the status menu immediately before the platform selector,
with readiness after both and automatic execution at the right. Status and
platform use the same compact control height, and the left group can wrap at
narrow widths. The
[notification decision](../bug-fix/2026-10-24-task-detail-notifications.md) owns
actionable floating notices and lock tooltips. Overview metadata retains the full
selectable ID and a copy icon matching the overlapping squares immediately after
the loaded title. Both controls use `TaskCopyButton`, localized accessible names
and hover titles, and write their complete original value with the browser
Clipboard API. Pending copies disable their button; success and failure use timed
bubbles, with the original text and retry retained after failure. The title
control is scoped to project/task and title value, and the ID control to its full
ID, so unmount invalidates late results.

A successful automatic-execution setting submission observed by the open detail
produces a floating status bubble for three seconds. The bubble does not consume
layout height, move the tabs or change the reading area's available space. Its
lifetime is presentation state, independent of the task session's confirmed
mutation. Existing confirmed state on mount, background reads, language changes
and reopening do not replay success. Pending, refusal, conflict, unknown-result and reconciliation feedback now use
the common notification layer; locked controls use hover/focus tooltips. The
notification decision extends this original success-only overlay allocation
without changing operation state.

This partially supersedes the title/context allocation described by the
[withdrawal decision](../feature/2026-10-23-task-unapprove.md) while preserving its
reading-space, error and keyboard guarantees. The
[centered-dialog decision](../feature/2026-10-22-centered-task-detail-dialog.md)
continues to own the modal shell. The
[bilingual-interface decision](../feature/2026-10-22-web-bilingual-interface.md)
retains the shared locale runtime and the rationale for the original modal
selector placement; this decision removes the duplicate detail-header selector.
The [status assignment decision](../architecture/2026-10-24-task-status-assignment.md) owns versioned
actions, and the
[automation decision](../architecture/2026-10-23-task-agent-automation.md) owns
permission semantics. The [Web requirements](../../../../docs/spec/daynight-web.md)
and [design](../../../../docs/design/daynight-web.md) own current visible behavior
and component responsibilities.

## Alternatives

**Keep the full title in the body's existing heading context.** That context
already supports complete keyboard reading alongside retained notices, but it
leaves a separate generic header and a second title row above the materials.
Moving the actual title into the header retains complete reading through a
bounded title scroller while removing that duplication.

**Keep confirmed permission feedback as an inline paragraph.** It provides a
persistent result but consumes task-reading height after the operation ends.
The session already preserves the result; a temporary overlay announces success
without allocating permanent layout space or changing mutation state.

## Consequences

The common header carries task identity with fewer repeated rows and an explicit
title transfer action, while the ID has its transfer action in its metadata owner.
One copy component keeps both icons, pending behavior and feedback consistent.
Browser clipboard denial remains visible and recoverable through retry or manual selection. Very long
titles require scrolling within their bounded title region while the rest of
the controls and reading panels remain available.

Success bubbles are observed while the detail is mounted; an operation completed
while it is closed remains confirmed in the session and does not become a new
notification on reopening. Presentation timers are cleaned up with the feedback
component. This changes neither permission confirmation nor request ownership,
version checking, reconciliation, refresh scheduling, attachment state or modal
focus restoration.
