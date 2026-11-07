# Agent Note: Reuse Isolated Task Test Fixtures

Status: implemented

## Problem

Cancellation and dependency protection matrices repeatedly initialize and drop a
complete PostgreSQL schema even though their cases can be isolated at a smaller
scope. The tests must still exercise real transactions, cancellation causes,
rollback, dependency protection and persisted task state.

## Decision

The status cancellation matrix creates one fixture per transition and runs its
cancellation positions sequentially against the same task graph. Each position
owns its context and traced pool and checks both tasks against their complete
pre-operation state. A failed position stops the remaining positions for that
transition so a damaged graph cannot contaminate later observations.

The dependency protection matrix shares one schema and principal, but creates a
separate project and task graph for every combination. Its twelve combinations
retain their original status and dependency assertions.

## Alternatives

**Keep a schema per case.** This provides isolation but repeats full schema
initialization and cleanup for every row, although the tests do not alter the
schema itself.

**Share a task graph across dependency rows.** Status transitions and dependency
writes would carry state across rows, so independent projects retain the original
case boundaries without needing another schema.

## Consequences

The cancellation matrix initializes three schemas and the dependency matrix one,
instead of nine and twelve respectively. A shared fixture is appropriate only
while each cancellation proves rollback and each dependency row owns its project;
other tests that mutate schema or share mutable state still require their own
isolation. These changes do not establish a general fixture pooling policy.
