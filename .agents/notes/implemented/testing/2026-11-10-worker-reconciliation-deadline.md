# Agent Note: Observe Worker Reconciliation Before Advancing Its Deadline

Status: implemented

## Problem

Worker configuration reporting can start another reconciliation immediately
after a failed POST. Startup configuration application invalidates the inventory
and triggers the reporter independently of its periodic timer. Waiting for the
first failure diagnostic does not establish that the next GET has yet to start.

The stalled-GET test advanced time by 30 seconds before observing that request,
then checked that its signal remained live for another 9,999 ms. When startup
had already triggered the GET, the first advance expired its 10-second request
deadline. The later assertion inspected an already aborted signal. A controlled
startup ordering reproduced the Ubuntu failure without changing production code.

## Decision

The runtime fixture waits for coordinator creation, explicitly publishes an
inventory invalidation, and observes the first stalled reconciliation GET while
the controlled clock remains stationary. Only then does it advance the timer
and `node:perf_hooks` monotonic clock to the request's deadline boundaries.

The test retains the original request signal, requires it to remain live at
9,999 ms and abort at 10,000 ms, and checks the request-timeout classification.
A claim notification while the GET is pending queues the next reporting cycle;
its distinct signal must remain live after the first request expires. The real
reporter, Operation and API request deadline implementations remain in use.

The [development guide](../../../../docs/development.md#cli-test-fixtures) owns
fixture usage guidance. The [reporting design](../../../../docs/design/daynight-worker-reporting.md)
owns the independent periodic and inventory/claim triggers.

## Alternatives

**Use the periodic interval to start the reconciliation.** Startup can already
have requested another cycle. Advancing an entire interval then ages the wrong
request before the fixture establishes its start.

**Relax the pre-deadline assertion.** Accepting an already aborted request would
lose detection of premature cancellation and would not establish a 10-second
request allowance.

## Consequences

The deadline proof is independent of startup filesystem and configuration
scheduling. It preserves the exact timeout, merged trigger, subsequent request
and shutdown assertions without changing production behavior. Separate reporter
tests continue to own periodic cadence; this fixture proves the runtime wiring
and real API cancellation path.
