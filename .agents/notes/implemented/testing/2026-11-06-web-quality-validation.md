# Agent Note: Web validation

Status: implemented

## Problem

The Web coverage process originally had insufficient time to finish on hosted
runners. In
[a main CI run](https://github.com/codetreker/daynight/actions/runs/42233822633/job/127946303415),
all 5,466 tests passed with a reported duration of 298.31 seconds, but the process
exceeded its five-minute limit before closing. Passing tests also produce
structured task synchronization logs, including warnings from expected failure
scenarios, obscuring test results and diagnostics for actual test failures.
Running Playwright after quality validation delays its result and prevents the
browser suite from running when an earlier quality stage fails.

## Decision

Web selection starts `verify-web-quality` after module detection. It runs full
Web typechecking, the tooling harness, the production Docker Web build, Vitest
coverage and the statement checker with a 30-minute job limit.

The original split also selected `verify-web-browser` for each affected PR,
giving the assistant suite an independent runner so an earlier quality failure
could not suppress its result. The
[shell/browser workflow decision](2026-11-12-shell-browser-workflow.md)
replaces that trigger and gate arrangement. `verify-web-browser` now runs on
`main` pushes or manual dispatch with its locked Chromium, complete assistant
suite, browser evidence and 20-minute limit. Both jobs still prepare their own
checkout, Node and locked workspace dependencies. The browser configuration
starts its own controlled Vite host; it needs no quality artifact or earlier
quality result.

The quality runner gives the four-worker Vitest coverage process 15 minutes,
including startup, reporting and exit. Tooling tests retain their three-minute
limit and the statement checker retains its one-minute limit. Full typechecking
has a one-minute limit and the Docker Web build has a five-minute limit. The
[production build decision](../bug-fix/2026-11-07-localhost-web-build-inputs.md)
owns compilation inputs and the Docker regression check.

Vitest uses `silent: "passed-only"` to suppress console output from passing
tests and retain output from failing tests. Tests still execute all console
calls and can inspect their arguments. Production diagnostics remain available.

The final `checks` job waits for Web quality. Its general status guard rejects
failed or cancelled jobs, and its selected-Web guard requires actual quality
success. Documentation-only selection can skip quality. The assistant browser
job reports success or failure in its independent workflow and is not a PR
`checks` dependency. Each job uploads its own evidence after its validation step,
including failed runs.
The [Web validation guide](../../../../packages/daynight-web/README.md#validation-and-build)
owns commands and evidence paths.

## Alternatives

**Keep Playwright after quality in one job.** Browser work waits for independent
coverage work, and an earlier failure removes the browser result entirely.

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

Quality and browser results remain independent. Originally either failure
blocked selected PR Web validation; the independent workflow now provides the
browser result for its integrated or manually selected revision. Separate
runners duplicate checkout and dependency installation; they share no mutable
workspace or cross-job artifact dependency. The browser suite, worker count,
retries and test deadlines remain unchanged.
