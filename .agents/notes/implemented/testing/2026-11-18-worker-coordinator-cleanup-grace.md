# Agent Note: Worker Coordinator Cleanup Grace Tests

Status: implemented

## Problem

The coordinator tests verify that cancellation cannot release the task gate
while the owned Git command still has an open stream or an unsettled child.
Each selected case waited for the full cleanup grace after reaching that
state. The duration adds latency to the suite even though the transition
depends on delivery of the deadline and the order of native close events.

## Decision

After the real process reaches the required state, capture the synchronous
cleanup deadline registered by cancellation. Assert that Git requests one
1,000 ms grace timer and deliver its callback across an event-loop turn.
Continue to observe the real pipes, process and command settlement before
checking that the coordinator releases the gate. Windows child and helper
cases use native timers because their taskkill path owns additional deadlines.

## Alternatives

**Use native time throughout.** This exercises the same ordering but repeats
a full second of waiting for each selected case.

**Control all timers in the test.** This would also affect process supervision
and fixture readiness, which must continue to observe native completion.

## Consequences

The selected cases can drive the grace expiry after the real readiness and
closure observations. Premature settlement still fails the pending-cleanup
assertion. The production interval and the cleanup deadlines for the Windows
child and helper cases retain their native behavior.
