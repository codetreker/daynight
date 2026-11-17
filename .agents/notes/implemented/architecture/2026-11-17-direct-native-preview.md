# Agent Note: Direct Native Attachment Preview

Status: implemented

## Problem

HTML and PDF previews waited for a main-site HEAD request before loading their
Task-origin document. The extra serial request and file open delayed reading,
while checking main-site credentials could not establish that the preview Cookie,
Task host connection, or document itself would work. Readers also need a way to
recover when a connection fails before the preview service can return an error.

## Decision

Web loads admitted HTML/PDF documents directly from the Task preview origin.
The preview service retains its document error page, request ID, same-URL retry
and SSO recovery; the parent header also provides Reload for failures the service
cannot report. The main-site HEAD API remains available to other clients. The
[default Task-origin decision](2026-11-16-default-task-preview.md) continues to
own origin isolation and describes why the main-site GET redirects.

The native preview snapshot identifies the document by scope, path, metadata
`updatedAt` and a reload revision, together with its actual URL. A successful
overwrite publishes the returned metadata and revision as one state change;
explicit reload and observed version changes also replace the document. Ordinary
refreshes and same-identity pause/resume retain the established frame. The
[attachment design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
owns the snapshot and admission rules.

## Alternatives

**Keep main-site HEAD.** It retains the serial round trip and checks different
credentials from the actual document request, so it cannot establish that the
preview will load.

**Move HEAD to the preview origin.** It still adds a request and requires
cross-origin credential and CORS handling without proving the subsequent GET or
rendering.

**Rely only on the preview error page.** DNS, TLS and connection failures may
never reach the service, and an interrupted response cannot be replaced with an
error page. A parent-level reload remains available in those cases.

## Consequences

The default path removes one serial request and repeated file open; no measured
latency improvement is implied. Iframe load is only a navigation indicator, not
proof of HTTP success or rendered content. The parent does not guess failure
states or add cross-origin probes, messages, polling or timeout inference.
Reload replaces the current document and its local input and scroll state, while
leaving the attachment selection and other drafts intact. Existing main-site and
preview Cookie concurrency risks remain; other main-site identity checks and
confirmed permission-loss cleanup continue independently.
