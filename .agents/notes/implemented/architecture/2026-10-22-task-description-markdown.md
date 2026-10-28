# Agent Note: Markdown descriptions share attachment reading state

Status: implemented

## Problem

Task descriptions can contain headings, lists, code and references to planning
files, but plain text does not expose that structure or connect references to
the detail reader. The same Markdown syntax also appears inside attachments,
where a relative path means the document's directory. Description navigation
must keep file selection, list completeness, errors and resource lifetime in
agreement with the existing attachment panel.

## Decision

`MarkdownContent` shares CommonMark/GFM rendering and styles between task
descriptions and Markdown attachments. It also delegates Mermaid fences to the
shared static flowchart renderer; the
[flowchart decision](../feature/2026-10-24-markdown-flowcharts.md) owns diagram
security, rendering lifetime and local failure handling. Raw HTML remains text
and the existing URL/protocol policy is preserved. The caller supplies URL
conversion and activation.
`MarkdownAttachmentBase` explicitly distinguishes the task attachment `root`
from an actual `document` path. Descriptions use the root; attachment documents
use their containing directory. Path decoding and validation reject escape from
the task root without inventing a description filename.

`TaskDetailReading` owns one `useAttachments` controller for the current
project/task identity. Description navigation and `TaskAttachmentsPanel` share
that controller through `TaskDetailPanels`. An ordinary primary activation of a
valid relative file link without query/hash selects its decoded path, activates
Attachments and focuses the existing preview pane. Real preview hrefs remain
available to modified clicks, non-primary activation and context menus. Absolute,
protocol, root-relative, fragment and query/hash links retain the existing URL
policy and native navigation. No generated Markdown heading anchors are added.

Only a complete paginated inventory establishes that a file is missing. Loading,
list failure, invalid reference, confirmed missing file and preview failure
remain separate visible states with applicable retry. Description navigation
has no second list or preview request owner. Existing abort and request-generation
rules prevent old task, selection, close or auth/resource results from changing
the current resource. Same-path updates retain revision and `updatedAt` reload
semantics. The independent `TaskAttachments` wrapper keeps its own controller
when used outside this composition.

Overview remains the description's vertical scroll owner. Shared Markdown styles
wrap long prose and constrain tables/code to local horizontal scrolling. The
[split-view decision](2026-10-22-task-attachment-split-view.md) retains the bounded
panes and single right-side vertical scroll owner. The
[centered detail decision](../feature/2026-10-22-centered-task-detail-dialog.md)
retains modal/focus ownership, while the
[Web attachment decision](../../archived/feature/2026-10-21-task-attachment-web.md) records the
frame-lifecycle, trusted-origin and raw-file-read choices retained here. This decision
extends their reading composition without replacing those responsibilities.

The npm-bundled `using-daynight` entry and applicable mode/Goal references follow
the [Goal brief decision](../process/2026-10-22-goal-workflow-design.md) with
Markdown task content. The later [task-content and handoff decision](../process/2026-10-25-task-content-handoff.md)
replaces mandatory primary-attachment ownership: descriptions identify current task
responsibility and readable sources with one owner for each detailed explanation.
The [task/session content decision](../process/2026-10-28-task-session-content.md)
defines task content as task definitions, required inputs and resulting artifacts;
execution/discussion methods, operational authorization and recovery context stay
in the session. Shared body content names
its owning task ID, explicit description field (whole body or applicable sections) for task show
reads; actual attachment inputs retain source task/full path, and repository inputs
use verified immutable URLs; real uploads are confirmed before references are added. Existing
Goal stages, task-creation authority, implementation authority, merge authority,
`dependsOn` and PR properties retain their meanings. API storage and CLI/Agent
output preserve the original description bytes; there is no new stored format,
format flag, migration or old-data branch.

The [reading requirements](../../../../docs/spec/daynight-task-inspection.md)
TI8–TI11 own visible behavior and authoring obligations. The
[design](../../../../docs/design/daynight-task-inspection.md#markdown-与附件链接)
owns component responsibilities and navigation rules. This decision implements
the Markdown portion of the
[inspection design](2026-10-22-task-inspection-design.md); graph inspection and
routing retain their separate delivery and evidence.

## Alternatives

**Give description navigation a second attachment controller.** A second hook
would own another paginated list, selection and preview lifetime. The panel and
description could disagree about missing files or retry results and would issue
duplicate reads. Sharing the detail composition's controller preserves one
inventory and observable error owner.

**Resolve descriptions through a synthetic Markdown filename.** A fabricated
path can make the current directory appear to be the task root, but couples URL
meaning to an invented document identity. An explicit root/document base records
the real distinction and lets attachment documents retain their actual paths.

**Render descriptions with a separate Markdown implementation.** That permits
independent URL and style behavior, but creates two policies for raw HTML,
protocols, code and tables. A shared renderer leaves the caller's real base and
navigation policy explicit without duplicating parsing or presentation.

## Consequences

A task can communicate its assignment before attachments are opened and can
lead directly into the existing attachment reader. Inventory completeness is a
navigation guarantee, so incomplete or failed pagination cannot become a false
missing-file result. Focus and panel state remain tied to the existing resource
identity; locale changes translate interface messages without changing user
Markdown, file inputs or pending-operation identity.

Descriptions can contain complete task content or lead to its owning documents;
a complete body needs no primary attachment. The original summary-and-attachment
policy kept stable plans distinct from execution progress; the content/handoff
successor preserves single ownership without requiring that storage split. A Markdown editor, generated heading anchors
and task-field editing are separate additive capabilities. Keeping raw strings,
caller-supplied URL handling and explicit bases leaves those extensions possible
without changing storage or replacing the controller structure.

Runtime claims remain tied to the tested source and artifacts. Historical
attachment runs and the interactive target mock do not establish
description-navigation or packed-skill results for a different source artifact.
