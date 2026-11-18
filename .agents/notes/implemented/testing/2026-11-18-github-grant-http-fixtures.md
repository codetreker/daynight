# Agent Note: GitHub App Grant HTTP Fixtures

Status: implemented

## Problem

The GitHub App grant HTTP tests prepare PostgreSQL separately for five
scenarios that exercise real routes, GrantManager and Store operations.
The storage-error case also opens PostgreSQL even though its grant reader
supplies all errors and its request never reads App impact. Repeated setup
adds cost to grant state already scoped by App, grant, Team and caller.

## Decision

`TestGrantAdapterPostgres` owns one isolated PostgreSQL schema and pool. Its
five sequential scenarios each bind a bounded context, independent actor and
fresh App, Team and grant IDs. They use distinct external GitHub App IDs
because the live external ID index applies across the schema.

The grant lifecycle and personal-owner JSON cases keep their real routes,
reads, writes and access checks. Each Team removal case still intercepts
the write after grant location, changes the persisted Team and grant facts,
then delegates to the real Store. The Manager still performs its real
missing-root reconciliation and conflict mapping. The input and result
assertions stay with the same scenarios.

The storage-error test retains the real Manager and route adapter while
injecting the failed grant read. The Manager receives no impact Store in
this case because the detail route requires only the grant read. The HTTP
response still distinguishes a plain deadline, a database failure and an
unconfirmed cleanup operation.

## Alternatives

**Use separate schemas for every physical scenario.** This repeats setup for
independently scoped Apps, Teams and grants. Scenario-owned rows and unique
external IDs provide the separation required for these cases.

**Replace physical grant writes with supplied results.** That would remove the
real Team-root failure and subsequent persisted grant read relied on by the
reconciliation case.

## Consequences

The selected tests need one PostgreSQL fixture for the five physical cases.
The independent storage-error test needs no database fixture. Each physical
case remains selectable as a subtest, and parent teardown owns the shared pool
and schema.
