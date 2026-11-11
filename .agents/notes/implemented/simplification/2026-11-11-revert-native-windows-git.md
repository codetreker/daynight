# Agent Note: Revert Native Windows Repository Git

Status: implemented

## Problem

Repository Git acquired native Windows process creation, named-pipe transport,
Node argument and permission normalization, and Job stop/release lifecycles in
[PR #1027](https://github.com/codetreker/daynight/pull/1027). Maintaining that
backend and its dedicated qualification adds substantial platform-specific
complexity to short Git operations.

## Decision

Revert #1027 and restore repository Git's Node `spawn` runner. Windows cleanup
uses `SystemRoot/System32/taskkill.exe /PID /T /F`; POSIX retains process-group
cleanup. The runner retains operation cancellation, command deadlines, output
limits, fsmonitor suppression and cleanup errors with the original failure as
cause. No replacement process-ownership or recovery mechanism is introduced.

The [native adoption record](../bug-fix/2026-11-10-repository-git-windows-job-ownership.md)
retains the original rationale, alternatives and qualification limits as history.
The [owned local-closure port](../architecture/2026-11-11-owned-repository-git-local-closure.md)
retains this Node backend while separating bounded results from local closure.
The [review Job decision](../bug-fix/2026-11-09-windows-review-job-ownership.md)
continues to govern review's guardian, held Job and strict stop/retain policy.

## Alternatives

**Retain #1027's native backend.** It establishes ownership before execution and
supports sealed Job termination as well as natural release, but retains native
creation, transport, compatibility and handle-lifetime machinery. The reversal
accepts weaker repository Git cleanup guarantees to remove that maintenance cost.

## Consequences

Repository Git no longer has the private Job membership and sealed-admission
proof introduced by #1027. A successful `taskkill` result, root closure or closed
pipes cannot prove that escaped descendants have stopped, especially across a
parent's exit. Cleanup failures remain visible; successful cleanup observations
do not restore the removed guarantee or explain historical ambiguous failures.

The native backend and its dedicated regressions are removed. Review's native
Job ownership and the Bot Job lease remain. Existing deadlines and output limits
are preserved; the reversal makes no measured performance claim. The
[repository Git design](../../../../docs/design/daynight-project-task.md#git-定位与仓库身份)
owns the current execution and failure rules.
