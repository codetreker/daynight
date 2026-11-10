# Agent Note: Task Service Test Ownership

Status: implemented

## Problem

Task service tests used complete PostgreSQL, identity, Team and Project fixtures
to obtain data for business decisions and coordination assertions. Those fixtures
repeated storage preparation and coupled rule feedback to database availability.
The same files also contained distinct SQL, snapshot, lock and rollback proofs,
so replacing their database dependency without separating those responsibilities
would lose meaningful defect detection.

## Decision

The original Task, Worker, Step, Thread, Graph and Sync correction assigned tests
by their observed behavior and removed database preparation from non-store
suites. It retained existing lower business paths over controlled `core/store`
DAO and scope interfaces, making storage facts and completion outcomes explicit
without introducing a second persistence implementation.

DAO-based Task fixtures configure individual query, write and scope callbacks,
verify their arguments and results, and fail explicitly on unconfigured access.
They do not interpret writes as persisted state. Read and project-bound write
interfaces retain their different signatures. The
[Task List direct-operation decision](2026-11-09-task-list-direct-operation-tests.md)
partially supersedes that DAO boundary for List coordination and moves the three
assignment selection functions to their Core owner. Shared platform and
agent-permission List fixtures retain their current scope.

Callback execution and transaction completion remain separate. Service tests
control `committed`, `not_committed` and `unknown` outcomes and retain original
causes, cancellation and cleanup failures. Cross-operation order is established
through the operation's calls or an explicit barrier, rather than a global
goroutine order. The service suite executes without a database URL.

PostgreSQL tests consolidate or rewrite the existing physical witnesses using
direct DAO and transaction scopes. They retain real query projections, fresh
reads after lock waits, database clocks, commit and rollback, partial-write
failures, Session and capture atomicity, and process-exit readback. They do not
invoke complete service flows to reproduce an upper-layer rule matrix. The
[PostgreSQL test ownership decision](2026-11-09-postgres-test-ownership.md)
places domain DAO proofs beside their implementations and retains root scope,
transaction and shared-snapshot witnesses. The
[test-writing rules](../../../../docs/writing_tests.md) own dependency isolation
and the separate normal-flow scope of API integration and product E2E tests.

Step write tests encode the fitting 170-description collection and overflowing
171-description candidate through the production 64 MiB codec, then verify Add
and Update reject before any write. The
[canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md)
removes Graph/Sync stored-size admission and their count-only matrices. Real
ordinary Store graphs retain selection, dependency arrays, snapshots and
cancellation; service mocks retain permission, projection and error chains. CLI
and Web acceptance tests read complete responses beyond the former node/edge
thresholds. Lock-window witnesses retain real PostgreSQL blockers and
observations beyond their test-local overlap.

The earlier [Task candidate isolation](2026-11-06-task-request-candidate-isolation.md)
and [matrix fixture reuse](2026-11-07-task-matrix-fixture-isolation.md) decisions
record why their original mixed suites retained database fixtures. Their current
ownership follows this split. [Graph fixture preparation](2026-11-06-task-graph-fixture-statistics.md)
and [Sync lock windows](2026-11-06-task-sync-lock-window.md) retain their native
mechanisms in store tests. The [fixture construction decision](2026-11-08-go-fixture-construction.md)
preserves the broader history of omitting data that a test does not observe.

## Alternatives

**Reuse the complete service database fixture.** Smaller isolation scopes can
reduce preparation, but business decisions would still depend on PostgreSQL and
repeat storage behavior outside its owner. Fixture reuse remains a storage-test
choice when the actual mutable owners and cleanup stay isolated.

**Move the service test files into store without changing their calls.** This
would preserve the full service orchestration dependency and its setup costs
under a different directory. Direct DAO witnesses make the physical guarantees
independent of the service rule matrices.

**Replace PostgreSQL with a stateful fake.** A fake that computes persistence,
graph reachability or transaction results duplicates production behavior and can
hide missing calls. Explicit expected outcomes expose the decisions being tested;
the real backend remains responsible for physical proof.

## Consequences

Rule and coordination feedback no longer prepares database state. Existing
physical assertions remain with their storage owner, and the original functional
inputs and failure boundaries remain exercised. The organization corrects
existing tests and preserves their product scenarios and coverage scope.

Mocks prove service decisions and interface use, not database durability. Store
tests prove physical behavior, not the complete business decision. Both layers
are needed to retain the original combined signal.

Runtime comparisons include the receiving store packages and the complete Go
check, with matching source, cache, race, coverage and resource conditions.
Source-bound validation owns measured results; a shorter service-package time
alone does not establish lower total cost or faster hosted CI.
