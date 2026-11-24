# Agent Note: Control the stale ACK observation window

Status: implemented

## Problem

A Markdown source checkpoint must remain closed to a timeline revision whose
position has not been acknowledged on the current relay connection. The
regression waits beyond the five-second local open budget to check that an old
ACK does not admit the source, adding five seconds to every execution.

## Decision

The [coordinator regression](../../../../packages/daynight/test/commands/controller/markdown/coordinator.test.ts)
observes the first refused verification after the checkpoint, then advances the
observation clocks and captured deadlines through the same window. It verifies
that the helper startup and local open deadlines were registered and cancelled,
and waits for another real asynchronous verification to reject the old ACK.
After the new ACK, it retains the source admission and validation assertion.
The real local helper, image decoding, SQLite, polling and cleanup remain active.

## Alternatives

**Wait for real time.** This exercises the same negative observation but adds a
fixed delay even when the open deadline has already been suspended.

**Replace all timers with fake timers.** Local helper IPC, the polling loop and
resource cleanup require independent asynchronous progress. Controlling every
timer would broaden the fixture and could hide their ordering.

## Consequences

The test avoids the fixed observation delay while retaining a real subsequent
verification and the original source admission assertions. Its controlled window
is not a measurement of real scheduler behavior or of every possible future
deadline; real helper and cancellation behavior remain separately observable.
