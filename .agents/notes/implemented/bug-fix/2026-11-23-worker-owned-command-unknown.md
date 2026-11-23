# Agent Note: Isolate telemetry commands with unconfirmed closure

Status: implemented

## Problem

An owned command can return an error while its process boundary still needs
reconciliation. A telemetry command in this state cancelled the entire Worker
execution scope, interrupting otherwise healthy Task sessions.

## Decision

Commands started by the telemetry collector use the same lifecycle journal
and resource ledger as the Worker. The collector receives the error and holds
its original command until the boundary is confirmed. The active execution
scope remains open and retains the reservation and available process proof. The [execution scope decision](../architecture/2026-11-20-worker-execution-scopes.md)
owns the complete stop and rebuild conditions.

## Alternatives

**Cancel the scope on an unknown telemetry command boundary.** This starts a global stop
for a resource already recorded under its original identity. Every live Task
receives cancellation even though the command's incomplete proof concerns its
own boundary.

**Keep execution open for every unknown command.** Repository mutations can
still need the Worker-wide gate while their original effects are unresolved.
Telemetry collectors already prevent replacement of an unconfirmed probe.

## Consequences

Healthy Tasks and Worker polling can continue while the command's responsibility
remains unresolved. Explicit stop still requires the original closure evidence
and a durable save, and a replacement scope waits for complete closure.
Active reporting keeps the affected probe unavailable while the original
boundary is unresolved. The existing journal reconciler runs as part of
stopping or rebuilding the scope.
