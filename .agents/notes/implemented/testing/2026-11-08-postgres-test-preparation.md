# Agent Note: Reuse PostgreSQL Test Preparation

Status: implemented

## Problem

The PostgreSQL root tests repeatedly establish management connections and build
complete schemas for fault matrices that only need independent operations against
the same initial state. Historical migration-failure matrices replay the same
known-good prefix before each independent failure. Snapshot comparison faults
also repeat historical replay and snapshot construction. Expiry waits add elapsed
time when the behavior under test receives its clock from the caller, without
proving production clock sampling.

## Decision

Only the root package shares a lazy management pool, closed after all test
cleanups in `TestMain`. Each fixture owns its schema and operational pool. The
shared test helper exposes explicit borrowed-pool ownership; its existing callers
still own a management pool per fixture. A matrix may retain one fixture across
its sequential cases when restoration and resource exit are verified before reuse.
Independent tests retain separate mutable stores.

The membership error matrix reuses its initial records and commits reversible
table renames. Each case restores the original relation OID before reuse and
still requires a real missing-relation error. Assignee error tests reuse each
fault schema for two read-only modes.

[Step rollback and suppressed-row proofs](../../../../packages/daynight-server/internal/core/store/postgres/task_steps_rollback_witnesses_test.go),
[Step deletion faults](../../../../packages/daynight-server/internal/core/store/postgres/task_steps_delete_test.go)
and [Bot preference faults](../../../../packages/daynight-server/internal/core/store/postgres/bot_scope_test.go)
retain one initialized store per matrix. Every case still executes the real
production scope and verifies its error, transaction completion and persisted
state. Injected triggers, functions and constraints are removed and their absence
is read back. Attempt sequences still require the second real row write;
`nextval` survives rollback, so those sequences are explicitly removed before
another case uses the fixture. Invalid migration-history cases restore the
complete original ledger, including checksums and `applied_at`, and compare it
before the next fault. A failed case stops subsequent fixture reuse.

[Task write competition](../../../../packages/daynight-server/internal/core/store/postgres/task_mutation_witnesses_test.go)
uses distinct Project and Task IDs inside each matrix's store. Actual lock
observations, competing transactions, winner/version assertions and committed
readback remain. Every writer is cancelled when necessary and joined before the
case ends, keeping later cases free of earlier work.
[Attachment rollback proofs](../../../../packages/daynight-server/internal/core/store/postgres/attachment_lifecycle_witnesses_test.go)
retain separate real filesystem resources per case while sharing their unchanged
database fixture. Trigger restoration and database readback remain separate from
file effects and physical-connection cleanup.

Closed-before-entry probes construct and close an actual `pgxpool` without schema
initialization. Their callbacks still must not run and their original error and
completion assertions remain. Tests of successful `Open` or `Ready` retain actual
initialization and database access.

Snapshot parity and its five comparator faults share one full historical replay
and one independent snapshot. Mutations run in transactions with rollback;
`nextval` state is restored explicitly, including `is_called`, and read back.
Snapshot regeneration and full catalog, data and sequence comparison remain.

[Personal ownership migration failures](../../../../packages/daynight-server/internal/core/store/postgres/personal_ownership_migration_test.go)
share one real replay through migration 31, and
[invalid property migration inputs](../../../../packages/daynight-server/internal/core/store/postgres/property_rows_test.go)
share one real replay through migration 25. All seven ownership and five property
failure cases still execute the real migration in its own transaction. Source
facts and the original migration ledger are compared before restoration; old
catalog names and the absence of newly created objects remain checked. Mutated
member and invitation rows are restored from the captured records, including
versions, timestamps and bytea data. The old member sequence's `last_value` and
`is_called` are restored separately, and the ledger rejection trigger and function
are removed with catalog readback. Every case verifies the valid fixture before
reuse; a failed case stops the matrix.

Property fault inputs remain raw text. Unknown, null, duplicate and missing fields
are written and read without normalizing their JSON, and the complete source rows
must survive a failed migration unchanged. The bad row is returned to its exact
valid value before reuse. Successful migration cases retain independent fixtures,
including called/uncalled sequence semantics and the 105-row property transform
that crosses its 100-row page boundary.

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
have different lifetimes. Those lifetimes remain isolated across independent
tests; reuse is limited to matrices with explicit restoration and writer exit.

**Wrap the fixture in an outer transaction.** Production scopes and migrations
acquire their own connections and own real commits and rollback. An outer
transaction cannot restore those operations or replace their persisted-outcome
proofs. Fault objects are restored explicitly after the real operation completes.

**Replay each historical prefix for every failure.** This gives each case a
pristine schema without explicit data restoration, but repeats the same catalog
construction and committed prefix work. Failure matrices retain a real prefix
replay and require source, catalog, ledger and pool restoration before another
failure uses it. Successful migration proofs remain independently initialized.

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
cleanup while reducing repeated preparation. Restoration adds database readback
and requires explicit handling of nontransactional sequence advancement. Historical
prefix reuse removes repeated migration applications while preserving actual
failed transactions and raw legacy inputs. Failed restoration or unfinished
writers prevent reuse. Caller-time storage predicates
and service clock sampling have separate proof owners; tests of SQL that samples
database time still cross actual database time. Source-bound comparison and
fault receipts own performance and defect-detection claims; fewer fixtures or
removed waiting windows alone do not establish hosted CI savings.
