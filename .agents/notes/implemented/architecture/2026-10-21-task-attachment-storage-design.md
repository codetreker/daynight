# Agent Note: Bucket-addressed Task Attachments

Status: implemented

## Problem

Tasks need to carry design documents, architecture documents, images and runnable
UI mockups. When this design was adopted, the task model carried text and
dependency state, the browser was a read-only consumer, and the CLI transport
handled JSON and rendered text. A file mechanism tied to one task model would
also make another file use case repeat the same disk and transport concerns.

## Decision

The delivered artifacts are the adopted
[requirements](../../../../docs/spec/daynight-task-attachments.md) and
[architecture](../../../../docs/design/daynight-task-attachments.md).
The [file-storage foundation](2026-10-21-bucket-file-storage.md) implements the
generic local adapter and startup integration. The
[attachment HTTP delivery](../feature/2026-10-21-task-attachment-http.md) implements
metadata and backend file operations. The
[attachment CLI delivery](../feature/2026-10-21-task-attachment-cli.md) implements
put/list/read/remove and byte-stream output. The
[persistence delivery](2026-10-21-task-attachment-persistence.md) implements
deployment volumes, isolation and paired backup/restore validation. The
[Web attachment delivery](../feature/2026-10-21-task-attachment-web.md) implements
file management, typed previews and task-detail focus integration. This note owns the
adopted cross-component design; the CLI and Web notes own their transport,
rendering and output choices.

Generic file storage uses bucket and real relative path addressing through
Put/Open/Delete. The initial adapter is local disk. The
[project-grouped layout decision](2026-10-24-project-sharded-attachment-layout.md)
owns current attachment addressing: the business layer supplies canonical
project/task-shard/task prefixes while public paths remain task-relative.

At initial adoption, a globally unique task ID directly followed the
`task-attachments` bucket. Potential physical sharding was left to a local
adapter, and that delivery introduced no sharding configuration or migration
mechanism. The direct tree was sufficient for the initial path-based file API
without another stored identity. The later project-grouped decision supersedes
that layout and responsibility choice while preserving this note's single-file,
preview-trust and K1 boundaries.

One PostgreSQL attachment table owns task association, relative path and file
metadata. Directories are inferred from paths. Each upload, overwrite or deletion
addresses one file. Same-path uploads replace current contents; there is no
per-upload object key or version history. The generic storage interface does not
own task policy or a generic PostgreSQL metadata platform.

Web and CLI share path-addressed HTTP APIs. Preview uses the existing application
origin and a fixed task-scoped path; HTML is trusted project code executed in an
ordinary iframe with the viewer's current main-origin authority. This is an adopted
architecture boundary, including for multi-user authentication: attachment requests
reuse the main browser session and current project membership checks. Authentication
does not turn uploaded project code into sandboxed content.

Independent preview domains or origins, preview-specific credentials, bootstrap
exchanges and their DNS/TLS or gateway infrastructure are outside this design.
Adding authentication must preserve this boundary. A different preview trust model
requires a separately authorized architecture decision; it is not a prerequisite
inferred from project membership. The [authentication decision](2026-10-22-auth-architecture.md)
and its requirements inherit this constraint.

CLI content reads use a binary streaming channel with backpressure, cancellation
and explicit partial-failure semantics. The
[server baseline](2026-10-19-daynight-server-task-design.md),
[CLI baseline](2026-10-20-project-task-cli-design.md) and
[read-only dashboard baseline](2026-10-20-task-dashboard-mvp-design.md) retain
ownership of their delivered behavior. Attachments extend those baselines.

Filesystem mutations and PostgreSQL metadata changes are not atomic. K1 in the
requirements and architecture records the accepted failure and concurrency
window. This delivery does not address K1 through coordination, compensation,
recovery, state ledgers or background reconciliation. Ordinary errors remain
visible, and an unsuccessful request may already have changed storage.

## Alternatives

**Unique immutable keys with a PostgreSQL publication pointer.** This makes the
database select a completed object, but introduces a second file identity and
old-object reclamation into a path-based, current-content feature. Bucket/path
addressing is reusable without that lifecycle. Its cross-store consistency
limitation is explicitly accepted as K1.

**Directory bundles and whole-directory replacement.** A bundle can publish one
mockup with all its resources, but also gives a single upload authority to remove
other files. The selected interface always modifies one file; directories only
organize relative paths and browser resource references.

**Dedicated preview origins, sessions and capability tokens.** These can isolate
untrusted preview code, but add origin allocation, lifecycle and permission
machinery. The selected model treats HTML as trusted project code and uses the
main application origin. It does not claim an execution security boundary.

**Service Worker preview routing.** A worker can provide offline or browser-side
virtual filesystems, but server-backed paths already provide the required
relative-resource routing. Worker registration, control and caching lifecycle
are unnecessary for this delivery.

**Cross-store recovery and reconciliation.** These mechanisms could reduce K1's
failure window or reclaim interrupted-operation residue. They add persistent
state and operational behavior outside the adopted scope. K1 remains a known
issue, not a hidden implementation or acceptance task.

## Consequences

Another file consumer can reuse bucket/path storage without importing task
policy. Normal writes use local staging followed by complete-file replacement;
staging is an IO mechanism, not a historical version system. User-facing paths
and preview URLs remain independent of disk roots and future backend choices.

PG metadata can differ from actual file contents after failures or concurrent
mutations. File response length comes from the object actually opened. Errors
must not be converted into an empty list, missing file or confirmed rollback.
Consistency remediation is outside this design.

Trusted same-origin HTML has the privileges of that browser origin. Supporting
untrusted HTML would require revisiting the preview boundary rather than
silently presenting the current iframe as isolation.

Generic local storage, attachment HTTP resources, CLI commands, browser
management and persistent deployment volumes are implemented. The Web delivery
note owns its state, rendering and focus choices; this note retains the
cross-component addressing and accepted K1 decision. The
[cross-layer acceptance decision](../testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
owns installed CLI/service and same-data production-browser proof.
Existing server, CLI and Web contracts remain true for delivered features.
Module-specific validation and source-bound evidence remain required; native CLI
outcomes cannot be inferred from source inspection or another platform's run.
