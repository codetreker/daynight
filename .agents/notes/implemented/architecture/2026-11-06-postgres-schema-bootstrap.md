# Agent Note: Atomic PostgreSQL Schema Bootstrap

Status: implemented

## Problem

An isolated empty database repeats the full migration history before it can
serve current operations. Each historical version creates or alters objects
and commits separately, even though no existing rows need transformation.
Initialization also shares a database-wide lock, so parallel isolated schemas
queue for that repeated work. Using a current schema without its system rows,
original migration checksums or atomic failure handling would leave an
installation that cannot operate or upgrade reliably.

## Decision

`postgres.Open` validates the embedded snapshot version and uses one pinned
connection under the existing migration advisory lock to inspect the target
namespace. Objects that depend on that namespace make it nonempty. This includes
tables, sequences, views, types, routines and other namespaced user objects;
absence of `schema_migrations` does not establish emptiness. Objects in other
schemas do not change the choice.

An empty namespace is initialized from the current snapshot in one Read
Committed transaction. Final definitions, all required initial data and the
complete ordered ledger are committed together. Ledger checksums use the same
migration checksum algorithm as upgrades, including migration 026's frozen
transformation source. Historical SQL and Go transforms are represented by their
resulting format and checksums, rather than executed during bootstrap. The
ledger's application timestamps record the initialization of that format.

Nonempty namespaces use the original ordered history and per-version
transactions. Previously committed migration prefixes remain committed if a
later version fails. Unknown versions, gaps and changed checksums still fail;
reopening current data does not rewrite it or its ledger timestamps. An invalid
snapshot version fails explicitly instead of selecting another initialization
path.

Explicit historical replay remains available to upgrade and rollback tests.
It shares connection acquisition, advisory locking and release with normal
initialization, so lock ownership is not nested or split between helpers.
Snapshot, initial-data, ledger and deferred commit failures roll back the whole
bootstrap. Lock-wait cancellation and initialization failures retain their
original errors and release owned resources; HTTP admission begins only after
initialization succeeds.

The [format snapshot decision](../testing/2026-11-06-postgres-schema-snapshot.md)
owns artifact generation and historical equivalence. The
[server guide](../../../../packages/daynight-server/README.md#schema-snapshot-maintenance)
owns current behavior and maintenance commands.

## Alternatives

**Replay every historical version for an empty namespace.** This remains valid
for upgrades, but repeats intermediate DDL and commits when there is no data to
transform. The final-format artifact already has independent equivalence proof.

**Treat a missing ledger as an empty database.** Existing objects can precede a
ledger, including a failed or manually prepared installation. Skipping history
there would change its failure and recovery behavior or collide with existing
objects.

**Initialize the snapshot and fill the ledger in separate transactions.** A
failure could publish current tables without complete initialization metadata,
or mark versions applied before required data exists. The database transaction
must own the entire transition.

**Change lock granularity or package concurrency at the same time.** That would
combine initialization correctness with another concurrency decision and make
performance attribution harder. The existing lock and runner policy remain
unchanged.

## Consequences

Empty installations and test schemas avoid historical replay while retaining
the same current objects, initial state and upgrade checksums. Existing data
keeps its migration and recovery path. Historical tests explicitly select
replay, so faster ordinary fixtures cannot silently remove upgrade coverage.

Every migration change also requires a current, independently verified snapshot.
The shared advisory lock still serializes initializing schemas; it coordinates
participating migrators, not arbitrary external database writers. Source-bound
measurements separate fixture improvements from whole-package and hosted CI
results.
