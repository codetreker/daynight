# Agent Note: Worker archive maintenance ownership

Status: implemented

## Problem

A historical Web archive upload can remain pending while the Worker has other
normal scheduling work to perform. Awaiting it in the reconciliation round delays
that work, while abandoning the upload during shutdown can close its stores
before its finalizer has finished.

## Decision

The Web runtime owns one cancellable historical archive maintenance task. Each
normal round requests at most one attempt without awaiting it; repeated requests
while it is running are coalesced. [Cleanup priority](../bug-fix/2026-11-11-worker-archive-priority.md)
gates both the request and actual attempt start without cancelling running work.
The existing per-execution rotation, retry and
source protection remain in the attempt. Completion does not wake the scheduler.
Shutdown cancels and joins the maintenance task before publishing the stopped
state and closing stores. Scan failures have a Worker-scoped archive owner;
per-execution failures retain their original claim scope.

## Alternatives

**Await each upload in the reconciliation round.** This preserves serial access
but makes unrelated scheduling wait for a potentially slow archive.

**Detach uploads without joining them.** This allows progress but loses ownership
of their finalizers and can close resources while they are still in use.

## Consequences

Normal polling or configuration changes initiate future attempts; idle or
backed-off maintenance does not create a busy loop. Cancellation remains
cooperative, so shutdown waits for an unresponsive operation rather than claiming
its resources have closed. The separate [execution-capacity policy](2026-11-11-worker-execution-capacity.md) releases stopped executions independently of retained archive work.
