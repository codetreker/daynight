# Agent Note: Task Detail Notifications Preserve Reading Space

Status: implemented

## Problem

Task details place lock explanations, mutation results, retained-data warnings
and refresh errors above the Overview and Attachments tabs. These notices
reduce the reading area and move its controls as requests finish. A long-lived
write result continues to consume space after its announcement has served its
purpose. A disabled control also needs an accessible explanation without
requiring a permanent paragraph in every open detail.

## Decision

The common task-detail surface owns a floating notification layer for mutation,
clipboard, freshness and recoverable read feedback in both dialog and page
containers. The standalone page passes retained graph errors into that same
surface, including its language-preference storage notices. The language
selector accepts a presentation callback so other application surfaces retain
their existing notice ownership. The layer does not participate in header, tab or panel sizing; it has
bounded stacking and internal scrolling for long content.

Ordinary and successful notices expire after three seconds; errors and notices
with actions expire after eight seconds. Each can be closed manually. Hover or
keyboard focus pauses the remaining lifetime. Rerenders and locale changes do
not restart it. A confirmed success already present on mount is not replayed.
Presentation expiry never clears the session's error, unknown mutation, version,
freshness requirement or write protection. Unresolved recovery keeps a compact
floating entry that can reopen its notice and expose the original retry or
GET-only reconciliation action. Removing a focused notice restores focus to an
available entry within the same interaction surface.

In-progress automatic-execution and platform controls retain their native
disabled state. Focusable wrappers supply hover/focus tooltips and accessible
lock descriptions without adding reading height. Initial loading or a failure
with no available detail remains a content state; attachment list and preview
states remain owned by their panels.

This extends the success-only overlay in the
[compact-header decision](../simplification/2026-10-24-compact-task-detail-header.md)
and replaces the allowance for actionable notices to affect layout in the
[quiet-refresh decision](2026-10-23-quiet-task-detail-refresh.md). The earlier
choices removed routine transport noise while preserving error visibility;
keeping errors actionable through a separate floating entry now preserves both
visibility and reading geometry. The [Web requirements](../../../../docs/spec/daynight-web.md)
and [design](../../../../docs/design/daynight-web.md#任务详情提示) own the current
presentation contract and component responsibilities.

## Alternatives

**Keep actionable errors above the tabs.** Persistent actions remain easy to
find, but error, reconciliation and stale-state transitions keep reducing the
reading area. Their recovery can remain reachable in a floating entry.

**Only time out the existing inline notices.** Their eventual removal returns
space but still moves the tabs at both appearance and expiry. A layout-independent
layer is required throughout the notice's lifetime.

**Remove errors and recovery actions when the bubble expires.** This would leave
an unknown write locked without a usable GET reconciliation path. Expiry belongs
to presentation; the session and recovery entry must survive it.

## Consequences

Both tabs retain their reading dimensions when notification state changes.
Transient results stop occupying permanent rows, and lock explanations remain
available to mouse and keyboard users. A shared layer coordinates overlapping
notices and modal focus rather than letting each feedback component position
itself independently.

Recoverable errors may require reopening their compact entry after timeout;
request IDs and retry/check actions remain available there. Timers and tooltip
state add presentation lifecycle responsibilities, while transport, concurrency,
confirmation, attachment state and server contracts retain their existing owners.
