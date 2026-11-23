# Agent Note: Bot CLI Probe Test Timing

Status: implemented

## Problem

The Bot CLI probe tests exercise real process ownership and complete cleanup.
On POSIX, the guardian ignores TERM, so each stop waits for the full two-second
grace before KILL. A deadline case also waits for its five-second request timer.
These fixed waits accumulate even though elapsed wall time is incidental to the
process and error behavior under test.

## Decision

The POSIX fixture controls the clock within one real stop call. It freezes time
after a successful TERM to the owned process group, then advances the first poll
near the end of the grace after a real inventory shows a live member. A second
real inventory and the actual requested poll interval precede the real KILL.
The trace checks the production two-second boundary and polling requests; after
KILL, time advances with the native clock so later stop and join deadlines remain
effective. Signal and inventory operations continue to use their real implementations. Unexpected
ordering returns to native timing and is reported after cleanup rather than
blocking the stop.

The request deadline case separately captures the response timer registered by
the run call and checks its configured five-second duration. The fixture retains
native cancellation semantics and expires the timer only after the descendant's
own readiness receipt and a real running-process proof, while the result remains
pending. Other timers and the monotonic operation deadline remain real. Windows
does not use the POSIX clock and retains real Job assignment, termination,
inspection and handle ownership. The fixture joins real stops and restores its
hooks; fallback cleanup uses native timing and retains unconfirmed ownership.

The [Bot role and environment decision](../architecture/2026-11-05-bot-role-environment.md)
owns the guardian and cleanup guarantees. The earlier
[Bot CLI observation decision](../../archived/architecture/2026-11-04-bot-cli-observation.md)
records the CLI's distinction between remote observation and local ownership.
The [development guide](../../../../docs/development.md#cli-test-fixtures)
describes the fixture boundary.

## Alternatives

**Wait for real expiry.** This exercises native timer scheduling but adds the
same wall-clock delays to each run without establishing that the relevant
descendant or inventory is ready.

**Advance all timers or replace the stop result.** This could expire unrelated
budgets or bypass the actual process-group cleanup whose behavior the test owns.

**Add production timing options.** Test-only controls in the product interface
would expose configuration that the production probe does not need.

## Consequences

The fixture retains real process, signal, inventory and cleanup observations
while removing incidental fixed waits. Its timing checks prove configured
intervals and sequencing rather than native scheduling accuracy. They depend on
the production registration and polling sequence; changes there require the
fixture to be reconsidered. File-level savings do not establish hosted job or
workflow savings.
