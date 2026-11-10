# Agent Note: Native Test Termination Diagnostics

Status: implemented

## Problem

A macOS ordinary test run reported that Vitest received SIGKILL before its final
summary, while the runner continued uploading artifacts. Startup tool versions
and successful individual suites could not identify the sender, resource
pressure or an offending process group. Local bounded probes did not reproduce
the main-process termination. Retrying without additional evidence could hide
an unresolved defect behind a later passing run.

Ordinary runs can also report a failed test and then reach the job deadline
before Vitest prints its final error summary. The failure name alone cannot
establish which assertion or runtime operation failed. Already delivered test
errors must remain readable while later tests are still running; process
sampling cannot recover details that the test framework has not yet printed.

## Decision

The macOS ARM64 entry in the ordinary `verify` matrix executes its unchanged
test command under
[`observe-native-validation.mjs`](../../../../packages/daynight/scripts/observe-native-validation.mjs).
The observer inherits the command's stdio and environment, records its PID and
exit code or signal, and propagates failure. It does not change suite selection,
Vitest concurrency or test deadlines. The
[independent macOS validation decision](2026-11-07-independent-macos-cli-validation.md)
owns the shared native matrices and their ten-minute job limit. Conditional
macOS steps select the observer and upload its termination diagnostics; Linux
and Windows execute the same ordinary test command directly. Installed
validation prepares its own runner and workspace, so diagnostic collection and
receipt paths have no cross-phase ordering or reuse requirement.

Incremental observations contain process IDs, parent/group IDs, resident memory
and elapsed lifetime without command arguments or environment values. Process
sampling runs every five seconds; memory/swap probes run every fifteen seconds.
Probe capture is sequential and bounded. At a deadline the observer closes its
probe handles and records unconfirmed completion when exit has not been observed;
this does not prove that the native probe has already stopped. After the command exits, a
bounded macOS unified-log query captures termination and memory-pressure events
for the test interval. Probe errors and unavailable log access remain explicit.
Filtered system event text can contain process context supplied by macOS; the
observer does not add command arguments or environment values to its metadata
or process snapshots.
The observer cleans up only its own probes and never retries the test command.
The workflow uploads available diagnostics even after test failure.

All ordinary CLI runs retain the public `configDefaults.reporters` selection,
including GitHub Actions annotations, and add
[`vitest-failure-reporter.ts`](../../../../packages/daynight/scripts/vitest-failure-reporter.ts).
The pinned Vitest 5.0.5 public result callbacks supply final failed tests,
suite hook errors and module errors. The public `onUnhandledError` configuration
callback records unhandled errors immediately and never returns `false`.
Reporter callbacks do not inspect private runner tasks or install process-wide
exception listeners. A later successful retry does not become a failed-test
diagnostic merely because its result retains earlier errors.

Each observation is synchronously appended to a unique run JSONL file and
written to the console. Only file and test identity, error name, message and
stack are selected; arbitrary result objects, expected/actual fields,
environment values and process arguments are not added. The
[development guide](../../../../docs/development.md#cli-development) owns the
field, event and combined run byte limits. JSON escaping counts toward field
limits; omitted content and an exhausted run budget are explicit. A writer
failure uses the remaining output and does not replace Vitest's exit status.
The ordinary native matrix always attempts to upload available JSONL files,
including after cancellation. It retains the existing command, concurrency,
deadlines and macOS observer.

## Alternatives

**Repeat the unchanged run.** A passing retry would not explain the earlier
SIGKILL, and existing artifacts lacked the runtime evidence needed to establish
a transient infrastructure cause.

**Lower concurrency or extend deadlines.** Neither was supported by a measured
resource bottleneck or a reached deadline. Both alter validation conditions
before identifying the failure.

**Instrument every JavaScript signal and test lifecycle.** At the observer's
introduction, inherited preloads and broad lifecycle instrumentation could not
identify native or kernel signals. Passive OS observations and termination
logs supplied the first missing evidence with less intrusion. The added
reporter consumes already delivered framework errors only; it complements
those observations without claiming signal attribution.

**Rely on the final Vitest summary or JSON report.** These outputs can disappear
when a later test or the entire job remains active until cancellation. Appending
each delivered error preserves the diagnostic before that boundary.

**Serialize complete framework results.** Large actual/expected values and
unrelated metadata would amplify logs without a bounded failure record. Explicit
field selection and encoded byte limits preserve the failing subject and its
provided stack within a fixed cost.

## Consequences

The observer adds periodic native-process work and a bounded post-test log
collection interval. It does not establish exact memory peaks, capture every
short-lived descendant, or prove that a missing log entry excludes a signal
source. Collection failures do not replace the test result. An abrupt observer
or runner death can leave only the incrementally written samples and framework
errors. An unavailable console and filesystem together prevent diagnostic
delivery; a failed write cannot turn the test failure into success.

The [development guide](../../../../docs/development.md#cli-development)
owns execution and artifact guidance. A subsequent successful run establishes
that revision's validation result; it does not retroactively attribute an
earlier unexplained termination. Framework errors establish a delivered failure,
not the reason a later job was cancelled. More intrusive diagnostics require
evidence that these observations cannot distinguish the remaining hypotheses.
