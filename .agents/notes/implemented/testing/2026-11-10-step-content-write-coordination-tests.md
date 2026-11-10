# Agent Note: Step Content Write Coordination Tests

Status: implemented

## Problem

Step Add and content/status change service tests controlled DAO access but ran
Project authorization and Step collection decisions. This mixed responsibilities
and made service coordination evidence depend on unrelated business decisions.

## Decision

`NewTaskSteps` binds Project write authorization and Step Add and Change
admission per instance. Service tests control those operations while executing
the public methods, locked parent lookup and version gate, DAO calls, real
encoding, capture and transaction completion. Core tests execute the collection
rules with the same inputs, including refusal precedence, no-op, text limits
and preservation of rows and timestamps. The [earlier Task service test
decision](2026-11-08-task-service-test-ownership.md) retains the history of the
DAO boundary; the [Step read decision](2026-11-10-step-read-coordination-tests.md)
owns the separate read boundary. The [Step order write decision](2026-11-10-step-order-write-coordination-tests.md)
extends the shared write operations to Move and Delete.

## Alternatives

**Control only the DAOs.** Project and Step business rules would still execute
inside service coordination tests, coupling failures to lower-level decisions.

**Replace the whole write helper or encoded document.** This would conceal the
locked parent gate, real byte and timestamp generation, and completion handling
that the service is responsible for coordinating.

## Consequences

The service tests verify the use of one transaction scope and distinguish
callback results from independently controlled completion. They do not prove a
physical database commit or rollback; store tests retain those guarantees.
Core owns the admitted collection and error rules. Comparing execution costs
requires matching resources and measuring receiving packages as well as service;
the isolation does not itself establish a CI speedup.
