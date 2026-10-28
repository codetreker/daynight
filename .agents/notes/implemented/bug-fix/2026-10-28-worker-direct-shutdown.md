# Agent Note: Direct Worker Shutdown

Status: implemented

## Problem

Stopping the foreground worker can wait for an agent's external-resource cleanup
turn for up to ten minutes. An already running terminal-cleanup job can keep the
same wait alive during exit or continue deleting a worktree while shutdown tries
to preserve unfinished execution. Process exit needs a reliable stopping boundary
without losing the state needed for the next reconciliation.

## Decision

Worker exit stops acquisition and scheduling, cancels every running job including
terminal cleanup, and joins them before directly interrupting and stopping agents
and closing workspaces. It sends no cleanup prompt and waits for no cleanup turn.
Pending adapter stop confirmations settle before the private Herdr daemon stops.
Stop failures remain visible; uncertain stopping retains the daemon and affected
resources.

Exit preserves claims, worktrees, native session IDs and unfinished local rows,
even when ownership has already ended. The next run uses normal complete-inventory
reconciliation to re-enter terminal cleanup for ended claims. Normal completion,
release, withdrawal and manual-control cleanup keep their existing behavior.

This decision partially supersedes the worker-exit use of bounded cleanup in the
[agent patrol decision](2026-10-27-worker-agent-patrol.md). Its fresh idle signal
still completes a notified terminal-cleanup turn during normal reconciliation.
The [claim record decision](../simplification/2026-10-27-worker-claim-records.md)
still owns the local index and process-local cleanup progress. The
[worker design](../../../../docs/design/daynight-worker.md#结束清理与退出)
owns the exit mechanism.

## Alternatives

**Keep bounded agent cleanup on process exit.** It gives the agent a chance to
remove attributable external temporary resources, but delays stopping by a
model-dependent turn and its deadline, including an already running cleanup job.

**Cancel only ordinary execution jobs.** Terminal-cleanup jobs can continue
waiting or mutate worktrees and local rows during exit. Cancelling and joining
all jobs establishes a single boundary before direct stopping.

## Consequences

Exit no longer depends on agent responsiveness to cleanup instructions. Direct
interruption may leave external temporary files, services or processes behind;
closing a workspace does not prove those resources were removed. Cancelling a
current cleanup job preserves its remaining worktree and unfinished row for the
next reconciliation, even when its claim has ended. Already completed deletions
are not reversed. Restart can issue another normal terminal-cleanup notification
to any surviving agent; it does not reconstruct the interrupted job's deadline
or create an agent solely for cleanup. Stop confirmation remains necessary, so
uncertain stopping can leave the private daemon running with a visible error.
