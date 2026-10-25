# Agent Note: Task Attachment Management in the Web Drawer

Status: implemented

## Problem

Tasks can store path-addressed files through the service, but users need to
browse those files, change one file at a time and inspect design documents or
interactive mockups from the task detail workflow. File reads and writes have
lifetimes independent of the graph snapshot and task detail request. Native
preview frames also add a second keyboard document to a drawer whose background
must remain inert and whose closing focus must survive DOM removal.

## Decision

The [attachment requirements](../../../../docs/spec/daynight-task-attachments.md)
and [architecture](../../../../docs/design/daynight-task-attachments.md) own file
behavior and backend contracts. The
[adoption note](../architecture/2026-10-21-task-attachment-storage-design.md)
retains bucket/path addressing, trusted same-origin execution and accepted K1.
This decision implements the browser portion of that design. It extends the
[read-only dashboard baseline](../architecture/2026-10-20-task-dashboard-mvp-design.md)
and [project browsing foundation](../architecture/2026-10-20-web-project-browsing.md)
without changing task fields, dependency policy or graph snapshots.

The original composition placed `TaskAttachments` after PR associations so file
management extended the existing task-reading workflow without introducing a
second task surface. The [split-view decision](../architecture/2026-10-22-task-attachment-split-view.md)
partially supersedes that placement: `TaskDetailDialog` now keeps attachment
management in a dedicated tab with adjacent inventory and preview panes and one
right-side vertical scroll owner. The [centered detail decision](2026-10-22-centered-task-detail-dialog.md)
retains the outer shell and modal lifecycle. The
[full-reader decision](../architecture/2026-10-22-task-attachment-full-reader.md)
extended the shared renderer with a reloadable nonmodal page and originally
scoped the frame keyboard bridge to actual dialog use. The
[fullscreen-reading decision](2026-10-25-task-detail-fullscreen.md) extends that
bridge to an explicit reading owner for dialog and focused standalone modes,
while normal standalone mode retains native keys. The
[shared-page decision](../architecture/2026-10-24-shared-attachment-page.md) composes
the complete attachment panel in both containers while keeping URL/history in
the standalone outer page. One file input
initializes a target path from the filename; users may edit it to a nested path.
`mime` 4.1.1 derives Content-Type from that target, so changing a source filename
does not silently determine the saved path's type. Same-path upload overwrites;
files provide download and deletion. The [deletion confirmation decision](2026-10-23-attachment-delete-confirmation.md) places deletion in each file row's action menu and requires explicit full-path confirmation. Success refreshes only attachment data.

The hook keeps scoped list, write, selection and preview state. The
[Markdown description decision](../architecture/2026-10-22-task-description-markdown.md)
places one hook in `TaskDetailReading`, shared by description navigation and
`TaskAttachmentsPanel`; the independent `TaskAttachments` wrapper retains its
own hook. It follows all pages, validates tree conflicts and repeated cursors,
and labels continuation failures as an incomplete list while retaining already-read files. Abort and
request generations prevent old scopes or selections from replacing current
results. A path selected before its metadata arrives stays in preview loading
state. An unknown kind does not take the ready path used by known formats that
need no text read or availability check. Otherwise the arriving HTML/PDF metadata
could mount a frame using that premature ready state before the preview effect
starts its HEAD check, then remove it again while the check is pending. Preview
depends on both path and metadata `updatedAt`; manual refresh therefore rereads
changed text, while successful overwrites also advance preview revision. Deleting an unselected path preserves the current preview identity and reading position; selected deletion clears its preview.
Path/timestamp identity remounts native previews after overwrite.

`MarkdownContent` shares `react-markdown` 10.1.0 and `remark-gfm` 4.0.1 for
CommonMark and GFM tables. The
[flowchart decision](2026-10-24-markdown-flowcharts.md) extends that same renderer
with static Mermaid flowcharts and independent diagram errors/source across
embedded and standalone readers. Raw HTML remains escaped. Attachment Markdown images
and links resolve from the actual document directory within the task preview
tree; descriptions explicitly use the task root. Standalone fragments remain
fragments. The Markdown description decision owns ordinary in-dialog attachment
navigation and complete-inventory failure handling. Text uses plain nodes,
images use native loading/error feedback, and HTML/PDF use a normal iframe after
a HEAD availability check. HEAD failures use status and request ID without
attempting JSON body decoding. The frame's GET and relative-resource requests
follow normal browser behavior at the fixed same-origin preview URL. HTML is
trusted project code with main-origin privileges; there is no sandbox, token,
Service Worker or separate preview origin.

The [dashboard lifecycle](2026-10-20-project-task-dashboard.md) retains portal,
background inertness and scroll ownership. `tabbable` 6.5.0 supplies normal
production visibility and keyboard-order checks for form controls, CSS-hidden
elements, iframes and contenteditable. A loaded same-origin frame with an active
reading owner registers Escape and boundary Tab/Shift+Tab bridges into that root.
Loaded document or owner changes release old listeners; current callbacks do not
require a frame reload. A per-event final Window handler lets existing Document
and Window consumers prevent an outer shortcut before synchronous Escape/Tab
handling. Abortable cleanup releases pending handlers without accessing a
WindowProxy after cross-origin navigation. Replacement, disabling and unmount
release the bridge under the fullscreen-reading decision. The [passive restoration decision](../bug-fix/2026-10-20-drawer-focus-restoration.md)
continues to restore a surviving trigger after sibling DOM removal.

The Vite-only `/tests/mockups/attachments.html` entry reuses actual attachment
components and CSS with an in-memory fixture API and local native-preview files.
It supports file, empty and upload-error scenarios without Go, PostgreSQL or
network API calls. Allocated object URLs remain valid through file deletion and
are revoked when the fixture is disposed. Production builds retain one application
index and exclude fixture entry points and files.

The [authentication decision](../architecture/2026-10-22-auth-architecture.md)
preserves this trusted same-origin execution model. Authentication uses the main
session for normal attachment requests and does not introduce a preview domain,
preview credential or cross-origin keyboard bridge.

## Alternatives

**Keep the drawer's compact selector enumeration.** It does not represent the
complete browser Tab order once file/text inputs, CSS-hidden controls, iframes
and contenteditable participate. The shared upstream enumerator supplies those
rules without creating a second focusability implementation.

**Let iframe keyboard events stay inside the frame.** Native resources still
load, but Escape cannot close the task drawer and boundary Tab navigation can
leave its owned cycle. A same-origin document bridge preserves the existing
drawer interaction and its passive close/restoration policy.

Preview origins, sessions and worker routing were considered in the adoption
note; that decision continues to own their costs and the trusted-code boundary.

## Consequences

The browser can manage and preview individual files without turning attachment
changes into task edits or graph refreshes. Mutable URLs use the service's
no-store policy; matching metadata timestamps make an explicit refresh observable
in both text and native previews. Failed requests remain visible, and K1 can
still leave files and PG metadata inconsistent. No recovery or coordination is
introduced here.

Unit tests cover API decoding, scoped state, path trees, rendering and focus
integration. Deferred inventory and availability responses verify that early
selection stays loading and no native frame mounts before its availability
check. JSDOM has no layout; its test-only wrapper delegates traversal to
upstream `tabbable` with layout checks disabled, so it does not prove browser
visibility. Source-bound local Chromium probes exercise the real portal,
inertness, CSS-hidden and contenteditable boundaries, same-origin frame keys,
close release and trigger restoration. Their receipts record the existing local
browser override and owned-resource cleanup; they are not pinned CI-browser or
real-backend acceptance. PR and CI artifacts retain runtime results rather than
turning this note into a test transcript.

The [cross-layer acceptance decision](../testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
owns real-backend production-browser journeys, installed CLI/service combination,
visible PDF content and the combined CI inventory. Existing graph
production/performance gates remain intact. The frontend mockup itself proves
neither PostgreSQL persistence nor combined delivery.
