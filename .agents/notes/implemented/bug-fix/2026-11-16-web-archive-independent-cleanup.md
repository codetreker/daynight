# Agent Note: Separate Web archive maintenance from worktree cleanup

Status: implemented

## Problem

A stopped Web execution can fail to archive for reasons unrelated to worktree
ownership or deletion. Treating every archive failure as a deletion prerequisite
retains the worktree and prevents a successor claim even when the original
process has stopped and the retained archive source is independent of that tree.

## Decision

After confirming the original execution stopped and its backend closed, Web
cleanup attempts archival but continues safe worktree removal and local settlement
on any archive failure. The archive maintenance owner records the original error
and identity for independent retry, retaining Controller execution sources.
Legacy persisted archive repair waits do not gate cleanup. Cancellation still
stops subsequent file operations; stop, ownership and Git deletion failures keep
their own cleanup responsibility. Archival is reported successful only after
actual validation and upload. The [Worker design](../../../../docs/design/daynight-worker.md)
describes the mechanisms.

This replaces the cleanup-owned portion of the [repair decision](2026-11-10-worker-recovery-evidence.md)
and the cleanup retry behavior in the [archive priority decision](2026-11-11-worker-archive-priority.md).
The independent [maintenance owner](../architecture/2026-11-11-worker-archive-maintenance.md)
retains its bounded scheduling and shutdown responsibilities.

## Alternatives

**Wait for successful archival before deletion.** This preserves the worktree
alongside the source, but a permanent data, access or upload error indefinitely
blocks local cleanup and a successor even though the archive source is separate.

**Allow only selected archive errors through.** A whitelist misses new or unknown
failure modes and recreates the same blockage without improving deletion safety.

## Consequences

Archive failure remains visible and may require indefinite source retention;
cleanup success does not imply archive success. Independent repair and retry do
not recreate or touch a successor worktree. Safe deletion still depends on stop
proof and Git ownership, and an independent file failure remains retryable.
