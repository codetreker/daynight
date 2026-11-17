# Agent Note: Remove Herdr Manual Management Commands

Status: implemented

## Problem

The Worker is moving away from Herdr execution. Its dedicated interactive attach
and retained-recording management commands expose a separate manual control path,
while completed Web executions still require their own verified recovery command.

## Decision

The CLI no longer exposes `worker attach` or the Herdr `worker resources list`,
`retry` and `dispose` commands. `worker resources recover` routes directly to the
Web recovery owner, and `worker repair-markdown` remains available. Shared
resource accounting and reconciliation remain with their current callers.

This supersedes the [attach command decision](../../archived/feature/2026-10-27-worker-attach-command.md)
and complements the [retained Web recovery decision](../bug-fix/2026-11-16-worker-retained-resource-recovery.md).
Existing Herdr executions and resources are not migrated or cleaned up by this
change.

## Alternatives

**Keep the manual Herdr commands.** This would retain dedicated control and
resource management entry points for an execution mode being removed.

**Remove shared resource machinery at the same time.** Remaining runtime callers
still use its accounting and reconciliation, so deleting it here would change
those paths before their owners are retired.

## Consequences

Operators no longer have these dedicated CLI entries for existing Herdr resources.
Web recovery retains its original identity, preservation and confirmation checks.
The remaining Herdr runtime and its shared mechanisms still require separate
removal as their callers are retired.
