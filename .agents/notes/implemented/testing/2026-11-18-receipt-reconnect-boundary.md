# Agent Note: Observe Startup Before Receipt Reconnection

Status: implemented

## Problem

The Controller receipt reconciliation test intentionally disconnects after the
server receives an operation receipt. That receipt can precede completion of the
first heartbeat's asynchronous credential read. A closing socket can then cause
the heartbeat to report an offline send while the test is checking reconciliation.
The fixture does not establish which operation completes first.

## Decision

The receipt scenario observes the first heartbeat at its real WebSocket server
before initiating disconnection. It retains the exact receipt count, operation
identity, reconnection reconciliation and empty error assertions. The observation
provides a concrete startup completion boundary without a fixed sleep.

## Alternatives

**Retry until the original schedule passes.** This leaves the undefined ordering
and cannot explain the original failure.

**Ignore offline errors.** This would hide failures during the actual receipt and
reconciliation phases.

**Repair heartbeat transport lifetime in the receipt fixture.** Production socket
and credential-read cancellation need their own deterministic relay tests. Changing
that behavior is separate from defining this scenario's startup precondition.

## Consequences

The test proves receipt reconciliation after completed startup. It does not prove
that disconnection during asynchronous heartbeat credential loading is free of
errors; that existing transport race remains a distinct limitation. Full transport
lifetime acceptance must cover the closing socket and pending credential read
directly, rather than relying on this test's incidental scheduling.
