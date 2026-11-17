# Agent Note: Separate Herdr Worktree Cleanup from Archive Finalization

Status: implemented

## Problem

A stopped native Herdr execution can retain a worktree indefinitely when its
recording source, archive journal, sealing, publication or upload cannot be
completed. The worktree then blocks a successor even though the original process
has stopped and its independent recording source remains available for recovery.
Conversely, an archive failure does not establish that the original process or
an in-flight local operation has stopped.

## Decision

Terminal cleanup joins original local operations and selection cleanup, verifies
the original stop proof and Git binding, and settles the worktree from actual
directory and registration absence. Local task and cleanup schedule settlement
and manifest retirement use the existing ownership and observation mechanisms.
The archive queue retains the original Session and source and independently
continues segment closure, ledger publication and archive finalization. It does
not delete the worktree or manufacture a receipt or disposition. Cleanup and
archive failures remain separate; only archive recovery clears an archive error.
Unknown stopping, conflicting ownership and failed Git or settlement operations
retain their respective responsibilities.

This partially replaces the archived [recording finalization decision](../../archived/architecture/2026-11-04-herdr-recording-finalization.md),
which coupled worktree deletion to a durable receipt. The [manifest decision](../architecture/2026-11-12-worktree-manifest-adoption.md)
protected original and successor bindings. The Herdr recording and archive
execution mechanisms have since been removed; the [Web-only runtime decision](../architecture/2026-11-17-worker-web-runtime-composition.md)
records the current ownership boundary.

## Alternatives

**Retain the worktree until a ready or unavailable receipt.** This preserves the
original ordering, but a damaged journal, unavailable source, permission or
network failure indefinitely retains a path that the independent source does not
need for upload and blocks the next execution.

**Add a separate durable deletion ledger.** A second record would need its own
identity, write and restart reconciliation. Existing stop proof, local task,
schedule, manifest and actual Git observations already establish the required
cleanup result without another state machine.

## Consequences

Failed archival remains visible and, while archival is enabled, its source is
retained without holding a settled worktree or same-task barrier. The
[recording discard decision](../feature/2026-11-17-worker-recording-discard.md)
governs local deletion when archival is disabled. Recovery must preserve the original
identity and cannot restart the Agent or replace lost recording evidence. A
restart rechecks original ownership, stop evidence and Git state before retiring
metadata, and cannot delete a successor's directory. Shutdown cancellation
continues to stop later file operations. This decision does not change the Web
backend's independent archive gate or explicit Herdr disposal authorization.
