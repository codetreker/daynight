# Agent Note: Bounded Worker Cleanup Retries

Status: implemented

## Problem

An ended claim can retain its worktree after a native agent has stopped because
archive publication or filesystem deletion fails. Retrying that unchanged failure
on every reconciliation creates repeated I/O and cleanup-error logs, while a
full worker provides no specific explanation for its occupied slots. Native stop,
archive completion and directory deletion are separate facts: a deletion error
cannot establish that an agent is still running.

The Herdr claim index originally kept cleanup timing and notification state only
in memory. A restart could repeat the cleanup input and restart its ten-minute
budget even when the obstacle remained unchanged. Current resource observation
can establish whether a process or worktree still exists, but cannot recover an
uncertain input submission or its first deadline.

## Decision

The [Worker requirements](../../../../docs/spec/daynight-worker.md)
and [design](../../../../docs/design/daynight-worker.md#结束清理与退出)
separate terminal cleanup scheduling from native execution results. Worker state
version 6 adds cleanup_schedules beside the existing project and claim index.
Each project/task/claim record binds its worktree ID and retains the first
deadline, notification submission state, failure count, next eligible attempt,
last failing stage and error. The version 5 upgrade preserves existing index
rows. Schedule state never substitutes for observing actual owned resources.

A terminal responsibility is saved before cleanup side effects. Herdr records
notification intent before submission and its successful receipt afterward. An
unknown result cannot be replayed. Failure and restart retain the same deadline
and submission decision; restart restores cleanup responsibility and verifies
ownership without starting business execution for an ended claim. Web retains
its own native cleanup operation, result and deadline. Its first cleanup uses
the saved schedule deadline, including after an interruption between the two
database commits; an elapsed deadline leaves zero grace time. Already initialized
Web cleanup keeps its original deadline. cleanup.error keeps its native-result
meaning and does not store scheduler failures.

Claims retry independently after 1, 2, 4, 8, 16, 32 and then at most 60 seconds.
Normal reconciliation starts eligible work without sleeping inside a job or
blocking another claim. Task-level serialization and in-flight cancellation
settlement remain mandatory. Cleanup does not consume business recoveryLimit.
Retry-state access failures are caught within the job error boundary. They retain
both the original cleanup error and the storage error while an in-process retry
record keeps failures bounded. Existing durable cleanup responsibility remains;
an unconfirmed retry write cannot establish that the latest decision survives
restart. Storage errors do not escape as unhandled job rejections that prevent
shutdown from proving native stop.

Active rows, attributed resources, retained cleanup and pending stop confirmation
continue to reserve capacity and the same-task old-claim barrier until actual
cleanup succeeds. Available capacity remains usable by healthy tasks.

Each failed attempt reports its original error and cause, observation/agent-stop/
backend-close/archive/worktree-removal stage, and next retry time. Backend-close
means native stop is confirmed but IPC endpoint or other backend resource closure
is not. Archive and deletion failures also identify the agent as stopped. A full worker emits a capacity diagnostic when
the set of failed cleanup claims changes, including the actual obstruction and
automatic retry after the cause is corrected. Repeated ticks do not emit the
same capacity explanation.

Shutdown cancels and joins running jobs, then proves original agents stopped.
It neither waits for retry eligibility nor repeats archive publication or Git
deletion. Git discovery is not a stop prerequisite. Existing terminal schedules
remain for normal reconciliation. Both unconfirmed native stop and unconfirmed
backend closure fail shutdown, with distinct diagnostics preserving the known
agent-stop result. If Web done was saved before schedule deletion, shutdown
reuses complete stop/close/delete evidence without calling beginCleanup on a
done record or accessing Git. Normal reconciliation still verifies actual Git
resources before clearing the remaining responsibility. Archive failure preserves
the source and never becomes completion.

This decision partially supersedes the process-local cleanup choice in the
[claim record decision](../simplification/2026-10-27-worker-claim-records.md),
[direct shutdown decision](2026-10-28-worker-direct-shutdown.md) and
[project selection decision](../architecture/2026-10-27-worker-repository-selection.md).
Their reasons for a small business index, direct stopping and preparation before
resource work remain valid. The [Web evidence decision](../architecture/2026-10-28-web-execution-evidence.md)
still owns native provenance, and the [SQLite migration decision](../architecture/2026-10-30-cli-sqlite-migrations.md)
owns format admission and atomic conversion. The retired
[detailed local record model](../architecture/2026-10-26-worker-local-records.md)
is not restored.

## Alternatives

**Keep cleanup retry state only in memory.** It bounds repeated failures within
one process but loses the first deadline and notification uncertainty on restart.
The retained schedule is necessary for the cleanup continuity guarantee; actual
resources still determine what remains to do.

**Store scheduler errors in Web cleanup.error.** That field describes the native
cleanup operation. Replacing it with an archive or deletion error conflates the
agent result with later resource finalization and gives Herdr no equivalent
scheduling responsibility. The separate table keeps those meanings distinct.

**Release capacity after the agent stops.** This would let new work run while
failed archives and undeleted worktrees accumulate outside the concurrency bound.
The existing capacity and old-claim barrier therefore remain cleanup invariants.

## Consequences

Persistent failures generate bounded work and actionable diagnostics, while
independent eligible claims can finish. Shutdown latency includes necessary
in-flight settlement and stop proof, not a cleanup turn or retry delay. Removing
the underlying failure allows ordinary reconciliation to converge without a new
recovery command, changed service completion state, or native task replay.

Cleanup scheduling adds a local schema and durable state that must be validated,
kept bound to the original worktree, and removed only after observed success.
Retry times are eligibility thresholds, not exact execution times: the configured
poll interval and resource observations can delay the next attempt. This does not
introduce a timer service or change the service protocol or Web UI.

Controlled-clock and injected-failure regressions establish scheduler behavior;
they do not establish full native-provider, archive transport or production
filesystem acceptance. Those conclusions require separate runtime evidence tied
to the integrated source and actual environment. Production sessions, caches and
worktrees are not destructive test fixtures.
