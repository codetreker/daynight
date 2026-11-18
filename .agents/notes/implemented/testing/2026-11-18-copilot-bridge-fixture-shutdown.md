# Agent Note: Copilot Bridge Fixture Shutdown

Status: implemented

## Problem

Several bridge scenarios testing route declaration or read authority also
incur the native process owner's 1,500 ms graceful exit allowance. Their
fixture acknowledges shutdown but leaves the socket listening. The
[hosted macOS sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
reported 2.373 and 2.326 seconds for those scenarios, versus 0.815 seconds for
the dedicated graceful shutdown case.

## Decision

The [bridge fixture](../../../../packages/daynight/test/commands/controller/fixtures/copilot-bridge-check.mjs)
configures the undeclared-route and read-authority scenarios to acknowledge and
exit using the same real socket shutdown as the graceful case. They verify one
shutdown request, both processes joined, and no signal-based exit. The
retained-reader scenario continues to acknowledge without exiting. Its native
child is observed receiving exactly one real SIGTERM request and joining, with
no second shutdown RPC. Its media ownership assertions remain unchanged.

## Alternatives

**Make every native fixture exit after acknowledgement.** This would lose the
real fallback proof when the acknowledgement arrives but the child remains.

**Shrink the production exit allowance or fake process closure.** The real
product timeout protects slow graceful exits; synthetic closure cannot prove
that the actual child and retained resources are reaped correctly.

## Consequences

Two scenarios avoid the incidental process-exit allowance, but still execute
the real SDK and transport and join both processes. The ordinary and fallback
shutdown paths remain independently observable with unchanged production timing.
