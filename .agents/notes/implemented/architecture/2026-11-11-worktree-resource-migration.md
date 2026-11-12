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

The Worker invokes the converter during repository preparation before admitting
file operations. The caller must hold
the existing instance ownership and repository gate, stop the old Worker, and
provide complete backend and schedule inventories. The [adoption decision](2026-11-12-worktree-manifest-adoption.md) owns the runtime integration and retirement.

Completed Web cleanup and verified Herdr retirement evidence distinguish
historical bindings from owners that still require a manifest. Historical cwd
records remain unchanged when a later claim reuses the same task directory.
Retirement evidence does not authorize inspecting or deleting that path as the
old owner's resource, and conflicting ownership evidence remains an error.

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
