# Agent Note: Task Attachment HTTP Resources

Status: implemented

## Problem

Task files need durable ownership metadata and a shared server interface before
CLI and browser management can use them. Generic bucket/path storage alone does
not establish task scope, preserve file metadata or expose original file bytes
and relative preview resources through the application origin.

## Decision

The [requirements](../../../../docs/spec/daynight-task-attachments.md) and
[architecture](../../../../docs/design/daynight-task-attachments.md) own the
cross-component contract. Attachment HTTP operations build on the
[local storage foundation](../architecture/2026-10-21-bucket-file-storage.md). The
[persistence delivery](../architecture/2026-10-21-task-attachment-persistence.md)
provides the deployment volumes and paired backup/restore validation.

Migration 004 adds one `task_attachments` table keyed by `(task_id, path)` with
C-collated path, ownership, content type, actual write size and timestamps.
There is no attachment ID, foreign key, storage key or historical object table.
The [project-grouped layout](../../implemented/architecture/2026-10-24-project-sharded-attachment-layout.md)
derives the current address as
`task-attachments/<canonicalProjectId>/<canonicalTaskId[:2]>/<canonicalTaskId>/<path>`
in the attachment business layer. HTTP paths and metadata retain the original
task-relative identity; clients do not supply a physical shard.

The concrete PG store supplies scoped metadata queries and a path-keyset page.
The service validates project/task ownership before file IO. List cursors bind
version, list kind, project, task and last path; they do not reuse the UUID/time
cursor of task lists. Prefix conflicts use literal ancestors and starts_with,
so filename percent and underscore characters are not SQL wildcards. Metadata
upsert preserves created_at and uses PG 18 OLD/NEW returning values to identify
creation separately from replacement.

HTTP exposes paginated metadata, raw single-file PUT/GET/DELETE and a fixed
same-origin preview path. It validates the original escaped path before
ServeMux can redirect it, including malformed prefixes whose later parent
segments would otherwise remove the attachment namespace. A normalized view is
used only to recognize intent; accepted paths are never cleaned into another
filename. Existing JSON routing retains its behavior.

Uploads bypass the JSON-body decoder and stream directly to Storage. Downloads
and preview share one read operation, with attachment or inline disposition.
Content-Length describes the object actually opened. HEAD closes without
reading the body. Relative HTML/CSS/script/data URLs use the same directory
layout, and ordinary query parameters do not change the logical filename.
HTML is trusted project code with the main origin's privileges.

Errors before response commitment use the existing JSON envelope. A later copy,
close, cancellation or short-read failure is logged once and aborts the transfer
with ErrAbortHandler. The existing logging wrapper rethrows that sentinel
without adding a false unexpected-panic diagnostic; real panics retain their
safe handling.

K1 remains accepted and untreated. File IO and PG updates are separate operations;
normal errors propagate even if storage already changed. Missing metadata is a
scoped 404, while an existing record whose bytes are missing remains a storage
failure. Normal HTTP operations add no K1 coordinator, compensation, recovery
ledger or scanner. Explicit offline layout maintenance has its own bounded conversion
manifest and does not repair business consistency.

## Alternatives

**Put bytes in task JSON mutations.** This would couple file transfer to task
versions, JSON size limits and dependency-state updates. Independent file
resources preserve those existing contracts and allow raw binary transport.

**Use attachment IDs in content URLs.** IDs would add a second identity and
require rewriting relative resources. Task-relative paths already provide the
necessary address and map naturally to the bucket/path backend.

**Validate paths only inside the handler.** Go's mux can normalize and redirect
before that handler runs, potentially retaining a write method while targeting
another route. The scoped pre-mux guard rejects original invalid paths without
changing valid legacy JSON routes.

**Treat missing bytes as an absent attachment.** A known PG record with missing
storage indicates an operational problem, not evidence that the scoped resource
does not exist. Preserving the storage failure exposes K1 rather than masking it.

## Consequences

CLI and Web can consume one path-based API without implementing storage policy.
Attachment operations do not update task fields, properties, versions, status,
dependencies or timestamps. Multiple files still update independently, and PG
records can disagree with storage after partial or concurrent failures.

The original HTTP delivery verified exactly one migration entry for each of
versions 1 through 4. Current schema migrations retain their own lifecycle
acceptance; layout maintenance does not mutate that ledger. Tests use real PG
and LocalStorage for metadata and content; failure doubles implement only the
already-required Storage interface.
HTTP checks cover original paths, MIME, actual length, scoped errors and aborted
streams. An actual built-process probe verifies raw bytes, relative resources
and restart persistence. Source-bound results remain in the PR and CI.
