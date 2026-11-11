# Agent Note: Group Session Store Database Fixtures

Status: implemented

## Problem

Session Store tests repeatedly initialize and discard the complete PostgreSQL
schema for independent cases that change only ordinary data. Schema creation and
cleanup dominate the package's preparation cost, while real commits, locks and
persisted readbacks still require independent case state. A prior instrumented
run measured a 28.34-second package median; snapshot execution and schema drop
accounted for 18.65 seconds of a diagnostic run. Those measurements describe
their original source and environment, not this implementation's net savings. Some cases mutate
catalog objects or exercise long-lived concurrent and process boundaries, so a
single reset strategy cannot safely replace all isolated fixtures.

## Decision

Three sequential parent tests own separate real Stores for schema-stable Session,
archive and image cases. Each selected child borrows the parent Store; a reset
occurs only between original fixture boundaries, preserving stateful subtests and
transaction order within a case. The parent checks connection and transaction
quiescence and the complete preserved seed contents after every child, including
the last. Failure stops reuse. No case enters parallel scheduling.

The reset truncates all 65 mutable tables together without cascading, including
both sides of the nine foreign keys. It retains and compares the full migration
ledger and four snapshot seed tables, and explicitly restores and reads back
all four sequences, including their `is_called` state. Sequence changes are not
transactional, so any reset or verification error ends the group. Child cleanup
finishes before the parent observes resources with its still-live context.
Rollback cleanup uses an independent deadline and reports unexpected errors.

Catalog mutations, complex concurrent lock and capacity cases, and the crash
recovery process retain independent fixtures. Their real transactions, gates,
process termination and persisted readbacks remain in their original matrices.
The [Task DAO fixture decision](2026-11-10-task-dao-group-fixtures.md) records a
similar decision for a separate test owner.

## Alternatives

**Keep one schema per case.** This avoids reset and shared-state checks, but
repeats the current snapshot and catalog cleanup for schema-stable cases.

**Share only the management pool.** Measurement showed management connection,
creation and closure totaled 1.46 seconds in the diagnostic run; this leaves
repeated schema initialization and deletion in place.

**Wrap each case in an outer rollback transaction.** Production operations use
independent connections and commit. An outer transaction cannot restore their
writes or prove the existing committed readbacks.

**Restore catalog changes for all cases.** Reconstructing altered objects and
coordinating independent lock and process lifetimes adds recovery risk; those
cases retain isolated Stores.

## Consequences

Sharing reduces repeated schema work while adding explicit reset and resource
observations. Five preserved tables must match their captured contents and all
sequences must match their captured state before reuse. An unfinished owner,
failed cleanup or drift prevents subsequent cases from running. Schema and seed
changes require the fixture's table and sequence inventory to be reconsidered.
The realized package cost includes reset, checks and final cleanup; fixture counts
alone do not establish a performance improvement or a hosted CI improvement.
