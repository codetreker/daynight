# Agent Note: Explicit worktree resource migration

Status: implemented

## Problem

Existing worktrees and frozen execution directories must remain in place while
ownership moves away from Git locks and persistent filesystem identities. A
partial conversion must not discard the only owner or make an incomplete set of
resources appear ready for the new format.

## Decision

An explicit migration component collects legacy registrations, published
manifests, cleanup schedules and Web and Herdr bindings, and checks their owner
and location relationships. It publishes and reads back all manifests before
rechecking and releasing its own legacy locks and removing associated obsolete
sidecars. A complete re-enumeration precedes the final format marker. Retries
resume from observed resources, preserving the original checkout and frozen cwd.
The [manifest store](2026-11-11-worktree-manifest-storage.md) supplies durable
publication and uniqueness checks.

The converter is callable in isolation; production Worker startup continues to
use the legacy format until all consumers switch together. The caller must hold
the existing instance ownership and repository gate, stop the old Worker, and
provide complete backend and schedule inventories.

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
