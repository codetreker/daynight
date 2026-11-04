# Agent Note: Exercise native supervision with production budgets

Status: implemented

## Problem

The native process-tree fixture used a 300ms POSIX grace to shorten its signal
wait. That same supervisor option also sets the process-table command timeout,
so the fixture reduced the time available to launch real `ps` queries. Production
runtime factories use the existing five-second default. The integration test
needs realistic observation settings and a short controlled signal phase while
retaining actual native execution and stopping evidence.

## Decision

POSIX native-tree fixtures use the production-default supervisor. Windows keeps
its existing 3000ms setting. The cooperative TERM case exits naturally. Only the
fixture that ignores TERM controls the parent process's `Date.now`: it captures
the original clock, waits for a child-written TERM receipt, and retains at least
300ms of real observation using a monotonic clock and real timers. The wrapper
must remain alive before the parent clock offset advances through the default
grace threshold, allowing the existing KILL escalation to proceed.

Native `ps`, signals, child clocks, heartbeat, stream closure and exclusion remain
real. A delayed-first-query proxy forwards the original arguments to actual `ps`
before TERM; a negative fixture restores the old 300ms configuration and must
fail with a native command timeout. An actual failed inspection preserves its
cause and unsafe/exclusion behavior. Production code and release inputs remain
unchanged.

A stop rejection is handled immediately and propagates through the marker wait;
marker polling cannot outlive a failed test. Cleanup independently terminates
only the recorded owned group when needed, waits for the pending stop and the
pre-registered close promise to settle, and then restores the clock and PATH.
Successful native stopping must retain heartbeat and closure proof without
redundantly signaling a proven stopped Darwin group.

The [development guide](../../../../docs/development.md#cli-development) owns the
validation commands. The [review design](../../../../docs/design/daynight-review.md)
owns unchanged production process and lock behavior.

## Alternatives

**Separate inspection timeout in production.** This would give short-grace
callers a different observation policy. Runtime factories already use the correct
default; the demonstrated failure comes from fixture configuration. Test-only
phase control repairs the evidence without changing the runtime option semantics.

**Increase the fixture grace and wait for it in real time.** That restores a
realistic inspection budget but adds a five-second wait to the TERM-ignore case.
The parent clock controls that phase after the original real observation window.

**Mock process tables or complete stopping immediately.** That removes native
configuration, descendant, signal and stream-closure evidence and cannot qualify
the production settings.

## Consequences

The fixture no longer truncates native queries to its accelerated signal phase.
It preserves real TERM observation, KILL escalation and resource disappearance.
This integration test does not claim to sleep for the complete default grace or
to measure a hard total stop deadline. A changed production default requires the
fixture's clock and native qualification to be reassessed together.
