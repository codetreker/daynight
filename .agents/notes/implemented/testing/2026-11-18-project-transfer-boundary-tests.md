# Agent Note: Project Transfer Boundary Tests

Status: implemented

## Problem

The Project transfer validation, cancellation, and version-limit tests created
new schemas and seeded owners and teams. Several scenarios refuse a request
before storage or use stored facts to exercise a deterministic Core decision.

## Decision

Service tests check validation with a fail-on-access store and inject the
original cancellation cause at the appropriate snapshot or project write
entry. A missing project fails before the write callback. The missing-team
and version-limit cases execute the real transfer callback and Core decisions
with explicit scoped facts. A same-team save at the version limit still reads the current actor, refreshes
eligibility, observes confirmed transaction completion, and returns a receipt.

PostgreSQL tests keep real ownership changes, grant and invitation continuity,
and access after transfer. Actual lock waits, cancellation without late
writes, and storage failure with independent readback remain in their
physical test scopes.

## Alternatives

**Create a schema for every preflight and version case.** It supplies real
facts but repeats setup for cases that validate before queries or do not move
ownership.

**Stub the whole transfer operation.** That would remove the distinction
between a rejecting transfer at the version limit and a confirmed save to the
current team, including the latter's eligibility refresh.

## Consequences

The selected transfer cases run without PostgreSQL. Real SQL and transaction
behavior still have separate tests, while the Service tests check how the
actual callback handles the supplied facts and completion.
