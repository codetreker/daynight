# Agent Note: Timestamp Windows for Project Task Views

Status: implemented

## Problem

Project pages originally downloaded complete graphs on every poll and lost their
component cache on navigation. The timestamp-window API and persistent summaries
address that transport, while complete details still need their own reusable
content and freshness policy. A successful project clock receipt does not imply
changed detail content. Persistent detail reuse must preserve live mutation
admission, dependency-derived state, exact versions and known remote outcomes.

## Decision

The [summary API](2026-10-24-task-summary-window-api.md) selects current task facts
using the greatest accepted summary updatedAt minus the configured overlap. The
[persistent summary cache](2026-10-24-persistent-task-summary-cache.md) atomically
merges those facts by business version and derives complete views. Detail GETs
and mutation responses cannot advance this coverage watermark. The
[rejected revision proposal](../../rejected/architecture/2026-10-24-task-view-incremental-cache.md)
preserves why transactional counters were considered before task-time windows
were selected.

The existing TaskDetailSessions uses that same authenticated cache scope and
details store. It persists intrinsic complete task content, including exact
version and all current properties, while materializing ready and blockedBy from
the current complete projection. Opening a detail can display a matching durable
body after this mount's online project admission while the scope still authorizes
the current generation, but still performs a live GET
before enabling writes. Each admitted opening records its live-read demand before
pending/unknown/reconciling operations can delay it. An in-memory opening
generation binds the required GET; disk, mutations, no-op/refused responses and
pre-opening reconciliation cannot satisfy a later opening. Duplicate polling
receipts create no opening. Current summary version and project generation drive
content refresh; repeated successful clock receipts do not invalidate matching
content. Errors, raw graph disagreements and required reconciliation retain
explicit GET recovery paths.

Network results carry the lifecycle ticket captured before dispatch. Guarded
transactions compare the current summary and stored detail versions before
installation. Older bodies cannot replace newer content. The feed exposes
current task rows and may skip intermediate business versions. A newer GET
waits while its version is ahead of the summary and is admitted on an exact
match. If the summary overtakes a pending payload, the session discards that
payload and queues the required GET with its original purpose. Ordinary detail
reads retain their visible read-error/Retry path; mutation reconciliation retains
its operation intent, phase and recovery path. A successful GET clears its own
blocking read state without rewriting the original operation outcome. Failed or
still-stale reconciliation releases active reconciling and keeps Check state
usable. Pending admission failures obey the same purpose and current-generation
checks, so an old failure cannot poison a newer read. Duplicate receipts do not
form an automatic reconciliation loop, and explicit Retry only reads. A validated confirmed write can display its raw body
after guarded lifecycle checks while remaining stale and write-disabled, without
persisting it ahead of the summary or changing the project watermark. A new
project generation immediately clears the old detail body, PR data and loaded
observation, cancels old reads/payloads, and resets freshness and committed-version
floors. A render-time check hides the old body before observation effects. Equal
task IDs, business versions and timestamps cannot preserve authority across
history replacement, even when the new GET stalls or fails. Operation intent and
confirmed/unknown phase markers normally survive; canceled reconciliation becomes
available for explicit GET recovery. Reopening a deleted entry in a restored
history resets mutation ownership and requires a fresh GET. Its old intent cannot
occupy or overwrite the restored history's mutation state, and delayed outcomes
still require the current operation owner and history admission. Same-generation refreshes retain their successful body. Server-derived disagreement is checked before local
materialization and kept as stale evidence until the projection/read converges;
changing a prerequisite need not fetch every successor's intrinsic body.

Details are bounded per project to 32 records, 8 MiB total and 2 MiB per record,
using the UTF-8 bytes of exact intrinsic JSON. Reads update lastUsedAt; insertion
evicts the oldest details with task ID as the tie-breaker. Equal intrinsic saves
perform no duplicate write. A successful oversized body remains readable in the
session without persistence. Corrupt detail records or aggregates clear only the
project's details in a guarded transaction, then expose the original error and
Retry. Summary manifests and coverage remain unchanged.

Authenticated task responses prove their actual principal before parsing or
resource-error handling. A same-user HTTP 200 confirms the remote write response
separately from payload validation and cache installation. Malformed payloads
require GET-only readback; cache failures preserve the confirmed operation and
visible error without replaying it. Existing pending/unknown/reconciling state,
committed-version floors and exact write gates remain with the detail session.
A verified same-principal not_found withdraws project reuse when a detail GET
started for a known summary task, or when a task write reports
it. Unknown task IDs remain local missing-resource errors. canRevokeProject checks
the captured user fence and generation before the session clears content;
revokeProject immediately retires that generation's admission and publishes an
access event. A late old-generation 404 cannot clear a replacement generation.

Scope-owned cleanup outlives the observing dialog. Its existing RW transaction
purges summaries/details only when the durable user fence and manifest generation
still match the captured ticket. Failure keeps memory denied and visible Retry;
beginSync retries pending cleanup before a fresh online sync can grant display.
Generation checks fence cache transactions and result publication, without
snapshot-descendant tracking or a promise to purge unrelated/new generations.
Negative hints bind user fence and generation, can deny a cold peer without a
projection, and cannot replace a newer denial. They withdraw reuse immediately,
including while auth is paused; persistence still waits for the identity gate.
Positive hints remain post-commit store rereads and provide no access grant.

Closing a dialog releases ordinary reads. Disposing TaskDetailSessions does not
end an authentication scope: navigating to invitations can remove the detail UI
while a submitted write is still pending. A trusted not_found response therefore
performs ticket-bound scope withdrawal before disposed-UI handling. The released
session retains its refusal intent/error and clears its body without notifying
its UI listeners, starting GETs or replaying a write. Ending the identity scope
still takes precedence, and stale tickets cannot withdraw a replacement history.
Submitted writes and project cleanup retain those scope ownership and identity
fences beyond their observing UI.

The [requirements](../../../../docs/spec/daynight-task-sync.md) own behavior and
the [architecture](../../../../docs/design/daynight-task-sync.md) owns the current
algorithm, storage, failures and interfaces.

## Alternatives

**Transactional project and task sync revisions.** They avoid dependence on
wall clocks and allow unchanged polls to contain no task rows, but introduce
new per-write revision assignment and cursor contracts. The selected bounded
cache scope accepts repeated rows to reuse existing timestamps.

**Request-time watermarks.** A time recorded for the request or response can
advance past a still-uncommitted task update. A fixed overlap alone does not
establish a transaction-duration bound. The selected watermark comes from task
records actually accepted by the project synchronization channel.

**Post-commit timestamp updates.** Splitting the data and its marker leaves a
crash gap. Repair needs a durable pending-work protocol and another transaction.
The existing atomic task update remains unchanged.

**Append-only logs or push transport.** They add history, retention or connection
ownership beyond the current latest-state, five-second polling requirements.

## Consequences

Five-second summary synchronization retains the accepted repeated tail window,
including potentially dense batches. Intrinsic detail GETs now follow actual
versions, openings and recovery needs rather than every receipt. Local derived
state can update without downloading unchanged successor bodies. This preserves
the existing graph and interaction budgets without claiming local work is always
proportional to changed records.

Persistent content remains an online acceleration cache. Neither a disk match nor
a previous mount's access grants current mutation authority. LRU eviction and
oversize policy affect later cache hits, while actual storage errors stay visible
and block unsafe writes until recovery. Failed detail cleanup or saving retains
transaction failure semantics; confirmed remote operations are never silently
reclassified as unsubmitted.

The protocol still relies on the existing project writer serialization and
normal database time. Wall-clock rollback and bypassed maintenance require the
recovery policy; supported history replacement rotates epochs before service
resumes. [Task soft deletion](../feature/2026-10-25-task-soft-deletion.md) rotates
the same epoch inside its write transaction. Its distinct `410 task_deleted`
response removes only the task and does not revoke project admission. Deletion
terminals obey the project cache generation: supported recovery may restore a
live task with the same ID, requiring a fresh GET after a later authorized snapshot
restores both node and summary. All status, permission, platform and deletion
outcomes share operation-owner and history admission checks. Delayed old-history
results cannot change restored details, replace a newer mutation's feedback or
release its shared write lock; existing principal and project-revocation checks
retain their captured scope/ticket protections. Native browser persistence,
network counts, failure and identity evidence remain necessary alongside deterministic tests. Attachments retain their
independent reads, mutations and preview lifetime.
