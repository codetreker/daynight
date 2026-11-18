# Agent Note: Session Scope Failure Tests

Status: implemented

## Problem

The Session error matrix initialized PostgreSQL and registered sessions solely
to reach injected query failures. The dispatch authorization matrix also
prepared a stored identity, task and worker to check deterministic
authorization outcomes.

## Decision

Controlled transaction scopes provide explicit registration, credential,
session and project facts. The Service tests execute real entry points and
verify the complete sequence up to a failing query. The transaction reports
its outcome separately from the callback. Dispatch tests execute real
credential and ownership checks against the supplied facts.

Database tests retain physical registration and connection behavior, durable
state across restarts, actual revocation, and concurrency at the Store
boundary.

## Alternatives

**Keep the database for each error matrix.** It supplies valid starting facts
but repeats registration and persistence unrelated to the injected failure.

**Return prepared errors from a substituted Service.** That would skip
transaction binding and the early-stop behavior the tests verify.

## Consequences

The selected matrices run without PostgreSQL. Controlled facts describe the
inputs to the actual Service and Core code, while the existing database tests
establish which facts physical storage provides.
