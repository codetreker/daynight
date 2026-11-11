# Agent Note: Separate Worker execution capacity from cleanup responsibility

Status: implemented

## Problem

A stopped Agent can retain an archive, endpoint, worktree or retry schedule for a
long time. Counting those file responsibilities as running execution prevents an
unrelated task from starting even when the original process has stopped. Releasing
all ownership instead would allow a later claim for the same task to reuse a path
while the original cleanup still owns it.

## Decision

The [Worker design](../../../../docs/design/daynight-worker.md) derives execution
occupancy from evidence bound to the original owner and run. Terminal cleanup
notifies the coordinator when the backend proves that execution stopped or never
started. The coordinator also observes the original backend independently of file
cleanup and its retry schedule. It retains cleanup and same-task responsibilities
until their own resource conditions are met. Ordinary recovery reserves a slot
and invalidates old execution facts before starting.

A runtime-only fact view binds observations and notifications to the owner, run,
cleanup attempt and observation order. Conflicting sources make the result unknown;
an ordinary read failure does not erase an otherwise valid proof. The runtime wakes
its serial reconciliation loop when occupancy changes. Historical Web archive
backfill runs as one managed job and is cancelled and joined before stores close.

Web stop verification joins the original process boundary and final journal
evidence before notifying. The notification and source-fenced stop commit share
one synchronous turn, so a commit-time source conflict revokes that attempt's
notice before its wake can admit another execution. After closing the stop scope,
the caller rechecks the original source before recovery or file cleanup.

This partially supersedes the capacity statements in the
[recovery evidence decision](../bug-fix/2026-11-10-worker-recovery-evidence.md):
quarantine and archive repair retain file ownership, while an independently proven
stopped execution no longer consumes a slot.

## Alternatives

**Wait for all cleanup before releasing capacity.** This keeps one simple
responsibility count, but an unavailable archive or slow deletion can prevent
unrelated work from starting after the Agent has exited.

**Persist a cleanup-stopped flag.** A stored flag can outlive its original run or
become inconsistent with a later recovery. Reobserving backend evidence binds the
current decision to the actual execution without introducing another durable step.

**Use monitoring phases as proof.** Monitoring is optional and its callbacks can
be lost; an observation channel cannot safely authorize scheduling.

## Consequences

File failures, retry backoff and an independently attributed quarantine preserve
their cleanup and same-task protections without reinstating a confirmed stopped
execution's slot. Unknown or conflicting execution evidence remains occupied;
incomplete resource inventories retain their separate admission restrictions.
Legacy Herdr stop receipts are process-local, so a restart without sufficient
original evidence remains unknown. Historical archive work cannot block a normal
poll, but shutdown waits for its real finalizer rather than abandoning a writer.
