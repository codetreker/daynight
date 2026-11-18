# Agent Note: Reuse PostgreSQL Test Preparation

Status: implemented

## Problem

PostgreSQL Store tests repeatedly establish management connections and build
complete schemas for fault matrices that only need independent operations against
the same initial state. Historical migration-failure matrices replay the same
known-good prefix before each independent failure. Snapshot comparison faults
also repeat historical replay and snapshot construction. Expiry waits add elapsed
time when the behavior under test receives its clock from the caller, without
proving production clock sampling. Independent storage proofs also run serially
when their fixture state is isolated, while unrestricted overlap can increase
catalog memory and contention on database-level advisory keys. Separate schemas
do not isolate process-global HTTP settings or database-wide lock observations.

## Decision

Only the root package shares a lazy management pool, closed after all test
cleanups in `TestMain`. Each fixture owns its schema and operational pool. The
shared test helper exposes explicit borrowed-pool ownership; its existing callers
still own a management pool per fixture. A matrix may retain one fixture across
its sequential cases when restoration and resource exit are verified before reuse.
Independent tests retain separate mutable stores.

Independent root parents are explicitly selected for bounded parallel execution,
including lifecycle, snapshot, cancellation, rollback and authority-witness
proofs. Each selected test calls
[`parallelRootDatabaseTest`](../../../../packages/daynight-server/internal/core/store/postgres/testutil_test.go)
as its first statement, before creating contexts, deadlines or fixtures. The
helper first enters Go's parallel scheduler, then acquires one of two root-only
permits and registers its release as the parent's first cleanup. Later resource
and fixture cleanups run first in LIFO order, so the permit covers Store closure
and schema deletion. A permit bounds one parent test's ownership interval; a
parent can own multiple schemas or pools. Explicit `-parallel=1` still limits
execution to one parent, and larger scheduler values cannot increase the permit
capacity. Package concurrency and production connection and migration-lock
defaults remain unchanged.

Each selected parent's fixtures retain schemas, `search_path`, `application_name`
and operational pools separate from other parents. Contention observers identify
the fixture's application, an exact backend or a query marker that cannot match
another fixture. Fixed SQL function, trigger and index names remain local to
their schema. Descendants do not enter parallel scheduling or acquire another
root permit: a parent awaiting a parallel child can otherwise occupy a permit
while scheduler slots are occupied by other parents awaiting permits. The shared
management pool remains protected by `sync.Once` and closes only after every
test cleanup completes.

Historical prefix migrations and schema-control tests retain their serial
scheduling. Explicit migration-lock holders remain serial because every ordinary
fixture initialization also needs that database-level lock. Snapshot regeneration
can write `schema/current.sql`, and process-entry tests retain their existing
parent/child scheduling. These tests are separate from the selected parallel
parents; private schemas alone do not establish that their control and resource
lifetimes can overlap.

The executor tests in
[`github_app_executor_test.go`](../../../../packages/daynight-server/internal/core/store/postgres/github_app_executor_test.go)
and callers of `controlledAppExecutor` in
[`github_executor_test.go`](../../../../packages/daynight-server/internal/core/store/postgres/github_executor_test.go)
retain serial scheduling while they replace process-global `http.DefaultTransport`.
The App Work tests that use the database-wide `waitAppWorkLock` observation in
[`github_app_work_scope_test.go`](../../../../packages/daynight-server/internal/core/store/postgres/github_app_work_scope_test.go)
and the two database-wide waiter observations in
[`webhook_scope_test.go`](../../../../packages/daynight-server/internal/core/store/postgres/webhook_scope_test.go)
also remain serial: another fixture's blocked backend can satisfy their
readiness predicate without the intended operation reaching its lock.

The three gated Credential Usage tests in
[`credential_usage_test.go`](../../../../packages/daynight-server/internal/core/store/postgres/credential_usage_test.go)
retain serial scheduling while they share advisory key `780065` and a waiter
lookup that can return a peer fixture's holder. Go finishes serial parents before
resuming the queued parallel parents, keeping these global-state and observation
controls outside the parallel group. Random schemas do not isolate production
database-level advisory keys either, so selected transactions can still wait on
identity or OAuth capacity locks.

The membership and
[Identity error matrices](../../../../packages/daynight-server/internal/core/store/postgres/identity/failure_contract_test.go)
reuse their initial records and commit reversible table renames. Each case
requires PostgreSQL's missing-relation error and restores the original relation
OID before reuse. Identity runs the production transaction for every operation
and checks its error chain and uncommitted outcome. It resets the operational
pool after each rename so prepared statements from fixture setup or a preceding
case cannot still address the renamed relation. The missing-users case also
checks Session authentication while the relation is still absent. A failed case
stops further reuse. Assignee error tests reuse each fault schema for two
read-only modes.

The [first image-chunk inventory matrix](../../../../packages/daynight-server/internal/core/store/postgres/storage_inventory_test.go)
shares one parent-owned Store across its sequential cases. Each case retains its
own context, generated identities, raw JSON variants, committed Session/upload/chunk
rows and complete inventory assertions. After each successful child and its
cleanup finish, the active parent checks pool reuse, commits bounded deletes from
`session_image_chunks`, `session_image_uploads` and `task_sessions`, reads all three
table counts as zero, then checks pool reuse again. A failed child or restoration
stops the matrix; the parent still closes its Store and drops its schema before
releasing its permit. Restoration targets only the three tables written by this
matrix, which has no sequence, trigger or schema mutation to restore. The
production inventory scan retains its own read-only repeatable-read transaction.

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

The [Team Invitation fault matrix](../../../../packages/daynight-server/internal/core/store/postgres/team_invitations_test.go)
uses independent Teams, actors and tokens in one Store. Transactional table
drops still produce a missing-table error and restore the original relation
and invitation before reuse. The consume fault removes and verifies its
trigger and function before retrying the same token. Waiter cases observe the
other transaction's backend, drain the waiter, and verify persisted results
and connection reuse before moving on. Any failed case stops reuse.

The GitHub [signal](../../../../packages/daynight-server/internal/core/store/postgres/github/app_signals_test.go)
and [project retirement](../../../../packages/daynight-server/internal/core/store/postgres/github/app_lifecycle_test.go)
matrices each use one Store. Cases keep distinct App, grant, and Project
identities with mutations restricted to their own rows. Signal tests hold the
installation and repository identifiers constant across Apps and read committed
pending rows by Project. Retirement cases finish their transaction before the
next case. The trigger fault is observed as its PostgreSQL exception, the
affected state is read back after rollback, and the trigger and function are
removed and checked in the catalog before reuse. A failed case or transaction
release stops the matrix.

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

Expiry probes whose SQL samples database time retain actual row lock barriers
and short test deadlines. The grant test arms expiry after its lock receipt,
preserving rejection of a stale time sampled before the lock. Private Transfer
retains the locked, cached token expiry. Deadline probes retain connection
preparation and actual query observation. The large search fixture keeps its
complete description but constructs its expected snippet independently.

The [Direct Member](../../../../packages/daynight-server/internal/core/store/postgres/direct_member_scope_test.go)
and [Registered Member](../../../../packages/daynight-server/internal/core/store/postgres/registered_member_scope_test.go)
expiry cases acquire the row holder and prepare the other connections before
setting the credential expiry from the PostgreSQL clock. The observer verifies
the intended lock and a still-valid credential before waiting with
`pg_sleep_until`. It confirms expiry through the database clock before the
holder commits. The Direct Member case also observes a queued revocation and
commits a compatible Session credential read before expiry. The test-local
window has to accommodate these observations under the configured root
concurrency.

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
acquire their own connections and own real commits and rollback. Inventory
verification also opens its own transaction and must read committed fixture rows.
An outer transaction cannot restore those operations or replace their
persisted-outcome proofs. Fault objects are restored explicitly after the real
operation completes.

**Verify inventory restoration through an empty inventory scan.** The scan reads
image chunks through uploads and Sessions. Removing those parents can leave
orphan chunks invisible to the scan, so an empty result cannot establish an empty
fixture. Restoration reads the three table counts directly before reusing it.

**Replay each historical prefix for every failure.** This gives each case a
pristine schema without explicit data restoration, but repeats the same catalog
construction and committed prefix work. Failure matrices retain a real prefix
replay and require source, catalog, ledger and pool restoration before another
failure uses it. Successful migration proofs remain independently initialized.

**Change migration locking or database authentication.** The measured root-only
lock acquisition cost is small. PostgreSQL SCRAM contributes connection CPU,
but management-pool reuse removes repeated handshakes without changing the
required database authentication environment.

**Parallelize every root parent.** Private schemas cannot isolate replacement of
`http.DefaultTransport`, a database-wide lock observer or a shared advisory gate.
Those tests need their global state and observations isolated before they can
join a parallel group. Explicit migration-lock, snapshot and process controls
retain their existing scheduling until their complete lifetimes are verified
under overlap.

**Use unrestricted parent parallelism.** The testing scheduler's width can be
raised independently of the database resource budget. Root permits bound complete
parent lifetimes, including fixture cleanup, while preserving the scheduler's
narrower explicit settings and independent stores.

**Acquire permits inside fixture helpers.** That would leave contexts and other
parent resources outside the limit and make nested fixture acquisition part of
the scheduling contract. Parent entry establishes the lifetime limit before any
resources are created, without changing ordinary fixture helpers or serial tests.

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
database time still cross actual database time. The inventory matrix trades
repeated schema construction for committed row deletion and explicit emptiness
checks. Changes to its write footprint require corresponding restoration and
readback changes before the fixture can be reused.

Selected parent overlap retains each test's inputs, assertions and complete
resource cleanup. Admitting another parent requires checking its transitive
helpers, process-global state, lock observations and database-level keys as well
as its schema isolation. The two-parent limit does not fix a shared-state defect
or bound each parent's internal resource count. Bounded overlap can increase peak
database memory and lock waits even when every test owns its mutable schema.

Source-bound comparison and fault receipts own performance and defect-detection
claims; fewer fixtures, removed waiting windows or parallel scheduling alone do
not establish hosted CI savings. Matching root and full-module measurements must
retain the resource budget and verify parent ownership intervals, resource
cleanup and the scheduler's explicit settings.
