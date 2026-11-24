# Agent Note: Activate Task Deletion Deltas

Status: implemented

## Problem

Rotating the project task cache epoch for every ordinary deletion forces a full
project snapshot and withdraws unrelated readers. Clients need the deleted root
and hidden descendants while retaining the rest of the authorized history.

## Decision

Ordinary Task and Goal deletion retain the project epoch. The deletion transaction
still commits the effective deletion facts, dependency changes and Session
transitions together. TaskSync publishes those facts as same-history deletion
IDs; the Web atomically applies them with summaries, dependency state and
coverage, then withdraws affected readers. The [sync design](../../../../docs/design/daynight-task-sync.md)
owns the protocol and the [deletion design](../../../../docs/design/daynight-task-deletion.md)
owns the transaction and reader behavior. Actual history replacement and project
deletion retain their existing epoch rotation.

This replaces the ordinary deletion epoch rotation in the historical
[soft deletion decision](../../archived/feature/2026-10-25-task-soft-deletion.md)
and [dependency removal decision](../../archived/feature/2026-10-25-task-delete-remove-depends.md).
The [deletion data](2026-11-24-task-sync-deletion-data.md) and
[atomic cache](2026-11-24-task-sync-atomic-deletions.md) decisions describe the
server and client prerequisites.

## Alternatives

**Continue rotating on deletion.** This remains correct for older clients but
requires a full project replacement and withdraws unrelated state on every deletion.

## Consequences

Unchanged tasks outside the overlap window need not be retransmitted. Retained
physical deletion facts must remain available for any supported old watermark;
physical cleanup requires a replacement coverage mechanism or a history change.
Recovery and raw history replacement must still rotate the epoch before reopening.
