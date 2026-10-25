# Agent Note: Fullscreen task detail reading

Status: implemented

## Problem

Long task descriptions and attachment previews compete with dialog gutters and
auxiliary page controls for reading space. Expanding that view must retain its
selected content, input drafts, loaded documents and pending operations. Keyboard
users need a predictable way to leave expanded reading before dismissing the task,
including when focus is inside a same-origin attachment application.

## Decision

The dialog and standalone outer reading workspaces own a transient fullscreen
boolean. `TaskDetailSurface` receives `DetailFullscreen` (`active`, `onChange`)
and renders one title-bar toggle. Its existing section/main gains
`task-detail-fullscreen`; CSS fills the browser content viewport with the same
Surface, portal, presentation, keys and panel positions. Relationship navigation
retains mode within the workspace. Closing or unmounting ends it; reopening
starts normal mode. URL, history and persistent preferences do not store mode.

Before a mode change, application-owned descendant scrollers retain both offsets;
a layout effect restores them on the same elements within the browser's resulting
legal ranges. This includes title, overview, inventory and preview scroll owners.
Native HTML/PDF retain their frame identity and URL, leaving internal scrolling
to the document or browser reader. Controllers, file inputs, drafts and
`TaskDetailSession` retain their existing lifetimes, including pending writes.
Mode changes add no business requests or independent mutation state.

The Surface handles semantic Escape after a child has had an opportunity to
consume it: leave fullscreen and focus the toggle with `preventScroll`, then
close a normal dialog. Normal standalone Escape retains native browser behavior.
Standalone fullscreen hides the auxiliary return/language bar while retaining an
explicit project-return link in the title bar. It restores the same bar on exit.
Existing modal inertness, focus containment and counted body scroll ownership
remain attached to the dialog lifetime and are not reacquired for its mode switch.
Menus and confirmations retain their own keyboard layer. Graph fullscreen stays
below the detail portal: Escape handles child, detail fullscreen, detail dialog,
then graph fullscreen in that order.

`AttachmentKeyboardOwner`, exported by `AttachmentPreview`, carries the active
reading `root` and `onEscape` through Reading and the attachment panel. Dialogs
always provide it; standalone pages provide it only while fullscreen. A frame
load records its same-origin `Document`; a layout effect follows that document
and owner root. The callback ref remains current without rebinding the document.
The document listener adds a final Window handler for each Escape/Tab event,
after the child application's current Window consumers. That handler checks
`defaultPrevented` and handles the same event synchronously, retaining native
Tab timing while allowing Document and Window consumers to take precedence.

Each pending handler has an `AbortController` signal. A parent-window cleanup
timer releases handlers left behind by stopped propagation. Document or owner
changes, disabling and unmount remove the document listener and abort all pending
handlers. Abort-based cleanup avoids dereferencing a WindowProxy that may have
become inaccessible after cross-origin navigation. Loaded standalone frames
therefore acquire and release the bridge without reloading or resetting child
state.

This extends the [centered detail](2026-10-22-centered-task-detail-dialog.md),
[standalone detail](../architecture/2026-10-24-standalone-task-detail.md) and
[shared attachment page](../architecture/2026-10-24-shared-attachment-page.md)
decisions while preserving their original composition and request guarantees.
It also extends the nested dismissal order of the
[fullscreen graph](2026-10-22-task-graph-fullscreen.md). The
[inspection requirements](../../../../docs/spec/daynight-task-inspection.md)
TI16 and [design](../../../../docs/design/daynight-task-inspection.md#全屏阅读工作区)
own behavior and structure; the
[attachment design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
owns native-preview listener and scrolling details.

## Alternatives

**Browser Fullscreen API.** Expanding an element through the browser can exclude
body portals and their child confirmations, adding a browser lifecycle and exit
path to the existing modal owners. CSS viewport sizing preserves that composition
and provides the requested browser content space.

**Navigate to a new page or mount a second Surface.** A separate reading instance
would need to transfer local tab/file choices, upload input state, child document
state and active mutations. Retaining the existing DOM preserves those owners
directly and avoids additional reads.

**Keep the frame bridge bound only to dialog load.** That condition cannot enable
keyboard ownership for an already-loaded standalone frame entering fullscreen.
An explicit owner and document lifecycle allow mode changes without a reload.

## Consequences

Task reading gains the available viewport while preserving existing state and
request semantics. Flexible zero-minimum sizing and internal scroll owners keep
exit and close controls available at narrow widths and short heights. The
standalone page remains an ordinary page after exit, with no guessed history
target or window-close behavior.

Native PDF readers may not expose a controllable same-origin document. The
explicit exit/return controls remain available, and real PDF rendering and key
behavior need browser-specific evidence separate from HTML bridge tests. The
implementation does not manage arbitrary child-HTML scroll positions; retaining
frame identity leaves those positions with their existing native owner. A future
cross-origin or sandboxed preview model would need a separate keyboard protocol
and must reconsider this same-origin document assumption.
