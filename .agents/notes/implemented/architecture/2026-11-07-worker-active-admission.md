# Agent Note: Worker Active Admission

Status: implemented

## Problem

Concurrent reports on different service instances can each observe spare
capacity for an account and commit distinct Workers, exceeding its active
limit. Client sample times cannot establish liveness, and a time sampled before
waiting for concurrent reports may be stale when capacity is evaluated.

## Decision

Each report takes an account-specific PostgreSQL transaction advisory lock,
samples database time after acquiring it, and reads the target timestamp and
the complete active count at that time. The service applies the 100-Worker
limit before task snapshot and configuration writes. A count over 100 rejects
every report; at exactly 100 only an already active target may renew. A
successful report stores the sampled database time, including when the
target's old timestamp was in the future. Operation refusal rolls back the
report; the transaction lock is released on completion. Commit and cleanup
uncertainty remain observable. The [snapshot specification](../../../../docs/spec/daynight-worker-snapshots.md)
owns the exact boundary and refusal behavior; the
[design](../../../../docs/design/daynight-worker-snapshots.md) owns the transaction.

This changes the per-row competition and older-observation guard in the
archived [snapshot decision](../../archived/architecture/2026-10-28-worker-runtime-snapshots.md).
The independent transaction, current-access filtering, and separation from Task
claims remain in force. The [Worker boundaries](2026-11-05-server-worker-boundaries.md)
retain service coordination and PostgreSQL ownership.

## Alternatives

**Count without account serialization.** Read Committed statements on two
instances can both see 99 active rows and each insert a different Worker, so
the resulting count can exceed 100.

**Continue renewing existing active Workers when the count exceeds 100.**
That indefinitely preserves an already over-limit aggregate under continuous
heartbeats. Refusing all reports until old timestamps naturally expire makes
the aggregate eligible again without changing other Workers' timestamps or
stopping their execution.

## Consequences

Reports for the same account serialize through commit or rollback; independent
accounts retain separate admission and capacity. The indexed count avoids
materializing historical snapshots, but the limit still requires a complete
count of active rows. Reports may be rejected while stored historical active
counts exceed the limit. The service does not evict Workers, alter other
timestamps, or limit inactive history; client samples and read operations do
not renew a slot. The liveness window does not guarantee capacity for a native
execution or change claim ownership.
