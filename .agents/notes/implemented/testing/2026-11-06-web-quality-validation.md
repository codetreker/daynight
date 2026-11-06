# Agent Note: Web quality validation

Status: implemented

## Problem

The Web coverage process has insufficient time to finish on hosted runners. In
[a main CI run](https://github.com/codetreker/daynight/actions/runs/42233822633/job/127946303415),
all 5,466 tests passed with a reported duration of 298.31 seconds, but the process
exceeded its five-minute limit before closing. Routine successful task
synchronization also produces structured debug messages throughout the suite,
obscuring test results and failure diagnostics.

## Decision

The quality runner gives the four-worker Vitest coverage process 15 minutes,
including startup, reporting and exit. Tooling tests retain their three-minute
limit and the statement checker retains its one-minute limit. The enclosing
GitHub job retains its 20-minute limit.

The shared Vitest setup suppresses `console.debug` calls whose first argument is
exactly `Task sync`. Other debug calls and all other console methods retain their
behavior. Production synchronization diagnostics remain available.

The interception runs before Vitest captures console output and is restored by
the existing per-test mock cleanup.

## Alternatives

**Increase only the GitHub job limit.** The observed failure comes from the
coverage subprocess deadline, so changing the enclosing limit would not give
that subprocess more time.

**Filter captured output with `onConsoleLog`.** Vitest batches stdout calls into
one captured chunk. Dropping a chunk beginning with a successful synchronization
could also hide unrelated output in the same chunk.

**Remove the production diagnostic.** This would discard the cycle and cache
statistics used to inspect runtime synchronization.

## Consequences

Coverage reporting and process exit have room beyond the observed suite duration;
a hung process can now take longer to reach its deadline. Validation still
fails on timeouts, command errors and coverage rejection.

Successful synchronization no longer floods ordinary test output. Failure
diagnostics and unrelated output remain visible, and tests can still inspect or
replace the debug spy when they need to assert diagnostic arguments.
