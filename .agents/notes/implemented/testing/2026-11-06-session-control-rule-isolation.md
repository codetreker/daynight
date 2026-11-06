# Agent Note: Session Control Rule Isolation

Status: implemented

## Problem

Control catalog and activity rules were tested by creating a PostgreSQL schema,
seeding a Worker and Task, registering and connecting a Session, then submitting
one command per matrix row. The authorization branch reads only the supplied
record, Task and command. Repeating storage setup adds work and makes rule
feedback depend on PostgreSQL, while the same package also contains distinct
storage, dispatch and authority regressions that need real integration.

## Decision

Catalog mismatch, unavailable activity and advertised-argument tests invoke
`authorizeCommand` with synthetic ordinary-Task facts. The fixture has a matching
active Web Worker, controller fence and controlled clock/last-seen state. It does
not use a Test Session shortcut: lazy Test Sessions allow a refresh condition
that ordinary Tasks reject. Accepted commands for all three control kinds
establish that the rejection matrix starts from valid admission facts.

The authorization branch needs no DAO result, so these cases require no mock
backend. Business rules that do need storage facts use narrow `core/store` DAO
interface mocks and verify expected access; unexpected calls fail. The
[server testing rules](../../../../docs/daynight-server.md#测试职责) own that
policy, including the distinction between pure functions and storage-dependent
rules.

The real outsider Submit witness has its own integration test. Durable operation
kinds, revision checks at offer and dispatch, and activity changes after offer
retain their PostgreSQL paths and observations. All original catalog, activity
and argument inputs remain covered. A direct function call does not replace
these cross-operation proofs.

The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns current usage. Rule-only selections execute without a database URL; the
ordinary module gate continues to run real integration tests.

## Alternatives

**Keep the full database fixture for every rule row.** It repeats format
initialization, seeding and Session admission without adding a different oracle
for the control branch. Integration witnesses already exercise the complete
Submit and dispatch paths.

**Mock PostgreSQL driver or SQL calls.** That couples business assertions to the
storage implementation. This branch performs no DAO calls; synthetic facts are
sufficient, and other rules can use the database-neutral DAO interfaces.

**Replace the surrounding Session integration suite.** That would remove real
transaction, persistence and late authority checks. Those tests remain distinct
from the isolated rule matrix.

## Consequences

The rule matrix no longer requires PostgreSQL or repeats its initialization.
The retained Submit witness still owns one real setup. Fixed admission facts
and positive commands keep rejection cases from passing because a fixture is
inactive, disconnected or using another Session kind.

New storage-dependent rules need explicit DAO mock expectations; mocks must not
return default empty results for unconfigured access. Source-bound fault probes
check that a representative rule violation is still rejected by both the
original and isolated matrix. Removing repeated fixtures improves local rule
feedback but does not by itself establish whole-job or hosted CI savings.
