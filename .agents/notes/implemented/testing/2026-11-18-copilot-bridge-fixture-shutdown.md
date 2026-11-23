# Agent Note: Copilot Bridge Fixture Shutdown

Status: implemented

## Problem

The bridge fixture covers both graceful native exit and escalation after a
shutdown acknowledgement. Route declaration and read authority scenarios
also incurred the native process owner's 1,500 ms graceful exit allowance
when their fixture acknowledged shutdown and left the socket listening. The
[hosted macOS sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
reported 2.373 and 2.326 seconds for those scenarios versus 0.815 seconds for
the dedicated graceful shutdown case. The retained-reader scenario requires
the acknowledgement followed by escalation, so it incurs the same interval
even once the helper has joined and the native child is known to be alive.

## Decision

The [bridge fixture](../../../../packages/daynight/test/commands/controller/fixtures/copilot-bridge-check.mjs)
configures the undeclared-route and read-authority scenarios to acknowledge
and exit through the real socket shutdown. They verify one shutdown request,
both processes joined, and a signal-free exit.

The retained-reader scenario acknowledges shutdown and keeps its native child
alive. During close, the fixture captures the 1,500 ms callback after the SDK
helper exits successfully. It yields to the real event loop and checks that
the child remains live and signal-free before releasing the callback. It
then observes exactly one real SIGTERM request, both processes joined, and
the reader's media lease retained until release. The
[production exit allowance](../bug-fix/2026-11-11-copilot-graceful-native-exit.md)
applies to actual runtime shutdowns.

## Alternatives

**Make every native fixture exit after acknowledgement.** The fallback case
would lose the proof that a lingering child is signaled and joined.

**Shrink the production exit allowance or fake process closure.** The
production interval protects slow graceful exits. Synthetic closure cannot
establish that the real process and its resources are reaped correctly.

## Consequences

The retained-reader case skips the wall-clock wait for the allowance while
checking the actual shutdown request, escalation, process closure, and media
lifetime. The other scenarios continue to use native timing for shutdown.
