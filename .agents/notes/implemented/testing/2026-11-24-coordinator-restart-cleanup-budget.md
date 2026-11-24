# Agent Note: Coordinator Restart Cleanup Test Budget

Status: implemented

## Problem

The Coordinator integration case for a released prelaunch claim creates a real
Git repository and task-named worktree, interrupts removal after deleting the
checkout pointer, then reopens SQLite and restarts the Coordinator to finish
cleanup. A [Windows CI run](https://github.com/codetreker/daynight/actions/runs/45339774250/job/138267151579)
reported 6,963.908 ms against Vitest's default 5,000 ms deadline. The same test
source passed in other Windows runs at 4,344.1329 ms and 4,260.3668 ms. The log
identifies an insufficient outer deadline, but no particular slow phase or
production defect.

## Decision

The released-prelaunch restart cleanup case uses a local 45,000 ms Vitest
timeout. Its real Git, SQLite and Coordinator workflow retains every state,
registration, removal and restart assertion. The wait for the removal failure
allows 20,000 ms and reports Coordinator events on failure: it spans several
real Git operations and asynchronous cleanup. The Git fixture commands each
retain their 10,000 ms deadline; other eventually checks retain their 3,500 ms
limit. Production deadlines and the global test timeout retain their existing limits.

## Alternatives

**Keep the default timeout.** The observed complete Windows workflow exceeded
it, and successful runs already consumed most of that budget.

**Optimize an individual phase.** The failure log does not identify a slow
command or await, so it cannot support a targeted optimization.

## Consequences

The finite outer deadline accommodates native Git and filesystem variation
across the complete recovery workflow. A later Windows CI failure observed the
schedule still at `observation` when the 3,500 ms wait expired; it did not
identify which asynchronous phase was slow or establish a production defect.
The longer local wait allows more time for this chain and emits events
if the expected state remains absent. A stalled case can take longer to report;
its narrower operation deadlines still apply. This establishes no performance
improvement or root cause for that failure. The
[retired Web cleanup decision](../bug-fix/2026-11-23-worker-retired-web-cleanup.md)
owns the production recovery behavior.
