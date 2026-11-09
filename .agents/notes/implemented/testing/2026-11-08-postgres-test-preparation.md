# Agent Note: Reuse PostgreSQL Test Preparation

Status: implemented

## Problem

The PostgreSQL root tests repeatedly establish management connections and build
complete schemas for error matrices that only need independent faults against
the same initial state. Snapshot comparison faults also repeat historical replay
and snapshot construction. Expiry waits add elapsed time when the behavior under
test receives its clock from the caller, without proving production clock sampling.

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

Expiry probes whose SQL samples database time observe real locks before crossing
a short future database-time expiry. The grant test arms expiry after its lock
receipt, preserving rejection of a stale time sampled before the lock. Private
Transfer retains the locked, cached token expiry. Deadline probes retain
connection preparation and actual query observation. The large search fixture
keeps its complete description but constructs its expected snippet independently.

[Session/PAT deletion storage proofs](../../../../packages/daynight-server/internal/core/store/postgres/session_scope_test.go)
use a stable stored expiry and explicit caller times on either side of it. The
first credential admission succeeds before the real Bot lock wait; the second
credential check receives the selected before-expiry or after-expiry time after
the waiter acquires that lock. Real credential `FOR SHARE`, Bot locking,
deletion/replay operations, transaction completion and retained-state readbacks
remain executed. These SQL predicates consume the caller's time, so natural
clock passage is unnecessary for this storage proof. The
[service deletion proof](../../../../packages/daynight-server/internal/service/bot/session_deletion_proofs_test.go)
independently requires fresh clock sampling after Bot/Session admission barriers
for both credentials and committed replay.

## Alternatives

**Share operational pools or mutable schemas across the package.** Destructive
catalog tests, independently committed transactions and connection failures
have different lifetimes. Sharing only management SQL avoids that coupling.

**Change migration locking or database authentication.** The measured root-only
lock acquisition cost is small. PostgreSQL SCRAM contributes connection CPU,
but management-pool reuse removes repeated handshakes without changing the
required database authentication environment.

**Wait for natural Session/PAT expiry.** The deletion fixture previously used
four one-second expiry windows and sampled wall time in its own callback.
Those waits exercised the caller-time SQL predicate but could not establish
whether the production service supplied a fresh time. Explicit caller times
preserve that predicate and the real locking/rollback proof without the waits.

**Update credential expiry after observing the Bot waiter.** The waiting
transaction already holds the credential row `FOR SHARE`. An external expiry
update would wait behind that lock, so it cannot establish expiry before the
waiter is released.

## Consequences

The matrices retain real SQL failures, transaction outcomes and isolated
cleanup while reducing repeated preparation. Shared fixture cleanup must fail
and stop reuse when restoration fails. Caller-time storage predicates and
service clock sampling have separate proof owners; tests of SQL that samples
database time still cross actual database time. Source-bound comparison and
fault receipts own performance and defect-detection claims; fewer fixtures or
removed waiting windows alone do not establish hosted CI savings.
