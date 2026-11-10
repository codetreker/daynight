# Agent Note: OAuth authenticator test boundary

Status: implemented

## Problem

The OAuth service authentication tests executed Core authentication rules while
controlling only the DAO. A failure could therefore conflate transaction
coordination with token admission or identity validation, and independently
supplied callback errors and transaction outcomes were not exercised.

## Decision

The authenticator binds its private authentication operation to Core in its
production constructor. Service tests control that operation and execute the
writer callback with a transaction-bound DAO capability. They independently
configure operation results, writer completion and final errors, and check
ordering, argument propagation and identity suppression. Core tests execute
authentication rules against a narrow controlled reader, including the original
context, token hash, resource, scope and UTC microsecond conversion.

## Alternatives

**Control only the DAO in service tests.** This exercises Core decisions in the
service suite and cannot separately supply operation and transaction outcomes.

## Consequences

The service tests prove coordination without claiming real commit or persistence;
Core owns the authentication decisions, and storage tests retain their separate
database responsibilities. The private function member adds an injection point
to the authenticator, while the public constructor and behavior remain unchanged.
No whole-suite speed improvement follows from this separation without measurement.
