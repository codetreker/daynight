# Agent Note: Remove Controller cumulative media reservations

Status: implemented

## Problem

Historical media reservations can prevent a Controller from starting, writing or
maintaining an execution even when the remaining metadata and free-space checks
would admit the actual work. The execution-wide 2200 MiB and state-directory-wide
8 GiB limits also turn retained recovery files into a cumulative admission policy
independent of the filesystem's ability to accept a write.

## Decision

Controller storage has no cumulative media limit per execution or state
directory. The shared media budget ledger and its `allocations` reservation and
refund mechanism are removed. Runtime, media preparation, stopped maintenance,
normal closure and Worker execution-file deletion never create, open, read,
update or release `controller/media/budget.sqlite`. Existing files may remain
untouched; they carry no authority and require no journal format migration.

The ledger removal originally retained the independent metadata policy,
512 MiB free-space watermark and remaining-work disk peak estimates. The later
[free-space and peak admission removal](2026-11-16-controller-free-space-admission-removal.md)
removes that watermark and those estimates, including media scans and unwritten
byte accounting used only for prediction. Metadata admission remains in force;
maintenance checks actual metadata after cleanup.

Execution, Session, claim, generation, attempt and native identities retain
their existing owners. Storage permits, reader barriers, stopping evidence,
private-path checks, immutable originals, file leases, transaction outcomes and
atomic publication remain unchanged. Actual filesystem, SQLite, commit and close
failures remain visible with their original certainty and cleanup semantics.
Worker deletion completes the same physical cleanup without a separate refund.
On POSIX, the captured execution parent is synced after directory removal and
before cleanup completion is persisted, including a retry whose original target
is already absent. This durability barrier belongs to execution cleanup and does
not depend on the existence of an obsolete ledger. Sync failures retain the
original deletion responsibility.

This partially supersedes the cumulative media accounting in the
[unified media](../architecture/2026-11-09-unified-session-media-core.md),
[Provider](../architecture/2026-11-05-session-image-providers.md),
[source](../architecture/2026-11-05-session-image-sources.md),
[resource-file](../architecture/2026-11-12-session-resource-files.md),
[SQL content](../architecture/2026-11-12-session-sqlite-content-components.md),
[SQL activation](../architecture/2026-11-12-session-sqlite-activation.md) and
[storage ownership](../architecture/2026-11-12-controller-storage-ownership.md)
decisions. Their original retention, identity, publication and maintenance
rationale remains applicable. The
[capacity-free upgrade decision](../architecture/2026-11-16-controller-capacity-free-upgrades.md)
independently keeps numbered format conversion free of ordinary admission. The
[actual content capacity decision](../architecture/2026-11-13-session-actual-content-capacity.md)
continues to own the service's independently measured logical content limit.
The [current design](../../../../docs/design/session-image-contracts.md#controller-准入与回收)
owns the remaining media, protocol, metadata and runtime limits.

## Alternatives

**Raise the cumulative limits or retain an unlimited ledger.** A larger fixed
limit still rejects sufficiently large retained history. An unlimited or no-op
ledger retains initialization, locking, close failures and refund coupling
without an admission policy that needs those operations.

**Delete old ledger files during startup.** Removal is unnecessary once the
ledger has no readers, and would add a cleanup mutation to startup. Leaving the
obsolete file untouched avoids adding another ownership or recovery mechanism.

## Consequences

Historical reservations and cumulative execution size no longer block otherwise
admitted work. Controller media can consume more local disk, and actual storage
failures continue to fail the operation. Existing media and execution
files retain their original lifecycle and are not swept to satisfy admission.

Single-image and message limits, archive and protocol limits, decoder memory and
concurrency, outbox backpressure, logical content limits remain independently owned policies. The later
[metadata admission removal](2026-11-16-controller-metadata-admission-removal.md)
removes the remaining cumulative metadata policy. Reintroducing a local
cumulative quota would require an explicit policy decision and new accounting
ownership, rather than reactivating stale `allocations` rows.
