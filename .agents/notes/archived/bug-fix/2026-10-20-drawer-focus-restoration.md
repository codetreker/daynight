# Agent Note: Restore drawer focus after DOM removal

Status: implemented

## Problem

Refreshing a project can remove the selected task and its root chain while the
detail drawer is open. The drawer must close and leave keyboard focus on a
surviving task, the current root button or the project heading. The original
unmount cleanup could focus a connected old trigger before sibling RootList DOM
deletion. Removing that focused trigger then left document.body active, with no
later restoration to the surviving fallback.

The [hosted failure](https://github.com/codetreker/daynight/actions/runs/39431613496/job/118657806370)
exposed this refresh path. The [original drawer implementation](https://github.com/codetreker/daynight/blob/faaa7314c94d8253fb25e70257b80aff4ada6a1f/packages/daynight-web/src/features/task-detail/TaskDrawer.tsx)
combined restoration with layout teardown. The isolated ProjectPage drawer mock
used passive cleanup and its immediate assertion could observe focus before the
whole refresh committed; it did not reproduce the real portal/sibling ordering.

## Decision

`TaskDetailDialog` keeps modal ownership in useLayoutEffect: it enters the dialog and
locks the background before paint, then synchronously removes the key listener
and restores prior inertness and body overflow during teardown. A separate
useEffect([]) cleanup restores focus on unmount, after DOM mutations have removed
the old sibling content. The callback is read from the existing latest-callback
ref, so relation selection retains one dialog lifetime and does not briefly
restore focus to an earlier task.

This follows React's documented unmount ordering: [useLayoutEffect](https://react.dev/reference/react/useLayoutEffect)
cleanup precedes DOM removal, while [useEffect](https://react.dev/reference/react/useEffect)
cleanup follows removal. The original ProjectPage selection policy used the
connected original trigger, otherwise the expanded root button, otherwise the
project H1. The later [task view decision](../../implemented/feature/2026-10-22-project-task-views.md)
extends the fallback to controls visible in the active category while retaining
the empty-project heading. Restoration evaluates the current policy against
the committed DOM rather than a node pending deletion.

The integration suite renders real ProjectPage, ChainList and portal TaskDetailDialog,
mocking only the canvas and API transport. It waits for final focus after refresh
to no tasks, refresh to a remaining root, and ordinary close. It also verifies
that the deleted trigger is disconnected, the dialog is gone, background
inertness is released and previous scroll ownership is restored.

## Alternatives

**Keep restoration in combined layout cleanup.** This preserves the former
single cleanup but admits the demonstrated sibling-deletion race: isConnected
is true when tested and false after the same commit, leaving focus on body.
The existing passive drawer mock cannot establish that production ordering.

## Consequences

Modal teardown remains synchronous; focus restoration runs after DOM removal.
The repair introduced no timer, frame delay or fallback-selection policy. The three real
integration cases cover the ordering that the isolated mock missed; the
empty-project case fails against the original source with the normal waitFor
deadline.

The repaired source passes typechecking, 27 focused cases and the full 314-case
functional/36-case tooling suite, with raw coverage 718/724 across 19 product
files and 100% functions. Its complete local native/container browser run passes
all 20 scenarios, fifteen capacity repetitions, independent limits and geometry
checks. These are local development results; the focused repair's PR and
source-bound browser receipts retain binary/image and cleanup identity. The
repair is delivered through [PR #57](https://github.com/codetreker/daynight/pull/57),
with [direct-main verification](https://github.com/codetreker/daynight/actions/runs/39439839782).
Earlier dashboard acceptance receipts
retain their original source identities. The
[dashboard decision](../feature/2026-10-20-project-task-dashboard.md) owns the
broader portal and detail lifecycle, and the [design](../../../../docs/design/daynight-web.md)
owns the current mechanism. The later
[Web attachment decision](../feature/2026-10-21-task-attachment-web.md) adds complete
tabbable enumeration and same-origin frame keyboard bridges while preserving
this passive teardown ordering. The task view decision owns the subsequent
active-category restoration policy. The
[centered detail decision](../../implemented/feature/2026-10-22-centered-task-detail-dialog.md)
replaces the reading layout and component name while retaining this separation
between synchronous modal teardown and passive focus restoration.
