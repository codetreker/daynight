# Agent Note: Control Attachment Sink Deadline Tests

Status: implemented

## Problem

An attachment request can expire before its response consumer starts. A
blocked-sink regression test that starts a short real deadline before dispatch
can therefore reject correctly without ever exercising its intended sink stage.
The timeout assertion passes, but the assertion about the sink's abort signal
fails because no signal was delivered to the consumer.

The observed Windows failure occurred with a 20 ms request limit. The consumer
had not run, while the request-timeout assertion had already passed. Advancing
the monotonic clock beyond the deadline before the mocked response returns
reproduces this order independently of scheduler speed.

## Decision

The blocked-sink fixture controls `setTimeout` and `clearTimeout` together with
`performance.now` imported from `node:perf_hooks`. It holds time steady during
request setup, attaches the rejection observer immediately, and waits for an
explicit consumer-entry receipt before advancing to the original deadline.

The fixture proves the consumer is pending with a live signal and an uncancelled
response before expiry. At the deadline it requires the request-timeout error,
sink abortion and exactly one response cancellation. Clock and timer cleanup
restore the surrounding test environment even when an assertion fails.

The production request lifecycle and timeout values remain unchanged. The
[development guide](../../../../docs/development.md#cli-test-fixtures) owns the
fixture usage guidance; the
[attachment design](../../../../docs/design/daynight-task-attachments.md#cli)
owns the transfer behavior.

## Alternatives

**Increase the real deadline.** A larger interval still permits setup to consume
the entire allowance and does not prove that the timeout interrupted a blocked
sink.

**Control timers without the monotonic clock.** Production code also checks the
remaining request deadline synchronously. A delayed setup can cross that deadline
even while fake timer callbacks remain paused.

**Accept timeout without proving sink entry.** This would let expiry before
consumer invocation pass as evidence that deadlines remain active while the sink
is blocked, losing the regression's purpose.

## Consequences

The test exercises the blocked-sink deadline transition without depending on
runner load or wall-clock sleeps. It preserves the original timeout, signal and
response-cleanup checks. Native platform CI remains necessary for the complete
CLI suite; the controlled fixture alone does not establish a Windows scheduling
or stream-runtime defect.
