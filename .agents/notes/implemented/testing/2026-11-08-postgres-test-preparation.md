# Agent Note: Reuse PostgreSQL Test Preparation

Status: implemented

## Problem

The PostgreSQL root tests repeatedly establish management connections and build
complete schemas for error matrices that only need independent faults against
the same initial state. Snapshot comparison faults also repeat historical replay
and snapshot construction. Fixed expiry waits add time unrelated to their lock
and clock guarantees.

## Decision

Only the root package shares a lazy management pool, closed after all test
cleanups in `TestMain`. Every fixture retains its own schema and operational
pool. The shared test helper exposes explicit borrowed-pool ownership; its
existing callers still own a management pool per fixture.

The membership error matrix reuses its initial records and commits reversible
table renames. Each case restores the original relation OID before reuse and
still requires a real missing-relation error. Assignee error tests reuse each
fault schema for two read-only modes.

Snapshot parity and its five comparator faults share one full historical replay
and one independent snapshot. Mutations run in transactions with rollback;
`nextval` state is restored explicitly, including `is_called`, and read back.
Snapshot regeneration and full catalog, data and sequence comparison remain.

Expiry probes observe real locks before crossing a short future database-time
expiry. The grant test arms expiry after its lock receipt, preserving rejection
of a stale time sampled before the lock. Private Transfer retains the locked,
cached token expiry. Deadline probes retain connection preparation and actual
query observation. The large search fixture keeps its complete description but
constructs its expected snippet independently.

## Alternatives

**Share operational pools or mutable schemas across the package.** Destructive
catalog tests, independently committed transactions and connection failures
have different lifetimes. Sharing only management SQL avoids that coupling.

**Change migration locking or database authentication.** The measured root-only
lock acquisition cost is small. PostgreSQL SCRAM contributes connection CPU,
but management-pool reuse removes repeated handshakes without changing the
required database authentication environment.

## Consequences

The matrices retain real SQL failures, transaction outcomes and isolated
cleanup while reducing repeated preparation. Shared fixture cleanup must fail
and stop reuse when restoration fails. Source-bound comparison and fault
receipts own performance and defect-detection claims; fewer fixtures alone
do not establish hosted CI savings.
