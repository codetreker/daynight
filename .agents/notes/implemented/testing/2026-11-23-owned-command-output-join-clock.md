# Agent Note: Deliver owned command output join expiry after native closure

Status: implemented

## Problem

Four owned-command capture regressions hold the original output consumer until
cleanup times out. Waiting for the three-second operation budget adds fixed
runtime and can expire during native preparation, before the intended output
join boundary is reached. The regressions need to prove retained responsibility
and late capture errors on the original result.

## Decision

The [capture tests](../../../../packages/daynight/test/commands/worker/owned-command-capture.test.ts)
retain the real launcher, output streams, native stopping and lifecycle saves.
They capture the output join timer only after the original consumer is held,
the original launcher closes and native boundary closure is confirmed. The
shared synchronous deadline helper delivers that registered callback once,
with a real event-loop yield and cancellation checks.

The operation has an independent real thirty-second budget. The tests check
the output timer's actual remaining cleanup budget and its specific join error,
then verify unknown responsibility before releasing the original consumer.
Reconciliation preserves the same resource, lifecycle sequence and late error,
and records stopped only after joining that consumer. Native termination grace
and escalation tests continue to use real time.

## Alternatives

**Wait for the original operation deadline.** Native preparation consumes the
same short budget, so a loaded runner can test an earlier timeout phase. The
held consumer already establishes the decisive ordering.

**Advance a global fake clock.** Native processes, pipe closure and stopping
observations need real asynchronous progress. Advancing unrelated timers would
obscure which resources actually closed.

**Select timers by callback source or a duration threshold.** Callback text
couples fixtures to source formatting, and a remaining budget can legitimately
cross a threshold on a slower runner. Observed closure and consumer readiness
identify the registration boundary directly.

## Consequences

The four regressions remove their wall-clock expiry wait while retaining real
resource cleanup and the original error identity. Their savings in a parallel
CI job depend on the runner's schedule. The controlled timer does not prove
native TERM/KILL elapsed time; the existing native lifecycle tests own it.
