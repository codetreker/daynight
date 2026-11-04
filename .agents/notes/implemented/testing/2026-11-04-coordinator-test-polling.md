# Agent Note: Control polling cadence in coordinator tests

Status: implemented

## Problem

Controller and Worker lifecycle tests already control remote observations and
native-resource state through fixtures, but each observation still pays the
production polling delay. Repeated 250ms Controller polls and one-second cleanup
polls dominate tests whose assertions concern state transitions, cancellation,
backoff and resource ownership. Shortening production cadence would change
runtime behavior without improving those assertions.

## Decision

The Controller independent-session and Worker coordinator test files intercept
only their Node promise-timer dependency. The test boundary records the requested
poll interval and forwards the value and options to Node's native promise timer.
Only the exact 250ms Controller and 1000ms Worker polling requests use a short
asynchronous schedule; other delays, including the clipped cleanup interval,
keep their requested duration. Native cancellation, AbortError
identity and causes, return values and event-loop progress remain observable.
The wrapper stays local to these suites; production timing is unchanged.

Controller tests verify the 250ms request. Worker tests verify the normal 1000ms
cleanup cadence and its clipping against the remaining cleanup deadline. State
matrices, replay prevention, second cleanup observations, reporter joins and
slot/resource ordering retain their existing assertions. A skipped second
observation or a repeated initial submission must still fail the corresponding
regression test.

These tests continue to perform actual SQLite and filesystem work and retain
real IPC where their existing journeys require it. Timers that establish native
transport or process termination remain governed by their own tests. The
[development guide](../../../../docs/development.md#cli-development) owns validation
commands. The separate [binary and IPC timing decision](2026-11-04-cli-test-time-and-bytes.md)
owns native socket admission and complete-byte assertions.

## Alternatives

**Wait for the production cadence in every fixture.** This preserves elapsed
wall time but makes controlled state transitions wait for an unrelated cadence.
The requested interval can be checked directly while the original state and
resource assertions exercise each transition.

**Replace the native promise timer with an immediately resolved promise.** That
removes event-loop turns and changes the opportunity for cancellation and queued
observations. The short native schedule retains asynchronous progress and Node's
existing AbortSignal behavior.

**Shorten production intervals or add a runtime test-only scheduling option.**
That changes the production contract or expands its interface for fixture speed.
The existing timer-module boundary contains the change within the tests.

## Consequences

The suites spend less wall time waiting for fixture state that is already ready.
They explicitly qualify the requested production cadence and the native timer's
value and cancellation behavior. Native-platform verification remains necessary;
local case durations do not establish whole-job savings under parallel workers.

Each test keeps private business state and restores its observations. Faster
polling is not a general replacement for real socket deadlines, native process
exit or heartbeat-based termination proof.
