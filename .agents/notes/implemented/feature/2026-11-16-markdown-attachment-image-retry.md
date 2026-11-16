# Agent Note: Local Retry for Markdown Attachment Images

Status: implemented

## Problem

Task and Goal descriptions and Markdown attachments can embed attachment-relative
images. A missing file or failed network request leaves the native broken image
without a clear recovery action. Recovery must preserve the surrounding reader's
file input, upload draft, attachment selection, embedded documents and reading
position. Native image URLs and the existing authentication pause retain their
own behavior.

## Decision

The shared Markdown renderer classifies each original image reference through
`resolveAttachmentReference()` using the caller's root or document base. Only
attachment-relative images receive local failure feedback and ordinary Retry.
URL construction continues to preserve encoded path segments, directory semantics,
query and fragment. Task and Goal descriptions supply an attachment-root base;
Markdown attachments supply their actual document path.

Each attachment image owns its loading result and retry attempt. Retry starts
another native request for that image's original resolved URL without rereading
the document or attachment inventory. Replaced source and attempt identities
reject stale events. Remote pause blocks pending/new sources and retry while
retaining loaded image nodes. External and other native URL images keep their
existing rendering behavior. The error and action use the application locale and
fit the Markdown reader at narrow widths.

The [attachment design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
owns the mechanism, and the [attachment requirements](../../../../docs/spec/daynight-task-attachments.md#web-管理与预览)
own the observable behavior. The archived [Markdown description decision](../../archived/architecture/2026-10-22-task-description-markdown.md)
retains the original root/document and shared-reader rationale; this decision
extends its image recovery behavior.

## Alternatives

**Reload the Markdown document or attachment workspace.** Reusing the selected
preview retry would reread successful content and couple a single failed image
to the document's loading state. Rebuilding the workspace also risks losing
file input, drafts, selection, frame documents and reading position.

**Classify images from the transformed preview URL prefix.** A native root-relative
or absolute URL can point into that same prefix. Inferring origin after conversion
would apply attachment-specific recovery to references that retain native URL
semantics. The original reference and existing classifier preserve that distinction.

## Consequences

Image failures have an explicit recovery action without transferring ownership
from the image to its surrounding reader. Requests keep normal browser image
loading and caching semantics, and a failed retry remains a visible local error.
There is no new product API, authentication recovery action or preview origin.
The selected-image preview retains its existing independent error and retry UI.
