# Agent Note: Shared attachment page and standalone history

Status: implemented

## Problem

The standalone reader opens one attachment without the task's inventory or file
operations. Reading another file requires returning to the source task, and a
separate reader composition can drift from the attachment panel's behavior.
Standalone file changes also need copyable addresses and browser Back/Forward,
while selecting files inside a task dialog must preserve that page's navigation.

## Decision

Both detail containers use the complete `TaskAttachmentsPanel`: directory tree,
refresh, upload disclosure, row menus, deletion confirmation, preview and file
actions. `TaskDetailReading` owns one `useAttachments` controller shared by
Overview description navigation and the panel. The preview header owns path,
metadata, Download and Open in new tab.

The original shared-page delivery composed this panel in `AttachmentPage`, with
only a return/language header, viewport sizing and file-route integration. That
kept the extension focused on file browsing and reused the established panel.
The [standalone-detail decision](2026-10-24-standalone-task-detail.md) partially
supersedes that outer composition: the standalone container now provides the
complete Task Detail, and navigation records task, tab and selected file.

Standalone tree and successful upload selection update the outer navigation;
Back/Forward apply selection without creating history. Dialog selection remains
local. Same-task tab/file changes retain inventory, directory disclosure,
sidebar scroll and upload drafts; task and identity changes still release old
resources. Existing preview identity and request cancellation reject stale data.

New standalone attachment metadata requires a complete inventory; partial pages
and failures cannot establish absence. Incomplete refreshes retain already
confirmed metadata for the same task/path. Selected-file deletion keeps its
address and shows missing after complete confirmation; unrelated deletion keeps
the current preview. Existing single-file requests, confirmations, errors and K1
semantics apply in both containers without a new API, storage key or renderer.

The shared split retains adjacent inventory and preview at narrow widths, with
independent inventory scrolling and one right-side vertical owner. Standalone
native frames use ordinary browser keys in normal mode. The
[fullscreen-reading decision](../feature/2026-10-25-task-detail-fullscreen.md)
extends the bridge from dialog-only close semantics to an explicit reading
root/onEscape owner. Standalone fullscreen enables it on the already-loaded
document, and exit releases it without a frame reload. File confirmation retains
its own native modal ownership.

This panel-reuse decision partially supersedes the initial read-only composition
in the [full-reader decision](2026-10-22-task-attachment-full-reader.md).
The [split-view decision](2026-10-22-task-attachment-split-view.md) retains panel,
upload-draft and scroll ownership; the
[deletion-confirmation decision](../feature/2026-10-23-attachment-delete-confirmation.md)
retains mutation and confirmation rules. The
[requirements](../../../../docs/spec/daynight-task-attachments.md#独立页面完整阅读)
and [design](../../../../docs/design/daynight-task-attachments.md#独立附件阅读页)
own current attachment behavior within complete task details.

## Alternatives

**Add a separate read-only directory tree to the standalone reader.** This would
provide file selection but leave two attachment-page compositions with different
management capabilities. Reusing the existing complete panel shares its directory,
file operations, error handling and validation without another tree or renderer.

**Keep file selection local in both containers.** This retains the embedded
behavior, but standalone addresses would continue to name a previously selected
file. Back/Forward and reload would not follow the displayed document.

**Write history from every selection-state change.** Route restoration and local
selection would feed each other, creating entries during Back/Forward and exposing
races with completed uploads. Explicit user selection events let the standalone
outer page own navigation while route changes only apply state.

## Consequences

The complete attachment experience is available in either container, with one
implementation for file browsing and management. Routing is an outer-page concern;
embedded panels remain usable without changing project navigation. Keeping the
panel mounted across file routes retains native inputs and directory state.

The current address remains meaningful after deletion even though it then names
a missing file. A complete-inventory check reports that absence; selecting an
existing file produces its own address. The design retains existing pagination
costs, normal file-operation failure semantics and trusted same-origin execution.

Validation must distinguish container behavior: standalone file selection and
uploads update history, Back/Forward apply state without writing history, and
embedded file selection and uploads remain local. Both containers require file
operations, error recovery, narrow split geometry, scroll ownership and keyboard
checks. Historical reading-group results retain their recorded source and
browser limits and do not prove subsequent extensions by themselves.
