# Agent Note: Web quality validation

Status: implemented

## Problem

The Web coverage process has insufficient time to finish on hosted runners. In
[a main CI run](https://github.com/codetreker/daynight/actions/runs/42233822633/job/127946303415),
all 5,466 tests passed with a reported duration of 298.31 seconds, but the process
exceeded its five-minute limit before closing. Passing tests also produce
structured task synchronization logs, including warnings from expected failure
scenarios, obscuring test results and diagnostics for actual test failures.

## Decision

The quality runner gives the four-worker Vitest coverage process 15 minutes,
including startup, reporting and exit. Tooling tests retain their three-minute
limit and the statement checker retains its one-minute limit. The enclosing
GitHub job retains its 20-minute limit.

Vitest uses `silent: "passed-only"` to suppress console output from passing
tests and retain output from failing tests. Tests still execute all console
calls and can inspect their arguments. Production diagnostics remain available.

## Alternatives

**Increase only the GitHub job limit.** The observed failure comes from the
coverage subprocess deadline, so changing the enclosing limit would not give
that subprocess more time.

**Filter diagnostic labels.** Selecting individual success or failure labels
requires maintaining a list of expected messages and can hide useful logs when
a test actually fails. Vitest's outcome-based filtering handles all console
methods and preserves the logs of failed tests.

**Remove the production diagnostic.** This would discard the cycle and cache
statistics used to inspect runtime synchronization.

## Consequences

Coverage reporting and process exit have room beyond the observed suite duration;
a hung process can now take longer to reach its deadline. Validation still
fails on timeouts, command errors and coverage rejection.

Passing tests no longer flood ordinary output, including when they exercise
error handling. Failed tests retain their console diagnostics without changing
assertions or test exit status.
