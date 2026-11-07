# Agent Note: Native Test Termination Diagnostics

Status: implemented

## Problem

A macOS ordinary test run reported that Vitest received SIGKILL before its final
summary, while the runner continued uploading artifacts. Startup tool versions
and successful individual suites could not identify the sender, resource
pressure or an offending process group. Local bounded probes did not reproduce
the main-process termination. Retrying without additional evidence could hide
an unresolved defect behind a later passing run.

## Decision

The ordinary macOS ARM64 job executes its unchanged test command under
[`observe-native-validation.mjs`](../../../../packages/daynight/scripts/observe-native-validation.mjs).
The observer inherits the command's stdio and environment, records its PID and
exit code or signal, and propagates failure. It does not change suite selection,
Vitest concurrency or test deadlines. The
[independent macOS validation decision](2026-11-07-independent-macos-cli-validation.md)
owns the ten-minute validation-step limit and twenty-minute outer job limit.
Ordinary termination diagnostics upload in the ordinary job. Installed
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

## Alternatives

**Repeat the unchanged run.** A passing retry would not explain the earlier
SIGKILL, and existing artifacts lacked the runtime evidence needed to establish
a transient infrastructure cause.

**Lower concurrency or extend deadlines.** Neither was supported by a measured
resource bottleneck or a reached deadline. Both alter validation conditions
before identifying the failure.

**Instrument every JavaScript signal and test lifecycle.** Preloads and custom
reporters can correlate intent with active tests, but affect inherited Node
children and still miss native or kernel signals. Passive OS observations and
termination logs supply the first missing evidence with less intrusion.

## Consequences

The observer adds periodic native-process work and a bounded post-test log
collection interval. It does not establish exact memory peaks, capture every
short-lived descendant, or prove that a missing log entry excludes a signal
source. Collection failures do not replace the test result. An abrupt observer
or runner death can leave only the incrementally written samples.

The [development guide](../../../../docs/development.md#cli-development)
owns execution and artifact guidance. A subsequent successful run establishes
that revision's validation result; it does not retroactively attribute an
earlier unexplained termination. More intrusive diagnostics require evidence
that these observations cannot distinguish the remaining hypotheses.
