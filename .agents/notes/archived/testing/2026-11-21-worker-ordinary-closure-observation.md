# Agent Note: Observe ordinary Worker closure within its lifecycle budget

Status: implemented

## Problem

The ordinary Worker startup regression must prove that an unknown command
journal event closes execution and that the original producer can subsequently
finish without a parent cancellation or an implicit rebuild. Its real SQLite
and filesystem work does not have a one-second completion contract. Vitest's
implicit one-second observation can fail before a valid shutdown completes.
The fallback cancellation in cleanup cannot establish natural completion.

Main run [44864174101](https://github.com/codetreker/daynight/actions/runs/44864174101)
failed this observation after a 518 ms initial migration. PR run
[44862721996](https://github.com/codetreker/daynight/actions/runs/44862721996)
passed with a 24 ms migration and a 470 ms case. The actual checkout commits
differ, but their complete source trees are identical. These logs establish
different execution timing, not a permanently stalled production owner.

## Decision

The existing case holds its controlled Reviewer after the original prepared,
unknown and stopped journal events are durably written. It observes the aborted
execution signal, uncancelled parent and generation 1 stopped record while the
original Reviewer owner is still joining. A one-second completion observation must fail while
the barrier is held, and the instance lock must remain unavailable.

Releasing the barrier permits the original Reviewer owner to finish.
An explicit 35-second observation accommodates the existing concurrent
20-second owner stops and subsequent 10-second management close with scheduling
margin. Startup observation is bounded to five seconds and the case to
45 seconds. The runtime, filesystem and journal remain real; production
deadlines, global test defaults and other cases keep their existing values.

Successful completion still requires one Reviewer invocation, an uncancelled
parent, the sole generation 1 stopped record and successful lock reacquisition.
Failure diagnostics retain the phase, elapsed time, completion state and runtime
errors with the original cause. Cleanup releases the barrier before cancellation
and joins the original runtime on every path.

The [development guide](../../../../docs/development.md#cli-test-fixtures) owns
the executable test contract. The
[execution scope decision](../architecture/2026-11-20-worker-execution-scopes.md)
owns the unchanged production lifecycle and responsibility rules.

## Alternatives

**Only increase the completion timeout.** This would accommodate slow execution
without proving that an original owner really retains responsibility beyond
the old observation window or naturally completes after release.

**Cancel the parent to finish the case.** Cancellation can force a different
shutdown path and cannot prove ordinary completion after the journal closes.

**Use a global fake clock or change production deadlines.** SQLite and filesystem
operations require real asynchronous progress. Advancing unrelated retry and
cleanup clocks would change the lifecycle being observed, while production
deadline changes would impose behavior beyond this test's timing defect.

## Consequences

The case deliberately consumes a one-second observation to preserve the slower
closure regression. Genuine missing closure and runtime rejection still fail;
a longer finite observation is not permission to release unconfirmed resources.
Holding a synthetic unknown record with no birth proof would instead exercise
missing-evidence refusal in native reconciliation. Holding the Reviewer after
stopped persistence preserves the original fixture's journal evidence and tests
producer closure without enabling the management-host rebuild interface. Controlled timing proves this mechanism and
does not identify the exact slow owner in the historical failed run.
