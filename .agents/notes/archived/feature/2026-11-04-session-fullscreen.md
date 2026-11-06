# Agent Note: Independent Session fullscreen

Status: implemented

## Problem

Task metadata and navigation compete with the conversation for space even when
the task detail itself fills the viewport. Readers need to concentrate on a
Session without losing drafts, tool expansion, pending interactions, loaded
history or their reading position. A separate Test Session entry needs the same
behavior, including an exit when the Session is loading or unavailable.

## Decision

The shared `SessionView` owns a transient fullscreen mode. Its existing section
and header survive empty, loading and unavailable states; a localized icon toggle
between Display and Refresh remains reachable. CSS fills the visible browser
content viewport while retaining the browser chrome and the same React subtree,
DOM, client and connection. Fullscreen does not issue Session operations or
participate in display preferences, draft storage, execution keys or URLs.

`useSessionFullscreen` binds this view state to the client, authenticated account
and known Session identity. Inactivity, replacement identities and unmount end
the mode. The first resolved Session identity completes the binding without
leaving fullscreen; a later identity replacement ends it. A temporary missing
snapshot does not discard an already known identity. `SessionFullscreenContext`
registers the active owner and exit callback
with `TaskDetailSurface`; cleanup removes only that owner's registration. The
Surface expands in place and hides task chrome without changing its independent
task fullscreen value. Exiting the Session therefore restores the prior task
layout. After the first Session expansion, the same mounted Surface no longer
replays its entrance transform: intermediate animated geometry would corrupt
reading-position measurements on exit. The Test entry uses the same shared view without requiring a task host.

Session fullscreen isolates background branches along the ancestor chain with
counted `inert` ownership and uses the existing counted body scroll lock. These
owners coexist with an enclosing modal and release only their own acquisitions.
Focus stays within the fullscreen boundary; explicit exit returns to its available toggle
without scrolling. Inner menus consume Escape first, Session fullscreen consumes
the next Escape, and the task retains ownership of later dismissal. The Surface
does not compete with the Session's Tab or Escape handling.

The default boundary is the Session section. Hosts may supply a stable ancestor
that contains it; the [Bot details composition](../../implemented/feature/2026-11-05-bot-details-panel.md)
uses that option for its name, original Session and details without reparenting.
Registration, isolation, viewport variables and focus follow that ancestor.
Its document-level bubble listener lets inner React modal controls consume
Escape and Tab before the outer boundary acts. The default Session handler and
Task/Test behavior remain unchanged.

The existing timeline scroll owner remains mounted. Its viewport and content
observers restore the same text anchor or following intent after geometry
changes; fullscreen does not restore raw offsets over that state. A surviving
text offset remains the anchor through layout-only changes, even when a wider
line gains earlier characters. Recapturing that line would drift on a return
to the original width. Composer width observers defer height writes to one
animation frame to avoid changing observed dimensions during ResizeObserver
delivery; input and initial layout sizing remain synchronous. Where exposed,
`visualViewport` dimensions and offsets keep the view within the visible area
when browser UI or a keyboard changes it. Missing API support falls back to
window geometry, and cleanup restores the previous style values.

The [Session requirements](../../../../docs/spec/task-sessions.md#session-独立全屏)
and [design](../../../../docs/design/task-session-protocol.md#session-全屏与任务容器协作)
own the behavior and composition. This extends the nested reading model of
[task detail fullscreen](2026-10-25-task-detail-fullscreen.md) without replacing
that mode or its attachment keyboard bridge.

## Alternatives

**Fix only the Session descendant to the viewport.** Task dialog animation and
backdrop filtering can establish a containing block, while intermediate overflow
owners can clip descendants. Coordinating the existing Surface with the shared
view removes those constraints without moving the Session.

**Render a second Session or move it between portal containers.** Remounting
would disrupt local input, expanded content, pending interactions and scroll
ownership, and could recreate a client or trigger reads. Keeping one subtree
preserves these state owners directly.

**Use the browser Fullscreen API.** Its browser lifecycle and exit behavior do
not provide the requested address-bar-preserving reading mode. CSS keeps Session
exit within the existing task and menu keyboard hierarchy.

## Consequences

Task and Test readers share one fullscreen behavior while Session transport,
authorization and archive semantics remain unchanged. The task retains its
previous layout choice, and unavailable or read-only content cannot remove the
exit control or make the Session writable.

The view and task host now cooperate on geometry and keyboard ownership. Future
floating controls must remain within that ownership or explicitly define their
interaction with background isolation. Browser validation must observe layout,
focus, connection and DOM identity, and reading intent together; control presence
alone does not prove preservation. Emulated viewport sizes do not establish
behavior on a real mobile device or its software keyboard.
