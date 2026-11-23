# Agent Note: Keep execution running with unconfirmed command closure

Status: implemented

## Problem

An owned command can return an error while its process boundary still needs
reconciliation. Promoting that uncertainty to scope cancellation interrupts
healthy Task sessions and shuts down unrelated producers. The former
[ordinary closure fixture](../../archived/testing/2026-11-21-worker-ordinary-closure-observation.md)
covered that shutdown policy and its timing.

## Decision

The lifecycle sink saves an unknown resource under its original reservation.
The owning operation receives its error. An owner rejection carrying a command
cleanup failure retains its diagnostics and leaves other producers running.
Git starts a bounded reconciliation of its original command when its outcome
reports pending cleanup. A mutation still waits for that same command to close.
The [execution scope decision](../architecture/2026-11-20-worker-execution-scopes.md)
owns the complete stop and rebuild conditions.

## Alternatives

**Cancel the scope when any command's close is unknown.** This invokes useful
reconciliation at the cost of stopping every live Task. The original Git handle
can attempt the same reconciliation without cancelling other work.

**Exempt only telemetry.** The reporting probe already prevents replacement
while closure is uncertain. The same unknown-to-stop path in other owners would
still interrupt healthy Tasks. The resource ledger already retains those
owners' original process evidence.

## Consequences

Healthy Task reconciliation continues while the original command remains
unresolved. An unavailable original closure proof keeps that operation
pending. Explicit stop and replacement still require verified boundaries and
durable closure. A journal write failure retains the existing admission guard.
