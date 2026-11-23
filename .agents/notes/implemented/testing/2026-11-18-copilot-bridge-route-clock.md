# Agent Note: Copilot Bridge Route Clock

Status: implemented

## Problem

The compiled route-timeout integration test withholds a native response while
continuing to send text through the real bridge. Waiting for the full five
seconds costs 5.473 seconds in a
[hosted macOS sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999),
where this file was last to finish. The ordering across real IPC is the
integration proof; the deadline's exact boundary can be exercised separately.

## Decision

The [bridge fixture](../../../../packages/daynight/test/commands/controller/fixtures/copilot-bridge-check.mjs)
installs a preload for the timeout scenario. Only the compiled observer's
timer import in the bridge helper resolves to the controlled clock. The SDK,
transport, native fixture, and process cleanup retain their own clocks. The
clock asserts a 5,000 ms request and reports when it is armed. After the native
request and successful text acknowledgement, the parent confirms the route
read is still pending and releases the callback. A subsequent observation must
not start another native RPC, and text still works after timeout. The observer
tests explicitly distinguish 4,999 ms from the deadline at 5,000 ms.

## Alternatives

**Set a shorter real timeout.** The observer could time out before the actual
native request or concurrent text acknowledgement on a loaded runner.

**Replace bridge IPC with a stub or fake all timers in the helper.** This would
hide transport ordering, or let the test clock affect unrelated SDK deadlines.

## Consequences

The route case no longer consumes the production interval in wall time. It
still checks both processes and their real messages and cleanup. Production
uses the native Node timer with the same duration and cancellation behavior.
