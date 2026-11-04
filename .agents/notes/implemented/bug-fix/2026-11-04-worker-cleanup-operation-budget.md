# Agent Note: Worker cleanup operation budgets

Status: implemented

## Problem

Terminal cleanup can still be removing a large owned worktree when its operation
deadline expires. Different cleanup steps have shorter limits than the agent's
ten-minute cleanup turn: resource operations use two minutes, Herdr worktree
deletion uses three, and transport or Git request caps can expire earlier.
Remaining resources keep capacity and same-task execution barriers occupied.
Increasing an outer deadline alone leaves shorter nested limits effective.

## Decision

Cleanup observations, notification, stop/close, and worktree verification and
deletion use five-minute operations. The shared cleanup operation owns both the
total deadline and request cap; Herdr RPC and cleanup Git commands inherit that
request budget. Web cleanup IPC, missing-execution provenance HTTP verification,
Controller cleanup-response waiting and final process-stop proof use the same
five-minute upper bound. Signal escalation
intervals remain independent of that final deadline.

The agent still has its original ten-minute cleanup turn. Notification and
Controller cleanup-response waits are capped by the remaining turn time, and
polling does not renew that deadline. Shutdown continues to stop resources
directly without an agent cleanup turn, archive upload or worktree deletion.
Ordinary execution retains its existing operation budgets.

The [worker design](../../../../docs/design/daynight-worker.md#结束清理与退出)
owns the cleanup sequence. The
[owned-directory decision](2026-11-04-worker-readonly-directory-cleanup.md)
owns forced entry deletion and its link, permission and identity constraints.
Failure continues to retain actual resources and cleanup responsibility.

## Alternatives

**Raise only the worktree deletion deadline.** Other cleanup operations still
expire earlier, and request-level caps can defeat the longer outer budget.

**Raise every Worker operation's default.** Startup, ordinary observation and
recovery would wait longer as an unrelated side effect. A separate cleanup
operation keeps the requested budget attached to its lifecycle responsibility.

## Consequences

Cleanup can finish work that exceeds the former two- or three-minute limits.
An unresponsive operation can now retain its task's cleanup job for up to five
minutes. Different tasks remain independent, and errors do not prove resource
disappearance or release capacity.

The five-minute limits are per operation, not a total deadline for all cleanup
steps. Submitted filesystem operations are still joined on cancellation or
deadline expiry before another removal can start; an unresponsive syscall may
therefore outlive its operation deadline. No persistence or scheduling policy
changes are introduced by these budgets.
