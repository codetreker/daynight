# Agent Note: Worker Fetch Timeout Fixture

Status: implemented

## Problem

The Worker worktree timeout test runs a real Git fetch against a blocked
local upload-pack and waits for the full 1,500 ms command deadline. A real
startup delay can also consume that interval before the blocked subprocess
reaches the condition the test intends to exercise.

## Decision

The [Worker worktree test](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
captures the fetch command's single 1,500 ms deadline through the existing
synchronous timer helper. It waits for the real upload-pack subprocess to
publish readiness, delivers the captured callback, and observes final local
closure. Cleanup can report pending before the Git process and its streams
close. The test checks the original deadline diagnostic, the worktree and
branch inventory, and the absence of private base refs.

## Alternatives

**Use native time throughout.** This repeats the configured interval in
wall time. Starting the wait before native upload-pack readiness also ties
the proof to subprocess startup time.

**Shorten the configured timeout.** A shorter native interval makes a
loaded runner more likely to expire before upload-pack has started and
blocked.

## Consequences

The clock is controlled only for the fetch deadline. Native Git, the
upload-pack subprocess, the stop path, and final closure remain observable.
Fixture cleanup releases the blocker, joins outstanding work, and restores
timer observation if the case fails before the deadline is delivered.
