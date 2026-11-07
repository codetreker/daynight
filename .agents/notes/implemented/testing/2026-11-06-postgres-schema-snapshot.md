# Agent Note: PostgreSQL Format Snapshot

Status: implemented

## Problem

A complete migration history describes how a database reaches its current
format, but does not directly describe the final objects and initial state.
Repeatedly deriving that state also executes historical schema transformations
and commits. A separately maintained current schema can drift from upgrades,
omit system rows, or accidentally encode the schema used to generate it.

## Decision

The PostgreSQL package keeps a final-format SQL snapshot and a version anchor.
Its explicit maintenance command derives the snapshot from the complete
historical migration path with PostgreSQL 18 `pg_dump`. It captures final
schema definitions, all initial non-ledger table data and sequence state.
The artifact includes the migration-ledger table structure but no historical
application timestamps. The equivalence test checks the artifact independently
of runtime initialization. The [bootstrap decision](../architecture/2026-11-06-postgres-schema-bootstrap.md)
owns its use for atomic initialization of an empty target namespace; existing
namespaces retain historical migration replay.

Ordinary validation builds independent historical and snapshot schemas and
compares their actual catalogs and initial data. It preserves visible column
order, types, defaults, nullability, constraints, indexes, sequence ownership
and state, and the routines, views and triggers present in the format. Database
instance identifiers and generated schema qualification may differ; SQL literal
values and behavior-bearing definitions must remain distinguishable. The
version anchor must match the latest migration, including migrations that
only change initial data.

Required system rows are part of the database format. The transfer ledger and
both OAuth cleanup cursors are captured together with any future initial rows;
validation must not silently restrict its data comparison to a fixed table
allowlist. Historical SQL and the frozen migration 026 transform retain their
original bytes and checksum semantics.

Migration-specific tests bind their before/after history to the transformation's
fixed version. Their rollback failure is injected while that version is still
pending, and a repaired database can subsequently replay the complete history.
The current tail does not redefine a historical test's starting point.

The [server maintenance guide](../../../../packages/daynight-server/README.md#schema-snapshot-maintenance)
owns regeneration and routine verification commands. Regeneration is explicit;
CI verifies the committed artifact without needing a dump executable or writing
source files.

## Alternatives

**Keep only the historical chain.** It remains the authority for upgrades but
requires replay to derive the final format and offers no independently checked
current-format artifact.

**Concatenate migration SQL.** This retains obsolete tables, alterations and
intermediate operations rather than expressing the final format. Historical
Go transformations also cannot be represented by concatenating SQL files.

**Use a schema-only dump.** It omits system ledger and cleanup-cursor rows whose
presence is required by normal operations, as well as initial sequence state.

**Require dump output comparison in every test run.** That couples ordinary
validation to an installed matching PostgreSQL client and its serialization.
Catalog and data comparison checks actual database behavior while keeping the
dump client an explicit maintenance dependency.

**Use the latest migration minus one as every historical test's prefix.**
Adding another migration would apply the tested transformation before its
failure trigger is installed, removing the rollback proof without changing the
test's stated purpose. A fixed-version prefix keeps that proof valid.

## Consequences

Every migration change also requires a regenerated, equivalent snapshot.
Catalog and initial-data comparisons detect omitted objects and seed rows
without replacing historical upgrade, backfill, rollback or lock tests. The
snapshot can initialize an independently scoped schema without embedding a
particular installation's namespace.

The artifact and its validation add maintenance and test work. The snapshot
was introduced with independent equivalence proof before runtime adoption.
Source-bound measurements own performance claims; catalog equivalence alone
does not establish a CI speedup. Runtime atomicity and concurrent startup are
specified by the separate bootstrap decision.
