# Agent Note: Session Control Rule Isolation

Status: implemented

## Problem

Control catalog and activity rules were tested by creating a PostgreSQL schema,
seeding a Worker and Task, registering and connecting a Session, then submitting
one command per matrix row. The authorization branch reads only the supplied
record, Task and command. Repeating storage setup added work and made rule
feedback depend on PostgreSQL. The initial suite also contained distinct
storage, dispatch and authority observations that had to survive isolation.

## Decision

Catalog mismatch, unavailable activity and advertised-argument tests invoke
`authorizeCommand` with synthetic ordinary-Task facts. The fixture has a matching
active Web Worker, controller fence and controlled clock/last-seen state. It does
not use a Test Session shortcut: lazy Test Sessions allow a refresh condition
that ordinary Tasks reject. Accepted commands for all three control kinds
establish that the rejection matrix starts from valid admission facts.

The authorization branch needs no DAO result, so these cases require no mock
backend. Business rules that need stored facts use narrow `core/store` DAO
interface mocks and verify expected access; unexpected calls fail. The
[server testing rules](../../../../docs/daynight-server.md#测试职责) own that
policy, including the distinction between pure functions and storage-dependent
rules.

The initial split retained a real outsider Submit witness and PostgreSQL paths
for durable operations, offer/dispatch revision checks and activity changes.
Those witnesses kept their original cross-operation observations while the
catalog, activity and argument matrix was isolated.

The [complete Session isolation decision](2026-11-08-session-test-dao-mocks.md)
replaces that partial allocation. Session core tests now verify Submit,
operation and late-authority decisions through configured DAO facts and write
arguments. Store tests own the real SQL, locking and persistence observations.
The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns current usage: the complete Session suite runs without a database URL,
while the module gate still includes Store and API database tests.

## Alternatives

**Keep the full database fixture for every rule row.** It repeated format
initialization, seeding and Session admission without adding a different oracle
for the control branch. Existing integration witnesses exercised complete
Submit and dispatch paths during the initial split.

**Mock PostgreSQL driver or SQL calls.** That would couple business assertions
to the storage implementation. This branch performs no DAO calls; synthetic
facts are sufficient, and storage-dependent rules use neutral DAO interfaces.

**Replace the surrounding Session integration suite.** At the initial split,
removing it without allocating SQL and transaction observations elsewhere would
have lost distinct proofs. Complete isolation later separates those observations
into their implementation owners.

## Consequences

The rule matrix no longer initializes PostgreSQL. Fixed admission facts and
positive commands keep rejection cases from passing because a fixture is
inactive, disconnected or using another Session kind. The initially retained
Submit witness kept one real setup; that historical cost is not the current
Session test dependency.

New storage-dependent rules need explicit DAO mock expectations and must not
return default empty results for unconfigured access. Source-bound fault probes
check that a representative rule violation is rejected by both the original
and isolated matrix. Removing repeated fixtures improves local rule feedback
but does not by itself establish whole-job or hosted CI savings.
