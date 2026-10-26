# Agent Note: Attachment deletion confirmation

Status: implemented

## Problem

The attachment preview exposes an immediately destructive action beside common
reading actions. Accidental activation removes a file without a separate chance
to inspect its target. Managing another file must also preserve the document
currently being read, including native iframe state and reading position.

## Decision

Every file row has separate selection and action-menu buttons. The menu captures
the row's full case-sensitive task-relative path independently of preview
selection. Delete opens a labelled confirmation showing that path and an
irreversibility message. Cancel receives initial focus; only explicit confirmation
submits the existing single-file request. The preview header retains download
and standalone reading actions. Directories remain organization inferred from
file paths.

The menu uses the browser top layer and viewport-aware positioning to escape the
scrolling sidebar's clipping. Native modal confirmation remains a descendant of
the attachment panel in either the task detail or standalone page and imports
the established auth dialog stylesheet. Shared
`dialog-header`, `dialog-body` and `dialog-footer` classes own its bounded flex
layout: the header/footer do not shrink, and the body is the single shrinkable
vertical scroll owner. Complete paths remain inspectable even when their text
exceeds the viewport; loading order cannot switch ownership between competing
modal-shell rules. Its scrolling body is an explicitly focusable, labelled group.
That permits keyboard scrolling and includes the scroll owner in the shared
focus enumeration; relying on browser-implicit scroll-region focus can otherwise
enter a target absent from that enumeration and prevent reaching the footer.
The confirmation owns keyboard events before the outer detail listener. This preserves background inertness and task
focus ownership without a second global overlay coordinator. The confirmation reuses
`dialogFocusables` to wrap boundary Tab/Shift+Tab explicitly, including pending
focus on the dialog root; native modal behavior alone can move focus to browser
UI between the last and first page controls. Current-layer Escape closes only that layer. Confirmation provides its own language selector
so a pending operation stays accessible while its labels change.

Pending confirmation keeps its captured target, shows progress, and blocks
duplicate or conflicting writes until the request settles. Failure exposes the
existing error and request ID and permits deliberate retry or cancellation.
Last-known inventory and preview remain visible; accepted K1 means this UI state
does not establish that remote file bytes were preserved or rolled back.
Hiding the attachment panel dismisses unsubmitted transient UI; task or identity
changes follow the existing scoped request teardown.

The attachment controller refreshes inventory after a successful deletion. It
clears preview selection only when that path was selected, and does not advance
the preview revision for unrelated deletion. Overwrites retain their existing
invalidation behavior. While a paginated refresh is incomplete, the controller
retains the selected file's last-known metadata for the same task and path; only
a complete missing inventory clears it. Intermediate pages therefore cannot
unmount an unrelated native preview. Success restores focus to the surviving
preview pane if the original row is gone, even while list refresh disables its
refresh button. The [requirements](../../../../docs/spec/daynight-task-attachments.md#web-管理与预览)
and [design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
own the complete behavior and composition.

This partially supersedes deletion placement in the
[original Web attachment decision](../../archived/feature/2026-10-21-task-attachment-web.md) and
[split-view decision](../architecture/2026-10-22-task-attachment-split-view.md).
Their single-controller, trusted-origin, upload and scroll decisions remain
applicable. The [shared-page decision](../architecture/2026-10-24-shared-attachment-page.md)
uses this confirmation in both attachment containers and owns standalone route
selection after deleting the current file.

## Alternatives

**Stack the existing management-dialog component above task details.** Both
components install document-level keyboard handlers, allowing Escape or Tab to
act on two layers. Its body portal also falls outside the task detail's focus
containment. Native modal descendants reuse browser isolation and existing DOM
ownership.

**Position an ordinary dropdown inside the file sidebar.** The sidebar scrolls
inside a split frame that hides overflow. Menus near its boundary would be clipped,
particularly in narrow layouts. Top-layer placement preserves the split's scroll
rules while keeping menu actions reachable.

**Increase the attachment shell selector's specificity.** That would preserve a
second modal geometry competing with the auth dialog rules. Reusing the existing
header/body/footer ownership keeps one height constraint and a defined scrolling
body rather than relying on stylesheet order.

## Consequences

Deleting a file requires a deliberate choice and full-path confirmation, while
reading actions remain directly accessible. Exact-path targeting supports files
with matching basenames in different directories. Native top-layer behavior
requires real-browser validation in addition to component tests; JSDOM cannot
establish clipping, focus, or inertness behavior.

The change keeps the existing API, storage format, authorization, single-file
semantics and K1 boundary. Bulk deletion and undo would be additive capabilities;
they are not part of this interaction. Production acceptance covers cancellation,
one-request submission, failure, path identity, preview retention, bilingual and
narrow layouts, and coexistence with task and same-origin preview keyboard use.
