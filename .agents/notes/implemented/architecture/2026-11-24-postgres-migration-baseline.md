# Agent Note: PostgreSQL Migration Baseline at 099

Status: implemented

## Problem

The PostgreSQL upgrade path grew to include 97 migrations before version 100,
including DDL for retired objects and Go transformations for superseded formats.
An empty installation already initializes from the current snapshot. The
prefix still expands the production registry and forces routine snapshot
verification to recreate all intermediate formats.

## Decision

The executable chain begins at 100. A version 099 SQL baseline supplies the
objects, initial rows and sequences for test replay and snapshot maintenance.
It comes from the
[original 099 snapshot](https://github.com/codetreker/daynight/blob/2060f6d2059055f2abcc2086ceebed81752a7982/packages/daynight-server/internal/core/store/postgres/schema/current.sql).
The frozen manifest retains all original version and checksum pairs through 099,
including Go transforms and the published numbering gaps.

Startup still uses the current snapshot for a genuinely empty schema and
stamps the same complete ledger. Upgrading a nonempty schema requires a
valid ledger through 099. Existing entries, checksums and timestamps survive
as pending tail migrations commit. The read-only storage tools check the
same ledger. Older prefixes use the pinned 099 build and its original
migrations before cutover. Missing metadata in a nonempty namespace requires
diagnosis before that procedure. The [server guide](../../../../packages/daynight-server/README.md#upgrading-databases-older-than-099)
owns recovery and operating steps.

This decision updates the upgrade path described by the
[bootstrap](2026-11-06-postgres-schema-bootstrap.md),
[ownership](2026-11-05-server-postgres-ownership.md) and
[snapshot](../testing/2026-11-06-postgres-schema-snapshot.md) decisions.

## Alternatives

**Compress the database ledger into one row.** This would require rewriting
existing databases and coordinating older builds that validate the original
ordered rows. A metadata manifest removes the executable history without
altering the installed ledger or breaking same-head rollback.

**Keep the runnable prefix for direct upgrades from every historical version.**
The fixed 099 source already contains the original transforms and recovery
procedures. Keeping that bounded upgrade route preserves the old-data path
without embedding it in each later build.

## Consequences

The baseline is a format for independent test replay and snapshot generation.
Applying it to populated data would skip historical transformations, which
remain owned by the original runner. Same-head binary rollback preserves ledger
compatibility. Normal rollback restrictions still apply across later migrations
with incompatible storage. The next baseline rotation requires an equivalent
catalog, initial data and sequence state, plus the same original checksums.
