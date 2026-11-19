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

Module CI gives the PostgreSQL root test package a dedicated database inside
the shared PostgreSQL instance. The fixed migration advisory key has
database-local scope, so other packages can initialize their fixtures while
the root package replays history or applies the snapshot. The root package
selects the alternate URL in its test entry point, before any fixture opens a
connection. Its subprocesses inherit the selected URL. Lock observations
against instance-wide PostgreSQL views must identify the owning fixture or the
actual blocker. The independent lifecycle and API checks keep their own
databases.

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
The App Work tests that use the fixture-scoped `waitAppWorkLock` observation in
[`github_app_work_scope_test.go`](../../../../packages/daynight-server/internal/core/store/postgres/github_app_work_scope_test.go)
and the two database-wide waiter observations in
[`webhook_scope_test.go`](../../../../packages/daynight-server/internal/core/store/postgres/webhook_scope_test.go)
retain their serial scheduling. The webhook observations match the current
database and can see another fixture's blocked backend.

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

[Task Graph and Sync](../../../../packages/daynight-server/internal/core/store/postgres/task/projection_faults_test.go)
and [Priority and Assignee](../../../../packages/daynight-server/internal/core/store/postgres/task/priority_assignee_faults_test.go)
fault matrices use a separate Store per matrix. Committed renames preserve
the original relation identities. Replacement views expose the selected native
scan or iteration error in the production snapshot. Resetting connections
after each catalog change keeps cached plans from replacing those errors.
Cleanup restores the original OIDs, removes temporary objects and compares the
recovered snapshot with its baseline. Assignee cases retain both the catalogue
and explicit-user reads for the same fault.

[Project App root failures](../../../../packages/daynight-server/internal/core/store/postgres/github_project_app_scope_test.go)
share one Store for missing ownership or Team rows and the three catalog
faults. The write scope sees each committed fault. After restoring the
original rows or reversing the rename, the test resets cached plans and
checks that the real write scope commits without creating a connection.
The original catalog identities and fixture rows must match before the
next case. The missing App and closed-pool checks own a separate Store.

[Backup inventory faults](../../../../packages/daynight-server/internal/core/store/postgres/storage_inventory_boundaries_test.go)
share one committed Session for the descriptor, missing relations and canceled
read. The read-only inventory transaction observes committed faults. Cleanup
deletes the exact invalid descriptor or restores the original relation OID
and clears cached plans, then reads the clean inventory in a fresh transaction.
The malformed ready archive has its own schema because it removes the archive
body constraint. Failed restoration stops fixture reuse.

[Identity profile contention](../../../../packages/daynight-server/internal/core/store/postgres/identity/profile_contract_test.go)
uses one Store per matrix with a distinct identity per case. The tests verify
that the intended SQL waits on the exact holder before committing or rolling
back. Each contender exits before the durable result is read and the next
case starts. Failure cancels the contender, releases the holder and stops
reuse.

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

The Bot DAO binding and preference matrices share one schema per parent.
Each case owns an actual transaction. Rollback removes the case rows and
restores transactional catalog faults before reuse. Missing-relation cases
verify PostgreSQL SQLSTATE `42P01`, and the native preference matrix still
rolls back to its savepoint before reading defaults. The tested version gates
and preference results do not depend on the absolute Bot creation sequence.

Team deletion, Project creation and ownership transfer matrices reuse one
Store per parent. Contention cases use independent Teams and Projects, observe
the actual blocking backend and check committed ownership or its absence. The
[repository occupancy race](../../../../packages/daynight-server/internal/core/store/postgres/project_repository_test.go)
retains the same repository identity across destination Teams and verifies
the only occupant is the committed winner. It checks rollback or absence for
the losing Project. The parent verifies pool reuse after the case joins its
waiters.

The [Project creation Personal Team matrix](../../../../packages/daynight-server/internal/core/store/postgres/project/ownership_contract_test.go)
uses a fresh owner and Personal Team for each committed membership defect. A
separate query transaction reads the exact Team and its member and owner counts
in both lock modes. Each transaction rolls back before the next case. The
parent schema owns the retained rows, and a failed case stops reuse.

Preview SSO retry and redemption refusal matrices own one Store each.
Each case uses a separate login ID, Session, credential and set of token
hashes. It still commits authorization before exercising the real refusal,
rollback or expired-code cleanup and reading the affected login back. The
cleanup case runs before the other redemption cases seed their logins.
The parent checks pool reuse after each case.

The Project deletion claim and thread matrix shares one Store across its
lock-order cases. Each trigger is limited to the case Project or Task. Its
advisory gate belongs to a transaction, and both writers exit before the
trigger and function are removed and their absence is checked. Case-specific
records preserve independent committed-state checks. A failed case stops
reuse.

The [Tag deletion and Task write matrix](../../../../packages/daynight-server/internal/core/store/postgres/tag_concurrency_witnesses_test.go)
shares a Store with distinct Project, Task and Tag identities. The actual
Project row holder blocks the second write until the first commits. The test
checks both completion receipts and the committed deletion, attachment and
Task version facts. Each case joins its writer and verifies pool reuse before
the next case; failure stops reuse.

The [Usage lifetime matrices](../../../../packages/daynight-server/internal/core/store/postgres/usage/lifetime_failures_test.go)
share one Store per parent and give each case independent account, Project,
Task, credential, claim and Session identities. The registration refusal
matrix owns its own schema so the all-table empty check still detects any
escaped registration write. Rotation and aggregate cases retain their real
committed operations and scoped results. A failed case stops reuse.

The GitHub [signal](../../../../packages/daynight-server/internal/core/store/postgres/github/app_signals_test.go),
[App Config](../../../../packages/daynight-server/internal/core/store/postgres/github/app_config_test.go),
[retirement](../../../../packages/daynight-server/internal/core/store/postgres/github/app_lifecycle_test.go),
and [Work stop](../../../../packages/daynight-server/internal/core/store/postgres/github/app_work_test.go)
matrices each use one Store per matrix. Signal cases hold installation and
repository identifiers constant across distinct Apps and read committed pending
rows by Project. The Signal and App Config failure cases use independent App
and Project identities. They commit each catalog fault before the public
writer starts. The writer invokes the intended operation and rolls back with
the native PostgreSQL error. Cleanup restores the original catalog identities
and compares the committed rows with the case baseline.

Project retirement cases keep separate App, grant, and Project identities.
The retirement trigger raises its PostgreSQL exception, and state is read
back after rollback. The trigger and function are removed and checked in the
catalog before reuse. Each pre-canceled retirement case begins a new
transaction and uses fresh identifiers. The DAO call receives a canceled
context. The transaction is rolled back with a live context, the pool is
checked for reuse, and the fixture remains empty.

Work stop cases share one committed connection, coverage interval, and pending
request. The connection is unbound once before the unbound retirement cases.
Each case injects its catalog fault inside its own transaction and checks the
driver SQLSTATE and operation phase. After rollback, a fresh pool read checks
the committed rows and the original catalog identities. A failed fault case
stops fixture reuse.

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
retains the locked, cached token expiry. The
[GitHub Signal deadline test](../../../../packages/daynight-server/internal/core/store/postgres/github_webhook_integration_test.go)
warms the receiver and observer before starting the request deadline. It
observes the exact PostgreSQL blocker before timeout, checks the deadline
error and drains the connection while the holder is still locked. The large
search fixture keeps its complete description and constructs its expected
snippet independently.

[Direct Member](../../../../packages/daynight-server/internal/core/store/postgres/direct_member_scope_test.go),
[Registered Member](../../../../packages/daynight-server/internal/core/store/postgres/registered_member_scope_test.go),
and [Profile Patch](../../../../packages/daynight-server/internal/core/store/postgres/user_profile_mechanism_test.go)
use a short window based on the PostgreSQL clock after the holder takes the
target row lock and the waiter and observer connections are warm. The observer
identifies the intended SQL and its blocking backend while the credential is
valid. It waits with `pg_sleep_until` and verifies expiry on the database clock
before the holder commits. The Direct Member target-membership case also
observes a queued revocation and commits a compatible Session credential read
within the window. The eligibility and Profile Patch cases join the worker
before checking that the membership or profile changes were rolled back.

[AssistantTask credential expiry](../../../../packages/daynight-server/internal/core/store/postgres/assistanttask/concurrency_test.go)
uses the same PostgreSQL clock and connection preparation. The expiry update
commits before taking the Session row lock because the holder locks the same
row that stores the credential. The holder leaves that row unchanged. The
contender waits on the exact holder while the Session is still valid, and
its fresh read after natural expiry must reject the transaction.

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

The Microsoft Identity and Release Worker failure matrices each replay their
historical prefix once. Each case still executes the real target migration
and checks its SQLSTATE, affected state, and full ledger. The cases remove
only the injected row, field mutation, or trigger and function, then verify
restoration before the next case.

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
