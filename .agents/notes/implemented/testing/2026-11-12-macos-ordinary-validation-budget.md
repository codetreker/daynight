# Agent Note: macOS Ordinary Validation Budget

Status: implemented

## Problem

The ordinary macOS ARM64 CLI suite needs time for runner setup, tests,
diagnostic uploads and final cleanup. The uniform 10-minute budget left
little margin for the suite. After the ordinary macOS job moved to 15 minutes,
[a later job](https://github.com/codetreker/daynight/actions/runs/45125632008/job/137530205706)
completed its test suite and uploads before the execution limit cancelled it
during job finalization. A cancelled job cannot establish the required result.

## Decision

The ordinary macOS matrix entry uses a 20-minute job limit. Windows ordinary
entries and all installed entries use 10 minutes; the
[Ubuntu validation budget](2026-11-25-ubuntu-ordinary-validation-budget.md)
sets that ordinary entry to 12 minutes. The complete test selection,
failure gate and individual test deadlines carry the same requirements. The
ordinary macOS limit supersedes the uniform limit in the
[independent macOS validation decision](2026-11-07-independent-macos-cli-validation.md).

## Alternatives

**Keep the 15-minute limit.** The observed job consumed this budget despite
passing all 13,200 executed tests. A successful
[rerun of the same checkout](https://github.com/codetreker/daynight/actions/runs/45125632008/job/137537943828)
finished in 11 minutes and 5 seconds, showing how much headroom can vary between
runs of the same workload.

**Reduce test selection.** The ordinary matrix supplies native evidence for the
whole CLI suite. Reducing the selection would remove part of that evidence.

## Consequences

A hung macOS job can take up to 20 minutes to report failure. The job limit
covers execution once the runner starts, while runner allocation has its own
queue. Test failures and cancellations continue to block the required checks.
