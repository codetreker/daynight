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
in memory. A restart could repeat cleanup input and restart its ten-minute
budget even when the obstacle remained unchanged. That led to a durable schedule
with notification flags. Current resource observation can establish process or
worktree presence, while Herdr's PTY acknowledgement cannot establish a durable,
queryable input receipt.

## Decision

The [Worker requirements](../../../../docs/spec/daynight-worker.md)
and [design](../../../../docs/design/daynight-worker.md#结束清理与退出)
separate terminal cleanup scheduling from native execution results. Worker state
version 6 introduced cleanup_schedules beside the existing project and claim
index, preserving version 5 project/task rows. The
[resource-state decision](../architecture/2026-11-04-worker-resource-state.md)
partially supersedes its notification ledger: version 7 removes notified and
submitted while retaining each project/task/claim responsibility, worktree ID,
first deadline, failure count, next eligible attempt, last failing stage and error.
Schedule state never substitutes for observing actual owned resources. Targets
without a known worktree ID retain their unfinished claim-index row and use
process-local backoff while rereading authoritative resources. Only a complete
observed owner is eligible for a durable cleanup schedule; no ID is invented.
An ended row with no global resource match still uses the serialized cleanup job
to verify absence and safely remove an empty reservation before local completion.

A terminal responsibility is saved before cleanup side effects. Failure and
restart retain the same first deadline and restore the original cleanup scope
without starting business execution for an ended claim. Web first cleanup uses
the saved schedule deadline, including after interruption between the two store
commits; an elapsed deadline leaves zero grace time. Existing Web cleanup keeps
its original deadline. Web reads native receipts from the Controller journal by
operation identity. Herdr sends one advisory input per bounded cleanup call and
can notify a still-live original agent again after an interrupted call. The
resource-state decision owns that explicit protocol limit and its rationale.

A retained Herdr schedule still requires its private control backend when the
local task is already done and all current configurations use Web. Cleanup and
shutdown initialize that backend before resource observation without starting
business agents; neither local done nor a configuration change releases remaining
responsibility or capacity. Cleanup-only backend initialization stays inside the
eligible claim job. It does not become a global reconciliation prerequisite or
bypass backoff while unrelated Web execution advances. Normal Herdr discovery
still serves configured or ongoing execution; shutdown inspects both execution
and retained cleanup duties and rejects unavailable resource evidence.

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
reserve capacity and the same-task old-claim barrier until actual cleanup succeeds.
Available capacity remains usable by healthy tasks. Each failed attempt reports
its original error and cause, observation/agent-stop/backend-close/archive/
worktree-removal stage, and next retry time. Backend-close means native stop is
confirmed in that attempt but IPC endpoint or other backend closure is not.
Archive and deletion failures likewise preserve their independent stop result.
A full worker emits a capacity diagnostic when the set of failed cleanup claims
changes, identifying the obstruction and automatic retry after its correction.
Repeated ticks do not emit the same explanation.

Shutdown cancels and joins running jobs, then obtains fresh original-process and
backend observations. It neither waits for retry eligibility nor repeats archive
publication or Git deletion. Git discovery is not a stop prerequisite. Existing
terminal schedules remain for normal reconciliation. Both unconfirmed native
stop and backend closure fail shutdown with distinct diagnostics. A completed
Web row cannot supply current stop evidence: the backend observes original OS
process instances and endpoint again without reopening business execution.
Normal reconciliation additionally observes and reconciles remaining Git resources
before clearing responsibility. Archive failure preserves the source and never
becomes completion.

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

**Keep cleanup retry state only in memory.** It bounds failures within one
process but loses the first deadline and retry eligibility on restart. The
retained schedule is necessary for continuity of responsibility and policy;
actual resources determine the remaining cleanup work.

**Store scheduler errors in Web cleanup.error.** At the time this alternative
was considered, that field described a duplicated native operation result.
Using it for archive or deletion failures would conflate separate facts and give
Herdr no equivalent scheduling responsibility. Current native receipts belong
to the Controller journal, while the separate schedule owns retry diagnostics.

**Release capacity after the agent stops.** New work could run while failed
archives and undeleted worktrees accumulate outside the concurrency bound. The
capacity reservation and old-claim barrier therefore remain cleanup invariants.

## Consequences

Persistent failures generate bounded work and actionable diagnostics, while
independent eligible claims can finish. Shutdown latency includes necessary
in-flight settlement and fresh stop proof, not a cleanup turn or retry delay.
Removing the underlying failure lets ordinary reconciliation converge without
a new recovery command, changed service completion state, or native task replay.

Cleanup scheduling adds durable policy and responsibility that must remain bound
to the original worktree and be removed only after observed success. Retry times
are eligibility thresholds, not exact execution times: the configured poll
interval and resource observations can delay the next attempt. This does not
introduce a timer service or change the service protocol or Web UI.

Controlled-clock and injected-failure regressions establish scheduler behavior;
they do not establish full native-provider, archive transport or production
filesystem acceptance. Those conclusions require separate runtime evidence tied
to integrated source and the actual environment. Production sessions, caches and
worktrees are not destructive test fixtures.
