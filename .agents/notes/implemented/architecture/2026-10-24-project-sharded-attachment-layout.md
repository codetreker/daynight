# Agent Note: Project-grouped Task Attachment Layout

Status: implemented

## Problem

A single task-ID directory level mixes tasks from every project and makes its
size depend on all tasks stored by an instance. Project ownership already
exists in PostgreSQL and request admission, but the physical layout does not
express it. Adding project and task-prefix directories must preserve public
attachment identity and existing bytes. Old task IDs and new project IDs can
legitimately be equal because they are independent primary-key domains, so an
in-place nesting operation can collide with a valid source directory.

## Decision

The attachment business layer derives the fixed bucket/path address as
`task-attachments/<canonicalProjectId>/<canonicalTaskId[:2]>/<canonicalTaskId>/<relativePath>`.
Project/task UUID normalization and original relative-path validation precede
prefix construction. Runtime file operations and offline maintenance share one
private task-prefix rule. The full task UUID remains its directory identity;
the first two hexadecimal characters provide at most 256 shard names per
project. PostgreSQL retains the logical task-relative path and no physical key.
API, CLI and preview URLs retain their original form, including relative HTML
and Markdown resources. Generic Storage continues to receive bucket/path only.

The [original attachment decision](2026-10-21-task-attachment-storage-design.md)
selected a direct task-only directory and left potential physical sharding to
an adapter. That was sufficient for a globally unique task identity and the
initial file API, avoiding another storage identity or migration mechanism.
This decision replaces its address layout and sharding ownership: project and
task grouping are attachment policy, so they belong to the business owner.
The original single-file, trusted-origin and accepted K1 choices remain valid.
The [requirements](../../../../docs/spec/daynight-task-attachments.md) own required
outcomes and the [architecture](../../../../docs/design/daynight-task-attachments.md#存量布局迁移)
owns the detailed address and migration contracts.

The same server executable exposes explicit offline `migrate-attachment-layout`
plan/apply/resume operations. Maintenance reads only database/root configuration,
uses read-only database queries and does not start HTTP, authentication or SQL
schema migration. An operation manifest binds database/schema identity, full
business-row digests, task ownership, root/directory inventory and regular-file
sizes/SHA-256 values. Known-task unregistered regular files move with their
whole task tree and are reported without adding metadata. Unknown ownership,
registered missing or size-mismatched files, source symlinks, special files and
conflicts are explicit failures.

The initial manifest and its bound planned state are prepared and synchronized
in a private `.attachment-plan-<operationId>/` directory. An atomic rename
publishes the complete pair under `.attachment-layout-<operationId>/`, followed
by root-directory synchronization. Only then are plan_created and success output
emitted. Before publication, ordinary errors clean only their own private attempt
and retain any cleanup failure. Process-termination residue contains no attachment
bytes, is not a resumable operation and does not block a new plan. Such residue
is not automatically swept. After publication, failures retain the complete
official records for explicit same-operation continuation.

All writers must be stopped and a matching database/directory backup retained.
A database advisory lock serializes maintenance invocations only. The command
rejects new plans when an existing operation is unfinished (`resume_required`)
or completed (`already_migrated`), reporting its operation ID for continuation
or same-operation verification. This check precedes empty-store classification
and prevents a completed zero-metadata tree from being nested again when a
project UUID equals a task UUID. The whole old bucket moves into an operation-owned source
namespace; complete task directories then move into a separate target tree.
The target is published only after full content validation and a fresh
independent database snapshot. Destination existence is checked under the
exclusive-writer precondition, with no overwrite, merge or copy fallback.
Three normal streaming hash passes cover planning, pre-move revalidation and
pre-publication verification. Final publication renames the same verified tree.

An explicit resume ID reconciles only manifest-explained source/target/final
positions, including publication before its completion receipt. Phase records
can straddle a rename, so actual locations and complete contents determine legal
continuation. Empty plans produce explicit verifiable no-op receipts. Completed
operations can be verified again without moving files. Unexplained states stay
failed and writers remain stopped. This is bounded layout conversion state,
not a general cross-store recovery ledger or an online legacy-read path.

Rollback uses the retained image and matching paired backup. Historical data
restoration follows that version's task-cache invalidation contract; pure layout
maintenance leaves existing epochs and all business rows unchanged. The
[deployment guide](../../../../deployment/localhost/README.md#attachment-layout-upgrade)
owns commands, writer quiescence and restore ordering.

## Alternatives

**Keep task grouping inside the local adapter.** It would make generic bucket
storage interpret project/task policy or require an extra backend-only address
translation. Business-layer derivation preserves one rule shared with explicit
maintenance and keeps other file consumers independent.

**Persist a separate physical storage key.** A key could support arbitrary
placement, but it would add a second identity, schema and migration obligations
for an address already derivable from existing ownership and path fields.

**Nest old task directories directly under project names.** A valid project ID
can equal a legacy task ID, so its destination root can already be a source.
Separating the entire old bucket from the new target removes this collision.

**Copy a complete new storage root and switch its mount.** This keeps a full old
copy, but requires full extra content space, byte copying and root/volume
cutover. Same-filesystem task-directory renames preserve content with a bounded
operation manifest; the existing paired backup provides the rollback copy.

**Expose an operation directory before writing its initial records.** A process
can stop before the manifest exists, leaving a discoverable operation that blocks
a new plan but cannot be resumed. Preparing the complete pair in an unpublished
namespace and promoting it atomically makes every official operation actionable.

**Migrate during ordinary access or read either layout.** That couples request
behavior to upgrade progress and introduces compatibility paths into every file
operation. Explicit stopped-write maintenance makes publication and errors
observable before the new runtime serves data.

## Consequences

Clients and PostgreSQL keep stable logical identities while instance storage is
organized by project and task shard. Project directories are not independent OS
sandboxes; root confinement and allowed generic-adapter symlink behavior retain
the [storage foundation](2026-10-21-bucket-file-storage.md) contract. Ordinary
empty-parent pruning naturally includes task/shard/project and stops before the
bucket, preserving nonempty siblings.

Upgrade needs a stopped-write window, backup capacity and full-content reads.
Pre-existing K1 inconsistencies can block planning; maintenance exposes them
rather than inventing ownership or changing metadata. Ordinary process failures
can resume, while arbitrary hardware/filesystem power-loss states are not
promised transactional recovery. Once writes reopen, restoring an old backup
would discard later changes and requires a separate preservation decision.

Validation uses actual directories and PostgreSQL, fixed same/different shard
UUIDs in one instance, unchanged API/installed-CLI/browser paths, genuine old
bytes, namespace collision, interruption and paired restore. These are required
observable checks; passing results remain tied to the tested source, artifacts
and environment rather than implied by this decision record.
