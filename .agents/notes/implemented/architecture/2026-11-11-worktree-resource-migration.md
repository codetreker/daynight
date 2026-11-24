# Agent Note: Explicit worktree resource migration

Status: implemented

## Problem

Existing worktrees and frozen execution directories must remain in place while
ownership moves away from Git locks and persistent filesystem identities. A
partial conversion must not discard the only owner or make an incomplete set of
resources appear ready for the new format.

## Decision

This historical decision was superseded by [Git registration discovery](../simplification/2026-11-24-worker-git-worktree-discovery.md).

An explicit migration component publishes and reads back manifests before
rechecking and releasing matching legacy locks and removing associated obsolete
sidecars. A re-enumeration precedes the final format marker. Retries preserve the
original checkout and frozen cwd. The [Web responsibility decision](2026-11-17-web-worktree-migration.md)
limits this conversion to Web execution evidence; the original decision included
Herdr bindings, schedules and Git registrations as candidate sources. The
[namespace decision](../simplification/2026-11-13-ignore-unassociated-worktree-directories.md)
explains the separate treatment of unassociated directories. The
[manifest store](2026-11-11-worktree-manifest-storage.md) supplies durable
publication and uniqueness checks.

The Worker invokes the converter during repository preparation before admitting
file operations. The caller holds the existing instance ownership and repository
gate, stops the old Worker, and provides Web records and related schedules. The
[adoption decision](2026-11-12-worktree-manifest-adoption.md) owns runtime integration
and retirement. Completed Web cleanup distinguishes historical bindings from
owners that still require a manifest; conflicting ownership remains an error.

## Alternatives

**Move old checkouts to their new identifiers.** Moving them would invalidate
frozen Controller and Herdr working directories and could disrupt existing
executions.

**Keep legacy ownership as a runtime fallback.** Two simultaneous ownership
formats would retain ambiguous lookup and cleanup paths and make partial
conversion difficult to distinguish from successful admission.

## Consequences

An interrupted conversion can be retried without losing the unique old owner;
conflicting or unreadable sources remain errors. A manifest does not authorize
deleting nonempty unregistered content. Conversion does not establish that an
Agent or an escaped Git descendant has stopped. An old Worker cannot manage the
converted format; rollback requires stopping the manager and explicit recovery.
