# Agent Note: Session Load State Isolation

Status: implemented

## Problem

A Session load test created a bound Bot and deleted a PostgreSQL row to obtain
two DAO outcomes: a stored record with a mismatched binding and a missing record.
The behavior under test is the engine's treatment of live state and pending
content after loading. Real missing-row mapping and deletion barriers already
had separate database integration owners.

## Decision

Load-state unit tests use the Session DAO interface to supply a complete stored
Bot Session record or an explicit lookup result. The mock checks context,
Session ID and expected calls, and unexpected DAO access fails. A matching Bot
and record establish successful loading before refusal and error outcomes.

A binding mismatch returns the Session conflict while preserving valid cached
state. A missing record removes its live cell, cancels pending content with a
resource-conflict error and exposes no result. An operational DAO failure keeps
its original error chain and is not treated as proof that the Session is absent.
Operation lifetimes are closed on success and assertion failure so state and
content observations do not depend on a held engine operation.

The initial conversion retained an actual-row deletion barrier and surrounding
Bot deletion, binding and revocation database tests. That kept their SQL-to-error
and cross-operation observations distinct from the isolated load rules.

The [complete Session isolation decision](2026-11-08-session-test-dao-mocks.md)
replaces this partial split. Session-owned deletion barriers and invalidation
use DAO outcomes and callback coordination; Store tests retain row deletion,
missing-row mapping and real transaction observations. The
[test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the complete database-independent suite and its mock policy.

## Alternatives

**Keep a database fixture to manufacture lookup outcomes.** It repeated binding,
format and identity setup although the engine consumes a DAO result. Dedicated
backend tests prove how a real missing row becomes that result.

**Return an empty record for every failure.** This would erase the distinction
between a binding mismatch, absence and an operational error, and could hide
incorrect cache or content invalidation. Each outcome is supplied explicitly.

**Replace the deletion integration tests as well.** During the initial load
conversion, removing them without allocating their database observations
elsewhere would have lost real SQL-to-error mapping and deletion proofs.
Complete isolation subsequently assigns them to their Store and service owners.

## Consequences

State-loading rules execute without PostgreSQL and directly observe live-cell
preservation, removal and pending replies. Mock arguments and a valid success
record make incorrect lookup wiring or invalid fixtures visible. The backend
owns storage and transaction semantics; its green tests do not replace Session
state and cancellation checks.

Representative invalidation faults are checked against original and isolated
tests through source-bound overlays. Scoped timings describe unit feedback;
they do not establish whole-job or hosted CI savings.
