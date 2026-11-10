# Agent Note: Group Task DAO Database Fixtures

Status: implemented

## Problem

Task DAO tests repeatedly initialize the complete PostgreSQL schema and close
its connections for independent cases that only change data. This catalog work
dominates package execution, even though the production transactions, queries
and assertions need only a known starting state. Some cases also replace tables,
install triggers or alter defaults, so sharing every mutable fixture would make
later failures depend on earlier catalog changes.

## Decision

Schema-stable Task DAO cases run in sequential subtests of a parent test for
their source file or shared responsibility. The parent owns one real Store,
schema and connection pool. Each original fixture boundary resets ordinary data
before the case executes; child cleanups finish before another reset. The parent
closes the Store and drops its schema after all children finish.

The package-local reset enumerates and qualifies ordinary tables once. It
preserves the migration ledger and the four snapshot seed tables, truncates
mutable tables without cascading, and restores every sequence's captured value
and `is_called`. Standalone sequences are included because truncating an owning
table cannot reset them. Reset errors and outstanding acquired connections stop
fixture reuse. Cases do not enter parallel scheduling.

Original scope callbacks, transaction commits, independent connection reads,
lock barriers and cancellation remain real. A reset commits before a case
starts; there is no enclosing rollback transaction that could replace committed
state or hide it from another connection. Independent loop branches retain
separate reset boundaries, while an intentional multi-step scenario keeps its
existing state progression.

Cases that change tables, views, columns, functions, triggers or defaults retain
independent schemas. Pure tests and explicitly tagged stress tests keep their
separate entry points. The existing
[root fixture decision](2026-11-08-postgres-test-preparation.md) continues to own
root-package management-pool reuse and bounded parallelism.

## Alternatives

**One schema per original fixture.** This avoids data reset but repeatedly
creates and drops the same catalog. Schema-stable groups can restore their
starting state while preserving the original production operations.

**One package-wide Store in TestMain.** This couples unrelated groups and pure
test selection to a database lifetime. Parent tests make resource ownership
explicit and initialize only selected groups.

**An outer rollback transaction for every case.** Production scopes acquire
their own connections and commit. A surrounding transaction cannot restore
their writes or replace independent persisted readback.

**Restore every catalog mutation for shared reuse.** Destructive cases would
need to recover relation identities, views, functions, triggers and defaults.
Keeping their existing independent fixtures preserves those proofs without a
general schema restoration mechanism.

## Consequences

Schema-stable groups perform less repeated catalog and connection work, at the
cost of a bounded data reset between independent cases. Reset owns all mutable
tables so related identity, ownership, Worker and attachment seed data cannot
leak between cases. Snapshot seed tables remain available, and nontransactional
sequence advancement is restored explicitly.

Destructive cases still pay for independent schemas. A failed case or unfinished
resource prevents reuse. Source-bound measurements and matched fault controls
determine realized savings and retained detection; grouping or a smaller schema
count alone does not establish a CI job improvement.
