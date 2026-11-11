# Agent Note: Worker execution capacity after stop

Status: implemented

## Problem

A stopped Agent can retain archive, endpoint and worktree responsibilities for
an extended period. Counting those file obligations as running executions
prevents unrelated tasks from using available Worker execution capacity.

## Decision

Execution capacity follows the original backend execution, independently of
resource cleanup and the same-task barrier. A terminal cleanup releases its slot
when the exact original execution is observed stopped or an authoritative source
confirms it never started. Unknown observations remain occupied. A new execution
or recovery reserves capacity before invalidating old evidence. Notices and
observations are fenced by owner, execution and cleanup attempt.

Web observes existing Controller and recorded provider process proofs, including
a journal reread after the Controller stops. Native Herdr uses its committed stop
proof; legacy Herdr retains the original binding and stop result in the current
Worker. The runtime coalesces changes with a revision wake so a notice during a
round is not lost. [Archive priority](../bug-fix/2026-11-11-worker-archive-priority.md)
continues to preserve the original file and archive responsibilities. The [Worker design](../../../../docs/design/daynight-worker.md)
owns the operational contract.

## Alternatives

**Wait for all cleanup.** This keeps a single resource count but lets slow or
failed archives and Git operations block unrelated execution after the Agent stops.
The earlier [cleanup retry decision](../../archived/bug-fix/2026-11-04-worker-cleanup-retry.md)
recorded that conservative policy.

**Prove every descendant has stopped.** Existing sources do not cover unrecorded
or escaped descendants. A new process-tree proof system would add persistent
protocol and platform obligations beyond the existing execution identities.

## Consequences

File errors and same-task barriers survive release of execution capacity. A Web
observation covers recorded original instances, not unrecorded or escaped
processes. Missing, conflicting or unreadable sources remain unknown. Retained
cleanup work can therefore coexist with unrelated execution, subject to the
existing inventory and resource budgets.
