# Agent Note: macOS Ordinary Validation Budget

Status: implemented

## Problem

The complete ordinary CLI suite on macOS ARM64 can approach the 10-minute job
limit after runner setup, leaving insufficient time for validation and diagnostic
uploads. A cancelled job cannot establish the required platform result.

## Decision

The ordinary macOS matrix entry has a 15-minute job limit. The other ordinary
entries and all installed entries retain 10 minutes. The complete test selection,
failure gate and individual test deadlines remain unchanged. This supersedes
the uniform job limit in the [independent macOS validation decision](2026-11-07-independent-macos-cli-validation.md)
for the ordinary macOS entry.

## Alternatives

**Keep the uniform 10-minute limit.** A successful macOS run used nearly all
of that budget, and subsequent runs reached the limit while tests were still
progressing. A narrow margin makes the required result sensitive to runtime
variation.

**Reduce or skip tests.** This would sacrifice required native evidence rather
than allow the existing workload to complete.

## Consequences

The job remains bounded and can spend longer before reporting a hung workload.
Runner acquisition is separate from the execution limit and is not guaranteed
by this change. The full native suite and its diagnostic uploads remain required.
