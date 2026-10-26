# Agent Note: Local Bucket and Path Storage

Status: implemented

## Problem

The adopted attachment design needs a file-content module reusable by other
consumers. A local adapter must preserve real relative paths and case, publish
complete files, return attributes of the content actually opened, and keep
startup callers runnable when a storage directory becomes required. Disk IO
does not belong in the PostgreSQL project/task store.

## Decision

`internal/filestorage` defines bucket/path Put, Open and Delete, their data types
and address validation. `internal/filestorage/local` implements the contract
with a concrete root lifecycle. Neither package imports task policy or PG.
The [attachment architecture](../../../../docs/design/daynight-task-attachments.md)
owns the cross-component contract; its
[adoption note](2026-10-21-task-attachment-storage-design.md) retains the original
choices and the accepted filesystem/PostgreSQL consistency limitation.

The local layout is `<root>/<bucket>/<path>`. Names retain case and spelling;
invalid or escaping addresses are rejected. `os.Root` confines path resolution,
including symlink traversal, instead of relying on a string prefix check.
The root must distinguish case, verified with a temporary probe at construction.
The [pinned Go root implementation](https://github.com/golang/go/blob/go1.27.2/src/os/root.go#L34-L68)
owns the confinement guarantees used here.

Put writes an owned same-directory temporary file and then replaces the target.
Streaming does not hold the instance's namespace mutex. Short setup,
publication and deletion sections use that mutex to preserve normal file and
directory semantics within the runtime's single LocalStorage instance. Empty
internal directories can be reused as file names; existing or pending child
files remain conflicts. Directory cleanup only removes empty directories and
never removes a regular file or symlink encountered as an ancestor. This is
filesystem namespace maintenance, not cross-store or multi-process coordination.

Open returns a body and size from the same opened file handle. A context-aware
wrapper preserves cancellation checks through ordinary and optimized copy
callers. The caller owns input readers and returned bodies; cleanup errors keep
their chains. Delete addresses one file and treats absence as completed deletion.

The server requires `DAYNIGHT_STORAGE_ROOT`. Config validation checks the value;
runtime initialization performs actual directory preparation before opening PG
and listening. The composition callback receives `Dependencies{Store, Files}`.
The [authentication activation](../../implemented/architecture/2026-10-22-authentication-activation.md) now supplies
required Config to the handler factory and propagates its error; the runtime
closes the local root on composition or other later startup failure and after
HTTP drain. The dependency owner still opens one store and one file root.

Existing Go process fixtures, the native browser runner and both Compose
configurations provide explicit roots in the same delivery. Each acceptance
fixture owns a directory and reuses it across restart. Browser recovery validates
its run directory and stopped process before removing storage. The runtime image
prepares the directory for UID/GID `10001:10001`. The separate
[persistence delivery](2026-10-21-task-attachment-persistence.md) mounts project-scoped
volumes there and verifies fresh-volume ownership, retention and paired restore.

## Alternatives

**Join caller paths and check the resulting string prefix.** That checks a
lexical spelling but does not confine filesystem resolution through symlinks.
Rooted operations provide the required confinement without a custom traversal
implementation.

**Truncate and stream into the current file.** Readers could observe partial
replacement bytes and a failed reader would destroy prior content. Same-directory
temporary publication preserves complete-file semantics for ordinary writes.
It does not make a later PG update atomic.

**Reject every existing directory as a file target.** Internal empty parents
would permanently reserve names after their last child was deleted or a write
failed. Directories are derived organization, so empty-directory reuse and
bounded ancestor cleanup are necessary normal operations.

**Delay caller wiring until persistent-volume deployment.** A new required
environment field would make existing process tests, browser acceptance and
Compose fail until persistent-volume deployment. Mandatory startup wiring is
part of this foundation; durable attachment mounts have a separate responsibility.

## Consequences

The byte-storage implementation is reusable without a task model or database.
No new external dependency, storage-key identity, version system, scanner or
recovery service is introduced. Current deployment is validated on Linux; roots
that cannot preserve case are rejected rather than silently merging addresses.

Namespace synchronization is scoped to one adapter instance and does not promise
coordination between processes sharing a root. K1 remains recorded and untreated.
The storage foundation does not expose attachment HTTP routes or imply browser,
CLI or persistent-volume delivery.

Tests use real directories and deterministic concurrency barriers to check byte
identity, complete replacements, cancellation, path confinement, case, rejected
conflicts and preservation of existing files during cleanup. Runtime and
acceptance tests verify startup failures, drain and isolated restart roots.
Source-bound results remain with the implementation PR and CI; the existing
coverage and behavioral gates remain unchanged.
