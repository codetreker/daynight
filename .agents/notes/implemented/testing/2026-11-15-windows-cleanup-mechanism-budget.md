# Agent Note: Windows Cleanup Mechanism Test Budget

Status: implemented

## Problem

The single Windows test that observes a live original process through .NET can
exhaust its query deadline before reaching `GetProcessById`. In
[the failed Windows CLI job](https://github.com/codetreker/daynight/actions/runs/43699828808/job/132770301060),
the PowerShell script-start checkpoint arrived after 6777 ms, and the observer
closed after 10148 ms with `ETIMEDOUT`, no stdout and no get-process checkpoint.
Those observations locate the delay before process acquisition; they do not
identify its underlying cause. The default 10-second query budget leaves little
time for the remaining real mechanism on a delayed runner.

## Decision

The live .NET mechanism test injects a 20-second query deadline through the
existing `execute` boundary and retains the 2-second observer cleanup budget.
Its 30-second test timeout accommodates the query, observer cleanup and original
child cleanup. Stage capture, the exact target PID, a nonzero StartTime token,
`present` state and successful observer close remain required.

The general query default remains 10 seconds. Cleanup checker calls and
production process proof retain their budgets and behavior. The controlled
timeout case keeps a 3-second query deadline and 2-second cleanup budget, requiring
`ETIMEDOUT`, `SIGKILL`, confirmed close and no process rows. Unknown observations
continue to fail cleanup.

The [native fixture decision](../architecture/2026-11-12-herdr-frozen-tool-launch.md)
owns the separation between controlled cleanup policy and real platform evidence.

## Alternatives

**Keep the 10-second mechanism query budget.** The recorded script-start delay
leaves about three seconds for all remaining script initialization, process
acquisition and serialization. The observed failure demonstrates that this
budget can expire before acquisition starts.

**Increase the shared query deadline.** That would also extend cleanup checker
failure latency. The isolated test has its own injection boundary, so widening
all query budgets is unnecessary.

## Consequences

Only the live mechanism test can spend ten additional seconds observing the
process. A stalled observation still fails and cleans up within explicit bounds.
The larger budget accommodates runner delay without establishing its root cause
or guaranteeing that every future runner finishes within 20 seconds.
