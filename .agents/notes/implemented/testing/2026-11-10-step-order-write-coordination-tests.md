# Agent Note: Step Order Write Coordination Tests

Status: implemented

## Problem

Move and Delete service tests exercised Project authorization and collection
rules while checking transaction coordination. A failure in either lower-level
decision could obscure the service's own input, DAO and completion obligations.

## Decision

The shared Step write operations bind Project authorization and Move and Delete
admission per instance. Service tests control those decisions while exercising
the public methods, locked parent gate, real encoding, DAO calls, capture and
completion. Core tests execute the order and identity rules with the same facts;
PostgreSQL tests retain physical interval and persistence evidence. The
[content write decision](2026-11-10-step-content-write-coordination-tests.md)
owns the corresponding Add and Change boundary, and the earlier
[service ownership decision](2026-11-08-task-service-test-ownership.md) records
the DAO-based separation.

## Alternatives

**Control only the DAOs.** Project and collection decisions would remain coupled
to service coordination tests, making lower-level failures harder to locate.

**Replace the parent gate or encoded result.** This would hide version and
deletion precedence or the actual resource bytes and timestamps the service
must coordinate.

## Consequences

The tests distinguish a callback's proposed writes from independently observed
transaction completion. They do not prove physical commits or rollbacks; the
store tests retain that responsibility. Performance comparisons must include
the receiving Core packages under matching conditions and do not by themselves
establish a CI speedup.
