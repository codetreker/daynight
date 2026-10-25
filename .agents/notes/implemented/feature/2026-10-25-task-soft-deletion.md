# Agent Note: Retained Task Deletion

Status: implemented

## Problem

Tasks created by mistake or no longer needed remain in normal task views. Removing
them must preserve stored work and attachments, keep dependency graphs complete,
and prevent a single disappearing task from being mistaken for lost project access.

## Decision

Task deletion marks `tasks.deleted_at`, preserves task fields, dependency records,
attachment metadata and bytes, and excludes the task from normal reads, graphs,
statistics, execution candidates and new dependency references. A version-bound
DELETE uses the existing project lock and member authorization. Any undeleted
successor prevents deletion; an active worker claim must be released first.
Human in-progress tasks without an active claim remain deletable.

The marker, version/timestamp update and rotation of `projects.task_cache_epoch`
commit atomically. The existing summary protocol then replaces the complete
project cache, including details, on its next sync. Authorized access to a
retained deleted task returns `410 task_deleted`; missing tasks and inaccessible
projects retain `404 not_found`. Web sessions handle deletion locally and keep
the project's access admission. A deleted terminal belongs to the cache generation
that established it, preserving the existing supported history-replacement rule.
After paired database/filesystem recovery and epoch rotation, a later authorized
snapshot containing both a live node and its summary reopens the same task ID
through a required live GET. Matching IDs, versions or timestamps cannot reuse
old detail authority. Every status, permission, platform and deletion outcome
passes the current operation-owner and history admission checks before updating
details or mutation state. Late old-history responses cannot delete the restored
view, replace a newer operation's feedback, or release its shared write lock. This
includes a late successful non-delete response after a new DELETE has started,
as well as late DELETE `204` or `410` responses. Existing principal and
project-revocation checks retain their own scope/ticket protections.

CLI deletion uses the existing exact-version mutation pattern without automatic
retries. Shared Web details require a destructive confirmation and retain their
single operation owner, identity fencing and GET-only unknown-result recovery.
[Requirements](../../../../docs/spec/daynight-task-deletion.md) and
[design](../../../../docs/design/daynight-task-deletion.md) own the full behavior.

This replaces the no-task-deletion assumption in the original
[transactional storage](../architecture/2026-10-19-server-transactional-storage.md),
[task design](../architecture/2026-10-19-daynight-server-task-design.md),
[dependency policy](2026-10-19-task-dependency-policy.md) and
[CLI design](../architecture/2026-10-20-project-task-cli-design.md).
The [summary window API](../architecture/2026-10-24-task-summary-window-api.md)
and [timestamp-window views](../architecture/2026-10-24-task-view-timestamp-window.md)
retain their protocol and gain this supported epoch-replacement writer.

## Alternatives

**Extend deltas with tombstones.** A deletion feed could remove individual cached
tasks without a full snapshot. It would add deletion DTOs, persistent lifecycle
semantics and client cutover work. The existing epoch replacement already provides
atomic removal and is used here, accepting a full project sync per deletion.

**Hide or detach a referenced prerequisite.** Ignoring retained edges would either
break complete graph context or silently make dependent work ready. Deletion
therefore refuses any undeleted successor and leaves relationship editing explicit.

**Return ordinary not-found for deleted tasks.** Existing detail sessions interpret
a known task's not-found response as project access withdrawal. A distinct Gone
response preserves that security rule while permitting task-local removal.

**Physically remove task data.** This would discard work and require reference and
attachment cleanup across non-atomic PostgreSQL/filesystem storage. Retained
markers satisfy the required data-preservation behavior without that cleanup.

## Consequences

The public Task and task-sync shapes stay stable. Delete shares the existing
project serialization boundary, so new references cannot race a successful
removal. Retained data still consumes database and storage capacity. Each deletion
invalidates the whole project cache and causes a full snapshot rather than a small
delta. A high deletion rate would justify reconsidering tombstones with measured
transport and cache costs.

The existing [paired backup recovery](../../../../deployment/localhost/README.md#persistence-and-backup)
continues to replace a project history after epoch rotation, including records that
were live in the captured history. Terminal deletion state and asynchronous
operation results therefore obey the same cache-generation boundary as details
and the current mutation owner. Discarding an old history's view authority cannot
allow its delayed callback to release a newer operation's exclusion or replace
that operation's feedback.

Task-level restore, trash browsing, bulk deletion and cascading relationship edits
remain separate features. Their later addition must preserve retained task
identity, explicit reference rules, access checks and cache-generation
invalidation; no current API exposes deleted task contents or treats the marker
as a fourth status.
