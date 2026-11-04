# Agent Note: Separate Web coverage finalization budget

Status: implemented

## Problem

Web quality requires both a complete Vitest/V8 result and a compilation-based
source inventory with strict statement-coverage verification. A shared command
deadline can expire after every test and the coverage table have been printed
without confirming the final checker. Passing tests alone cannot establish the
required complete-source coverage result.

## Decision

`scripts/ci.mts quality` runs three serial commands: the canonical Node harness
with 180 seconds, complete `vitest run --coverage` with 300 seconds, and
`scripts/coverage.mts` with an independent 60 seconds. Only the collection child
receives four workers. Every command uses the existing cancellation, bounded
capture and process-group cleanup owner; failure or cancellation prevents later
commands. The final checker retains the full product-source inventory and
unrounded statement coverage strictly greater than 90%.

This partially replaces the combined coverage deadline in the
[quality isolation](2026-10-26-web-quality-job-isolation.md) and
[worker capacity](2026-10-28-web-quality-worker-capacity.md) decisions. Their
separate job ownership, worker calibration, pool isolation and historical
comparisons remain. Local `test:coverage` and `web:test` still run the same suite
and checker; no test, coverage rule, retry or browser input is removed.

The source-bound [PR #400](https://github.com/codetreker/daynight/pull/400)
evidence includes a hosted command that printed all 3,204 passing tests and its
coverage table at 177.59 seconds before the shared budget expired. That output
does not identify which final child was terminated or establish checker success.
Separate phases preserve that distinction and provide a bounded checker attempt
after a successful collection. A later integrated suite reached the 180-second
collection limit before printing a complete result; no assertion failure had
been reported at that cutoff. Its ordinary local suite contained 3,253 tests
before the additional lifecycle regressions. The five-minute collection bound
keeps this larger workload bounded without changing individual test timeouts,
inputs, assertions or coverage requirements; it is not a performance acceptance
threshold or a guarantee about future runner duration.

## Alternatives

**Increase the combined deadline.** This gives finalization room but also extends
the collection allowance and leaves collection and checker completion under one
budget. Independent bounds identify the incomplete phase and prevent collection from
consuming the strict checker's budget.

**Retry the same combined command or reduce its inputs.** The observed failure
does not establish a transient infrastructure cause or a failing test. Retrying
does not give finalization an independent budget, and removing inputs would
weaken the required quality result.

## Consequences

Quality has at most nine minutes of serial command allowances inside its
existing 20-minute job limit. A passing collection still cannot make
the quality job green if inventory, coverage or process cleanup fails. Tests
exercise all three command failures and cancellation after collection, including
the guarantee that a cancelled collection cannot start finalization.
