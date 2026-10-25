# Agent Note: Attachment directory disclosure

Status: implemented

## Problem

An attachment inventory can contain several document and asset subtrees. Opening
every directory immediately makes unrelated descendants compete with the task's
first-level organization. A link to a nested document still needs a visible
location in the tree, and normal refreshes must respect a reader who deliberately
collapsed that document's directory.

## Decision

The attachment tree initially shows root files and first-level directory names.
Every directory starts closed and retains native `details`/`summary` pointer and
keyboard interaction. `TaskAttachmentsPanel` owns expanded directory paths for
one project/task identity and supplies each directory's `open` value. Summary
activation commits disclosure synchronously because native toggle events are
queued and can otherwise apply an earlier action after a new link reveal. Native
toggle events reconcile the current control state. Refreshes, tab and locale
changes, and ordinary rerenders preserve manual choices; changing project/task
resets them.

`TaskDetailReading` sends a separate reveal intent for an initial standalone file
address, an external attachment-path change such as Back/Forward, and each
intercepted description link. A repeated link remains a new intent even when its
selected path has not changed. The panel adds only that path's ancestor
directories to the existing expansion set. Ancestor paths can be recorded before
the inventory arrives, so delayed list pages do not lose the intended location.
Sibling directories retain their state.

Local tree selection, successful upload and tab changes can update standalone
navigation, but their controlled-selection echo does not request a reveal. A
consumed reveal does not replay on refresh or rerender, so the reader can collapse
the selected document's directory. Root files require no directory expansion.

This specializes the disclosure ownership in the
[split-view decision](../architecture/2026-10-22-task-attachment-split-view.md)
and the navigation ownership in the
[shared-page decision](../architecture/2026-10-24-shared-attachment-page.md).
The [attachment requirements](../../../../docs/spec/daynight-task-attachments.md#web-管理与预览)
own observable behavior; the
[attachment design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
owns its integration with the shared controller.

## Alternatives

**Keep every directory open initially.** This makes all descendants immediately
available, but a large asset subtree can displace unrelated top-level documents
before the reader has chosen a branch.

**Derive expansion continuously from the selected file.** Selection alone cannot
distinguish an external link from a tree click or completed upload. It would also
reopen a directory the reader closed while continuing to preview its file.
Separate reveal intents preserve both location discovery and subsequent manual
control.

## Consequences

A fresh attachment view presents the task's first-level organization, while a
nested external target remains discoverable without expanding unrelated branches.
The same panel supplies the behavior in dialogs and standalone details without a
new API, persistence key or inventory request.

Navigation and selection now have different effects and must remain distinct
when adding new attachment entry points. Verification must cover delayed
inventories, repeated links, history restoration, native disclosure controls,
manual collapse followed by refresh/tab changes, local upload navigation, and
project/task isolation. Directory state remains scoped to the mounted task and
is not a browser-persisted preference.
