# Agent Note: Worker Concurrent Fetch Test Budget

Status: implemented

## Problem

The concurrent fetched-commit test performs two real Worker Git preparations
while deliberately holding the first after its fetch. The second fetch and
worktree creation must finish before the first continues. This includes 37
native Git subprocesses across fixture setup, both preparations and assertions.
Windows [run 42663526492](https://github.com/codetreker/daynight/actions/runs/42663526492/job/129321200662)
reported 5254 ms for the case and failed its default 5000 ms watchdog. The log
does not identify the particular Git command running when the watchdog expired.

## Decision

The [concurrent fetched-commit case](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
uses a local 30-second watchdog. Both real preparations remain inside the
barrier-controlled interleaving. The test still checks distinct captured commits,
unchanged FETCH_HEAD and remote-tracking refs, and removal of private base refs.
The [remote default base decision](../bug-fix/2026-11-09-worker-remote-default-base.md)
owns the production mechanism.

The bound covers native process startup and the complete concurrent workflow;
it is not a Worker performance requirement. Individual Git deadlines and the
separate fetch-timeout and cancellation cases retain their existing limits.

## Alternatives

**Move fixture setup into a preparation hook.** The
[discovery budget decision](../../archived/testing/2026-10-29-worker-worktree-behavior-budget.md)
separates setup from discovery observations. Here, removing the initial fixture
commands still leaves both preparations and the remote advancement inside the
race, roughly 33 native Git calls. Prebuilding either managed worktree would
remove the concurrent creation behavior being tested.

**Keep the default watchdog.** The observed Windows workflow exceeds it. Five
seconds is the runner default, not a required upper bound on this mechanism.

## Consequences

The complete real Git interleaving and its assertions remain intact across
platforms. A stalled case still fails within a finite test budget, although the
outer watchdog now takes longer to detect a hang. This does not establish a
native Windows speedup or identify a production Git defect. Other cases and the
global runner configuration retain their existing budgets.
