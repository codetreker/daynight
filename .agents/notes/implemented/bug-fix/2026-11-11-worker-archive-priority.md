# Prioritize terminal cleanup over historical archive backfill

Status: implemented

## Problem

Historical Session backfill and terminal cleanup share the service's single
archive operation slot. Backfill can repeatedly acquire it while cleanup gets
`429 resource_busy`, increasing cleanup backoff to a minute and keeping Worker
execution capacity occupied. More completed history should not prevent new work
from starting after its predecessor has stopped.

## Decision

The Worker defers historical backfill while cleanup remains outstanding or its
latest capacity observation is full. The independent maintenance owner checks
that condition again immediately before starting an attempt; it never interrupts
an upload already in progress. Its nonblocking ownership and shutdown behavior
remain as described in the [maintenance decision](../architecture/2026-11-11-worker-archive-maintenance.md).
Cleanup retains its original resource ownership until safe worktree removal is
confirmed. [Web archive maintenance](2026-11-16-web-archive-independent-cleanup.md)
and [native Herdr cleanup](2026-11-16-herdr-cleanup-independent-of-archive.md)
maintain archive responsibilities independently. The [execution capacity decision](../architecture/2026-11-11-worker-execution-capacity.md)
independently releases the slot after the original execution stops. The scheduling and
request rules are owned by the [Worker design](../../../../docs/design/daynight-worker.md).

Archive requests retain the HTTP status and structured service error code. Only
an explicitly replayable request receiving `429 resource_busy` gets bounded
retries inside the original round deadline, using the
[terminal archive backoff policy](2026-11-20-terminal-archive-backoff.md). Each retry preserves the
original identity and bytes. Current reads, durable source batches, ordinary
preparation, offset/hash-bound chunks, sealing and manifest commits support that
replay. A future preparation reset must be evaluated separately. Busy can follow
recoverable upload settlement work, so it does not imply that no state changed.
Unknown network outcomes retain their existing reconciliation behavior.

The original choice used a 5–7 second cleanup retry for an exhausted archive
busy response without increasing the failure count. This reduced contention while
cleanup still waited for archival. Web archive failures now belong to independent
backfill rather than cleanup retry. No service protocol changes are needed. This specializes the transient retry policy from the immutable
[cleanup retry decision](../../archived/bug-fix/2026-11-04-worker-cleanup-retry.md).
The separate [archive repair policy](2026-11-10-worker-recovery-evidence.md)
continues to retain incomplete originals for low-frequency condition probes.

## Alternatives

**Release capacity while archive remains pending.** At the time this alternative
was considered, failed cleanup retained capacity together with the worktree
barrier. The later [execution capacity decision](../architecture/2026-11-11-worker-execution-capacity.md)
separates the stopped execution slot from that retained barrier.

**Queue requests or increase archive slots on the service.** This would change
the specified immediate busy response and the service's resource envelope for
all clients. The Worker can remove its own avoidable competition without that
protocol change.

**Migrate old archives in a service background job.** That requires an independent
durable migration lifecycle and does not by itself prioritize terminal Worker
cleanup over other archive operations.

## Consequences

Cleanup can use newly available archive slots sooner without discarding history,
resetting failure evidence or weakening ownership checks. Historical backfill
may remain deferred while capacity stays full or any cleanup needs repair.
Other Workers and clients can still compete for the same service slot; bounded
retries do not provide cross-client fairness or guaranteed completion time.
Cancellation and the round deadline bound all waits, including Retry-After.
