# Agent Note: Skip Unchanged Bot Display Snapshot Saves

Status: implemented

## Problem

The Session client publishes even when current polling has no new display
history. Each publication can schedule a snapshot flush, whose new `savedAt`
caused a storage write and LRU update without changing the displayed data.
Page lifecycle flushes also need to preserve a changed reading position.

## Decision

After validating the observation lease and history progress under the account
lock, the store compares the normalized candidate with the current record,
excluding `savedAt`. An equal candidate leaves the record, LRU and notifications
unchanged. A memory-only record reports the existing memory outcome. Changes to
accepted history, name or reading anchor still use the ordinary save path.

## Alternatives

**Discard repeated client publications.** A publication may accompany a name or
reading position change, and suppressing it globally could hide other consumers'
updates.

**Remember the observer's last successful save.** Another tab can alter or revoke
the record after that save. Comparing the current record under the store lock
preserves the existing cross-tab lease and generation checks.

## Consequences

Unchanged polling and lifecycle flushes do not renew `savedAt` or alter LRU.
Each flush still validates and compares bounded snapshot content under the lock.
The store's existing memory-only degradation and revocation fences remain in
effect; a failed disk write is not reported as durable.
