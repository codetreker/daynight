# Agent Note: PostgreSQL Test Ownership

Status: implemented

## Problem

PostgreSQL implementation tests mixed domain DAO assertions with root scope,
transaction and migration proofs. Tests of a child DAO often remained beside
root fixtures after the implementation moved into domain subpackages. Small
witness files repeated setup, and some suites tested business decisions through
real storage. Moving a complete mixed file could lose shared-transaction or
resource-lifetime detection; leaving the file unchanged obscured the actual
owner of a failed assertion.

The [Task service ownership](2026-11-08-task-service-test-ownership.md) and
[Session DAO mock](2026-11-08-session-test-dao-mocks.md) decisions separated
business and database mechanisms. Their real storage witnesses remain needed;
this decision organizes those witnesses inside the implementation tree.

## Decision

Tests follow the implementation that owns their independent guarantee. Domain
DAO packages own SQL projection, mapping, constraints and their locking
mechanisms. The PostgreSQL root owns connection setup, migration, scope
construction, transaction completion, shared snapshots and cross-DAO atomicity.
A root fixture or scope used to reach a DAO does not determine ownership.
Database-independent interface capabilities and pure error contracts remain in
`core/store`; core and service business decisions use their required mocks.
The [canonical resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md)
owns current read/write semantics; test ownership follows those contracts.

Mixed files retain actual root mechanisms and move independent DAO or business
matrices to their owners. Necessary data assertions inside a root rollback,
snapshot or migration proof remain with that proof. Real pool-exhaustion,
connection-release and lost-commit-reply witnesses retain physical observations;
a supplied mock outcome cannot replace them. Equal test names are insufficient
to remove a duplicate: distinct inputs and assertions must remain executed.

Attachment metadata upsert, readback and deletion have one canonical scenario
in the attachment implementation tests. It invokes the public `Store` write
entry points and snapshot reader, preserving their delegation coverage together
with exact identity fields, content-type updates, timestamp/creation semantics,
keyset pages, path conflicts and missing-row refusals. The root retains the
independent mutation callback, transaction completion, lifecycle and shared
snapshot proofs. Repeating metadata CRUD through those same public methods in
the root adds no separate binding or persistence guarantee.

Small files are grouped by a common owner and mechanism, such as query
contracts, mutation constraints, operation receipts, scope completion or
historical upgrades. Grouping preserves fault conditions, build tags, barriers,
cleanup and all unique assertions. Stress workloads keep an explicit independent
entry and do not enter ordinary test discovery.

`postgres/testdata/testutil` provides canonical domain data, historical fixture
seeding and database observations. Helpers receive existing store interfaces
and explicit pools. Backend factories are supplied by consuming tests, avoiding
a root implementation import cycle. Current Project fixture creation invokes
the existing core operation; historical fixtures still write the source schema
needed by migration tests. Helpers do not clone business policy or infer
persisted state from mock writes. The
[preparation decision](2026-11-08-postgres-test-preparation.md) continues to own
schema, operational-pool and borrowed management-pool lifetimes.

The [test-writing policy](../../../../docs/writing_tests.md) owns dependency
restrictions and proof-preserving migration conditions. The
[server guide](../../../../packages/daynight-server/README.md) owns validation
commands and actual package discovery.

## Alternatives

**Keep duplicate public attachment CRUD scenarios in root and child suites.**
Both exercise the same Store writer delegation and snapshot reader. Keeping one
canonical scenario preserves those calls and their distinct assertions while
avoiding another full schema; transaction, cancellation and lifecycle scenarios
retain their separate owners.

**Move every root test to a domain directory.** Root scopes bind several DAOs
and own commit, cleanup and snapshot behavior. A domain-only test cannot replace
those shared guarantees, and migration tests need root history and initialization
mechanisms.

**Copy root fixture implementations into each receiving package.** This avoids
an immediate import cycle but duplicates policy, SQL setup and resource cleanup.
Interface-based shared helpers keep one fixture definition without importing the
implementation root.

**Move files without separating their business calls.** Executing core or
service rule matrices through PostgreSQL under a child directory still depends
on storage outside the rule being tested. Independent rule tests require explicit
mock facts; their SQL and persistence witnesses remain real DAO tests.

## Consequences

Failed tests identify the responsible contract or implementation more directly.
Shared fixtures keep setup coherent across root and child packages without
coupling operational pools or mutable schemas. Consolidation reduces file
fragmentation while preserving separate root and domain guarantees.

Receiving test packages must actually compile, be discovered and execute before
old locations can be removed. File counts and successful coverage alone do not
prove preservation. Physical database tests still need an isolated PostgreSQL
instance, and database-independent tests must execute without its configuration.
These responsibilities retain the existing race, coverage and cleanup gates.
