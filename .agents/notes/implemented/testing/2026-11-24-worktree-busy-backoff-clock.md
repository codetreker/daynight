# Agent Note: Control synthetic worktree busy backoff waits

Status: implemented

## Problem

The terminal busy-root regression needs six failed removal attempts and retained
Git registration. Its synthetic obstacle cannot recover with elapsed time, yet
the five production backoffs add 620 milliseconds to every execution. The test
must still allow real filesystem inspection between attempts and detect an
omitted ownership revalidation.

## Decision

The [Worker worktree tests](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
control promise timers only for the backoff immediately following the selected
root's synthetic `EBUSY`. All other promise timers use their actual implementation.
The synchronous deadline helper captures each registration, verifies the requested
20, 40, 80, 160 and 320 millisecond delays, and delivers it after an asynchronous
event-loop yield. Each capture is restored before the next delay is admitted.

The fixture retains real Git registration and filesystem reads. Every retry
observes the original root identity before its mutation; final failure preserves
the original busy error and registration. Cleanup restores timer ownership and
joins the started removal. The existing directory-replacement regression checks
the same ownership failure independently. Real Windows holders and privileged
cleanup retain their actual timers.

## Alternatives

**Wait for all five production delays.** The fixture always returns the same
synthetic obstacle, so elapsed waiting adds cost without providing native
handle-release evidence.

**Advance a global fake clock.** Git subprocesses, filesystem reads and other
operation deadlines need independent real progress. Capturing the observed
backoff registration identifies the intended wait without advancing those timers.

## Consequences

The synthetic case removes its 620 millisecond wall-clock backoff while preserving
the production duration sequence and asynchronous ownership checks. Real native
handle-release behavior remains covered by the separate holder cases. The saving
is a case-level reduction; parallel CI job completion still depends on native
setup, other files and runner scheduling.
