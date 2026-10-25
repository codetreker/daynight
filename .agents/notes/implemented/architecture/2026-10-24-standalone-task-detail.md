# Agent Note: Complete task details in a standalone tab

Status: implemented

## Problem

The task dialog contains the description, status, relationships, PRs, metadata
and existing task actions, while a separate attachment page exposes only files.
Readers need a durable task address and room for the complete detail without
losing the default modal workflow. Navigation and live data must remain usable
when the originating window closes, and a page must not inherit dialog-only
focus, inertness or Escape behavior.

## Decision

`TaskDetailSurface` owns the shared detail rendering and existing controllers.
Both `TaskDetailDialog` and `TaskDetailPage` compose it, including Overview,
Attachments, task status, relationships, PRs, metadata, three-state setting,
automatic-execution permission, platform editing and attachment file operations.
The dialog title provides a real Open in new tab anchor for its current task,
tab and file, with `_blank` and `noopener noreferrer`. The source dialog remains
mounted with its local state. Attachment popouts open the same complete detail
at that file.

The dialog wrapper retains portal, background inertness, counted scroll lock,
focus containment, Escape close and focus restoration. In normal mode the standalone page uses
ordinary browser focus and keys, with its own return and language controls. The
[fullscreen-reading decision](../feature/2026-10-25-task-detail-fullscreen.md) adds
a transient workspace mode without changing Surface identity or URL navigation.
Fullscreen hides the auxiliary top bar, keeps an explicit project return link
and temporarily supplies the reading root/onEscape owner to loaded frames. Exit
restores native standalone keys and the auxiliary controls. Platform selection belongs in
the status row, with a lock tooltip and live floating feedback. Overview shares
that same control. The
[notification decision](../bug-fix/2026-10-24-task-detail-notifications.md) owns
that layout-independent presentation.
Status, permission and platform requests share the existing confirmation union,
review key and exact-version mutation owner; platform selection retains the
confirmed value until success. File deletion keeps its own confirmation layer.
These request, review and modal rules apply in either container, not the shell.

`TaskDetailNavigation` records tab and nullable attachment path.
`taskDetailUrl` uses the base `/projects/{projectId}/tasks/{taskId}` for Overview
or no-file navigation and the existing attachment path for a selected file.
`tab=overview|attachments` overrides the route shape's default tab, allowing
Overview to retain a hidden file selection. The app observes pathname and search,
and the login return target preserves navigation query parameters while removing
transient `authError` feedback. A previous login failure is presentation state,
not a navigation target to restore after success. Existing ID/path validation
and encoded attachment addressing remain authoritative.

The standalone page owns task, tab and file navigation through the existing
router. Explicit relation/tab/file/upload selection adds history for a different
navigation state; applying Back/Forward only sets the shared state. Copying or
reloading restores the addressed detail. Dialog navigation remains local and
exports state only through its popout link. Same-task tab/file routes retain the
surface and attachment controller, including directory disclosure, scroll and
upload drafts. Task or authenticated-identity changes isolate old resources.
Invalid Markdown-reference feedback belongs to its semantic task/tab/file
selection: its initial activation shows the error, while applying a different
history state clears that feedback so it cannot obscure the restored preview.

`TaskDetailPage` reads its own project graph through `useTaskGraph` and supplies
the real snapshot to the shared detail session. Graph loading, initial failure
and retained-snapshot refresh failure stay explicit; retained graph errors use
the shared surface notification layer without reducing reading space. Errors
do not become empty relationships. After this mount's successful project sync,
matching intrinsic cached content can accelerate opening, while live GET remains
required before writes. Summary business versions, project generations and
recovery needs drive later detail reads; clock-only receipts do not reread
unchanged content. Unchanged detail reads
preserve DOM, focus, inputs and heading/panel geometry. Existing foreground
identity checks retain the visible page and interaction while the same identity
is revalidated; identity replacement and 401 retain their existing boundaries.

Each window performs its own online admission and live reads while sharing the
origin-local intrinsic cache. No opener-owned task object, graph snapshot,
confirmation or mutation state is transferred from the opener. `TaskDetailSession`
continues to own precise versions, cancellation, shared mutation locking,
conflicts and uncertain-outcome readback without replaying a write. Go registers
the base task UI path with existing GET/HEAD and method/unknown-path rules;
attachment paths retain their raw-path guard. The page uses the existing index,
API, authentication and storage contracts.

This partially supersedes the attachment-only outer composition in the
[shared attachment-page decision](2026-10-24-shared-attachment-page.md) and
[full-reader decision](2026-10-22-task-attachment-full-reader.md). Their shared
attachment panel, file/path safety, trusted same-origin rendering and scroll
rationale remain valid. The
[centered-detail decision](../feature/2026-10-22-centered-task-detail-dialog.md)
retains modal geometry and focus ownership; the
[compact-header decision](../simplification/2026-10-24-compact-task-detail-header.md)
retains bounded titles and control access. The
[inspection requirements](../../../../docs/spec/daynight-task-inspection.md#独立完整任务详情)
and [design](../../../../docs/design/daynight-task-inspection.md#独立完整任务详情)
own the complete behavior and mechanism.

## Alternatives

**Retain an attachment-only standalone page.** It preserves file browsing but
omits the task context and actions already present in details. A shared full
surface keeps those capabilities consistent while retaining attachment deep links.

**Replace the default task dialog with page navigation.** A task address would
be available, but ordinary graph/list reading would lose its existing modal
context and focus-restoration behavior. A title-bar popout preserves both uses.

**Build a separate full-detail page implementation.** Duplicated rendering and
mutation state would need independent fixes for versions, confirmations, errors,
refresh and attachments. Sharing the complete surface keeps those rules with
their existing owners and lets each outer container own only its lifecycle.

## Consequences

The same task content and actions are available in a modal or independent tab.
The URL names navigation state, while drafts, pending confirmations, reading
position and mutation ownership remain within the current page's lifecycle.
Independent windows can observe different versions; the existing exact-version
and reconciliation rules handle that race rather than coordinating windows.

Each standalone page synchronizes a complete project summary base and reads
needed full details through the shared cache/session. This provides relationship
context and version-aware freshness with the existing limits and error behavior.
The [detail-cache decision](2026-10-24-task-view-timestamp-window.md) owns matching
content, live-read admission and bounded persistence. It avoids a new relationship API while
requiring real graph/detail refresh validation, including unchanged projections
and silent foreground identity checks.

Validation must cover task/tab/file history, source-window independence,
query-preserving login, modal-local navigation, nested confirmations, precise
writes, initial and retained failures, stale responses, geometry/state retention,
narrow and short layouts, and native attachment scrolling. Prototype and prior
attachment-reading receipts retain their own source/environment limits and do
not establish current production behavior by themselves.
