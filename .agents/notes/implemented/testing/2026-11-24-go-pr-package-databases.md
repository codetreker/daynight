# Agent Note: Go PR Package Databases

Status: implemented

## Problem

Several PostgreSQL-backed packages continue running after the Store root package
finishes. Their independently created schemas still share a database-scoped
migration advisory lock, so concurrent fixture setup queues on the same lock.
The complete module check also shares CPU, storage and PostgreSQL resources,
which can limit the benefit of increasing package concurrency.

## Decision

The PR Go module job creates eight empty databases in its existing isolated
PostgreSQL service for the five heavy Store subpackages and three service
packages listed in the [server guide](../../../../packages/daynight-server/README.md#coverage).
The single coverage invocation supplies a Go `-exec` launcher to the actual Go
test command. The launcher selects the URL by exact package working directory;
a missing URL fails before launching the test. The test binary and its arguments,
streams, exit and signal behavior remain unchanged. Other packages use the
existing shared URL, and the Store root retains its own existing dedicated URL.
Nested Go commands do not inherit `-exec`. The job destroys its databases with
the service. Migration locks, database parameters, test selection, vet, coverage
and the [module throughput policy](2026-11-24-go-module-ci-throughput.md) remain
unchanged.

## Alternatives

**Keep all heavy packages in the shared database.** This keeps the test setup
simple but lets independent schemas serialize migration on the same lock.

**Change migration lock semantics.** Production binaries must coordinate schema
initialization across versions, and tests must retain the actual lock behavior.

**Split the suite into jobs or multiple Go invocations.** This changes the
single module gate and its complete coverage invocation.

## Consequences

Independent databases remove the shared database-level migration lock between
the selected packages, but still compete for CPU, WAL, I/O and memory within the
same service. The route relies on Go running test binaries from their package
working directories. Missing configured URLs fail; a missing physical database
also fails its real fixtures. The PR job owns database preparation and removal;
local, main and other job test commands retain their existing database behavior.
