# Agent Note: Session Load State Isolation

Status: implemented

## Problem

A Session load test created a bound Bot and deleted a PostgreSQL row to obtain
two DAO outcomes: a stored record with a mismatched binding and a missing record.
The behavior under test is the engine's treatment of live state and pending
content after loading. Real missing-row mapping and deletion barriers already
have separate database integration owners.

## Decision

Load-state unit tests use the existing Session DAO interface to supply a
complete stored Bot Session record or an explicit lookup result. The mock
checks context, Session ID and expected calls, and unexpected DAO access fails.
A matching Bot and record establish successful loading before refusal and
error outcomes are checked.

A binding mismatch returns the Session conflict while preserving valid cached
state. A missing record removes its live cell, cancels pending content with a
resource-conflict error and exposes no result. An operational DAO failure keeps
its original error chain and is not treated as proof that the Session is absent.
Operation lifetimes are closed on success and assertion failure so state and
content observations do not depend on a held engine operation.

Real DAO tests retain row deletion and `ErrNotFound` mapping. The missing-durable
Session barrier still deletes the actual row before checking cache invalidation;
Bot deletion, binding and revocation tests retain their storage boundary. The
unit mock does not replace these SQL or cross-operation proofs.

The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the common DAO policy. Load-state selections run without a PostgreSQL URL
and use domain records rather than a persistence simulator.

## Alternatives

**Keep the database fixture only to manufacture lookup outcomes.** It repeats
binding, format and identity setup even though the engine consumes a DAO result.
Dedicated backend tests already prove how a real missing row becomes that result.

**Return an empty record for every failure.** This would erase the distinction
between a binding mismatch, absence and an operational error, and could hide
incorrect cache or content invalidation. Each outcome is supplied explicitly.

**Replace the deletion integration tests as well.** That would remove the
actual SQL-to-error mapping and deletion barrier proofs. Those tests remain
unchanged.

## Consequences

State-loading rules can be exercised without PostgreSQL while directly
observing live-cell preservation, removal and pending replies. Mock arguments
and a valid success record make incorrect lookup wiring or invalid fixtures
visible. The real backend continues to own storage and transaction semantics.

Representative invalidation faults are checked against the original and
isolated tests through per-command overlays. Scoped timings describe unit
feedback; they do not establish whole-job or hosted CI savings.
