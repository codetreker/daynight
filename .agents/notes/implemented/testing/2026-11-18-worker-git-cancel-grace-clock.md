# Agent Note: Worker Git Cancellation Grace Clock

Status: implemented

## Problem

Four Worker Git cancellation cases deliberately keep a real inherited pipe
open after the command root exits. Each waits a full second to see the
cleanup-pending report. The integration contract is the report and ownership
that persist until real closure, not wall-clock timing in every mutation case.

## Decision

The [Worktree tests](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
observe the actual root exit and descendant readiness first. Abort registers
exactly one 1,000 ms cleanup grace in that state. The shared test helper
captures the synchronous registration, yields to the real event loop, and
delivers the callback only while the captured timer is still active. The tests
retain the original report, cancellation cause, unavailable completion while
the descendant owns the pipe, and join after real pipe closure.

The existing Bot probe response-deadline tests use the same test helper. The
native Git deadline and cleanup grace still run against real time in the
[owned Git tests](../../../../packages/daynight/test/repository/git-owned.test.ts),
and the real Worker fetch deadline case is unchanged.

## Alternatives

**Use short real grace periods.** The native close event could beat those
periods on a loaded runner, obscuring which case state was exercised.

**Fake the process or its pipe.** That would remove the inherited handle and
local join behavior these integration cases must observe.

## Consequences

The four cases retain actual detached descendants and process cleanup while
they no longer wait for the grace to pass in wall time. Production timers and
failure classification are unchanged.
