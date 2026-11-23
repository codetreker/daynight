# Agent Note: Control Controller history deadline callbacks

Status: implemented

## Problem

The Controller history media regression holds a real HTTP history read while two
prepare requests occupy the media slots. Waiting for both ten-second deadlines
on every run adds fixed cost to the CLI suite, although the test needs the
deadline transition and resource cleanup rather than a wall-clock benchmark.

## Decision

The regression briefly fixes the clock and observes both ten-second history
deadline timer registrations in request order. It advances only their callbacks,
one at a time after both requests are waiting, and associates each response with
its request. It
keeps the real timers for socket traffic, polling and history retries, and checks
that the deadline timers are cleared. The real HTTP, WebSocket, SQLite and media
block paths continue through the timeout and subsequent history synchronization.

## Alternatives

**Wait for real expiry.** This exercises the same timeout path but adds ten
seconds to each execution and does not positively identify both registrations.

**Use global fake timers.** Socket traffic and history retry scheduling also
depend on timers, so controlling them would change the resource interaction the
regression is meant to exercise.

## Consequences

The case checks the two timeout and slot-release outcomes without measuring real
scheduler timing. The narrow callback identification follows the production
deadline's error text; changing that boundary requires updating the fixture.
The unchanged production deadline and native platform suites remain necessary.
