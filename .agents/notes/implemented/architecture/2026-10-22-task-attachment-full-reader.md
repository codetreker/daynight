# Agent Note: Standalone attachment reading

Status: implemented

## Problem

The task dialog bounds the area available to read an attachment. Users need a
separate browser tab that can reload without the original dialog while retaining
rendered Markdown, native media and interactive HTML with relative resources.
Opening raw Markdown bytes does not retain the existing reading experience.
Moving a native frame outside the dialog must also preserve normal browser
keyboard behavior and avoid a second scrollbar around its document.

## Decision

The preview action immediately after Download is an accessible Open in new tab
anchor with an external-link icon, `target="_blank"` and
`rel="noopener noreferrer"`. `attachmentPageUrl` generates
`/projects/{projectId}/tasks/{taskId}/attachments/{path...}` from the selected
metadata, independently of pending content. It shares the existing canonical-ID
and encoded-path validators. The source dialog and its selection remain open.

The standalone task route renders outside the workspace shell and modal.
Its attachment path owns project, task and exact case-sensitive file identity,
while the complete detail shares one attachment controller with description
navigation. The [standalone-detail decision](2026-10-24-standalone-task-detail.md)
owns the current full-detail container. Only a complete inventory establishes either
selected metadata or a missing file; failed or partial inventories remain errors
with retry. The same `AttachmentPreview` renders every supported format and
its failure states. Content URLs remain the existing raw/preview endpoints, so
Markdown resources and trusted same-origin HTML keep their current resolution
and execution rules. No new metadata API, preview credential or storage address
is introduced.

The frontend splits the raw route path before decoding segments once, rejects
decoded separators and applies the existing path validator. The Go UI mux serves
the index for GET/HEAD of this exact page shape and rejects other methods with
405 and `Allow: GET, HEAD`. Unknown page shapes remain JSON 404. Invalid IDs in
a known page shape retain the established index response and frontend not-found
behavior. The existing raw attachment path guard protects the new namespace
before ServeMux normalization or redirects, including paths whose later parent
segments would conceal their attachment intent. Literal percent names remain
valid through one encoding/decoding pass.

The root `LocaleProvider` supplies the reader's messages, route title, metadata
formatting and language selector. Entering the route focuses its main reading
region; locale updates preserve resource and frame identity. A `100dvh` flex
column gives the actual-height header its space and the attachment panel all
remaining height. The outer page hides overflow. Markdown, text and images use the shared
preview body as their vertical scroll owner; HTML/PDF use a fitted iframe whose
document or native reader owns scrolling. Header height is never subtracted as
a fixed constant.

The original standalone reader omitted the dialog-only Escape/Tab bridge to
preserve native page keys and avoid modal focus, inertness or scroll locking. The
[fullscreen-reading decision](../feature/2026-10-25-task-detail-fullscreen.md)
partially supersedes that bridge condition: `TrustedFrame` accepts an explicit
reading root/onEscape owner in dialogs and standalone fullscreen. Normal
standalone mode retains native keys; entering or leaving fullscreen updates the
loaded document listeners without reloading the frame.

The [attachment requirements](../../../../docs/spec/daynight-task-attachments.md#独立页面完整阅读)
own visible behavior and the [design](../../../../docs/design/daynight-task-attachments.md#独立附件阅读页)
owns the route and rendering mechanism. The
[shared-page decision](2026-10-24-shared-attachment-page.md) extends this foundation
with the complete attachment panel and standalone navigation history. The
[standalone-detail decision](2026-10-24-standalone-task-detail.md) places that panel
within complete task details and extends history to task/tab/file state. This
decision extends the [split-view decision](2026-10-22-task-attachment-split-view.md), which retains
inline tabs, state and scroll ownership. The
[original Web attachment decision](../feature/2026-10-21-task-attachment-web.md)
retains rendering, file operations and trusted-origin rationale; the
[embedded delivery decision](2026-10-20-embedded-dashboard-deployment.md)
retains one mux, real assets and exact page registration.

## Alternatives

**Open each file's raw preview URL directly.** HTML and native media retain their
browser rendering, but Markdown is served as file content and loses the shared
CommonMark/GFM view. One explicit reader route provides a consistent reloadable
entry for all existing formats without changing their file endpoints.

**Use originating-tab state or temporary object URLs for navigation.** A copied
address, reloaded page or closed source dialog would lack authoritative metadata
and content ownership. Complete inventory lookup keeps production navigation
independent; fixture object URLs remain local demonstration resources.

**Reuse the dialog frame keyboard bridge on the full page.** Escape would be
consumed for a nonexistent dialog and boundary Tab would inherit modal rules.
Restricting the bridge to a real dialog retains standalone browser behavior
while preserving the existing modal interaction.

## Consequences

The full reader is an additive capability over the split layout: file identity,
content rendering and relative resources remain shared, while route, request
and keyboard ownership are explicit. Complete inventory reads retain the cost
of listing every page before missing-file decisions; they avoid another metadata
endpoint and prevent partial failure from becoming false absence.

The initial full-reader delivery kept a read-only view with Download and left
management in the task attachment tab. That limited composition reused the
renderer while the route and nonmodal keyboard behavior were established. The
[shared-page decision](2026-10-24-shared-attachment-page.md) partially supersedes
that placement: both containers now use the complete attachment panel, and only
the standalone container integrates selection with URL/history. Task lifecycle,
description Markdown, single-file mutation semantics, storage formats and the
accepted K1 filesystem/PostgreSQL boundary remain unchanged.

The production-component fixture supplies reloadable bundled-file reader URLs
for visual and interaction checks. Implementation checks own this feature's
route, rendering, failure and sizing behavior on their tested source. Independent
real-service runtime acceptance of the reading task group is complete; the
[cross-layer acceptance decision](../testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
owns its real-input, native-content, failure-recovery and cleanup methods.
Results retain their tested source, artifact and browser limits. Fixture evidence
remains distinct and a local browser override is not hosted-CI browser proof.
