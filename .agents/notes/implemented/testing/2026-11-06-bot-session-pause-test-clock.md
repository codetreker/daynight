# Agent Note: Control the Bot Session pause test clock

Status: implemented

## Problem

The paused-channel deadline regression sampled the current time before asking
the Session cache to pause. The client records its sixty-second suspension
limit later, after publishing the paused state. The test then advanced the
original sample by 60,001 milliseconds. If entering the pause took more than one
millisecond, that simulated time was still before the client's deadline. The
healthy retained channel correctly stayed open, while the test incorrectly
expected a second connection.

## Decision

The deadline case fixes `Date.now` before entering the pause, then advances that
same clock by 60,001 milliseconds before resuming admission. Real timers remain
active for React, channel delivery and assertion polling. The spy is restored
before awaiting reconnection and also in the failure cleanup path.

The existing [background-check display decision](../bug-fix/2026-11-05-bot-background-check-display.md)
owns pane retention and bounded transport recovery. Its production deadline,
replay cursor and lifecycle remain unchanged. The regression continues to require
the same pane, client, draft and Timeline, a new connected generation, cursor
replay and no native command.

## Alternatives

**Increase the simulated offset or assertion wait.** A larger offset still
relates expiry to an earlier wall-clock sample. Waiting longer does not establish
that the simulated deadline was reached and adds incidental delay to the test.

**Replace all timers with fake timers.** The regression also exercises React and
asynchronous channel publication. Controlling those timers would broaden the
fixture and require coordinating unrelated waits when only the deadline's wall
clock needs control.

## Consequences

Time spent publishing the paused view cannot consume the test's expiry margin.
The deadline, buffer and transport cases retain all existing behavior assertions,
timeouts and failure handling. The controlled clock does not measure real-time
scheduler performance or prove an actual sixty-second browser pause.
