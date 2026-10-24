# Agent Note: Timestamp Windows for Project Task Views

Status: proposed

## Problem

The timestamp-window proposal addressed repeated complete-graph transfers and
navigation-local component caches while preserving business versions, identity
boundaries and graph semantics. The server feed and persistent summary cache now
provide those mechanisms. Complete details still follow successful project-sync
receipts even when the task version is unchanged, and their successful bodies do
not yet survive navigation as a bounded intrinsic-detail cache.

## Proposal

Complete the remaining intrinsic-detail integration using the existing summary
cache scope, details store and guarded detailTransaction. Persist only intrinsic
content and materialize ready/blockedBy from the current complete projection.
Opening a detail may display a matching cached version after online project
admission, but a live GET is still required before mutation authority. Repeated
unchanged summaries should not trigger periodic detail GETs. A newer detail or
mutation response triggers project synchronization without advancing its watermark.
Confirmed remote mutation outcomes remain distinct from persistence success, so
cache errors cannot cause an operation to be replayed.

Use the confirmed per-project budgets of 32 details and 8 MiB, with a 2 MiB
single-record limit and UTF-8 byte accounting. Large successful details remain
visible in the active session without persistence; actual storage failures remain
visible errors. Attachments retain their independent reads and mutations.

The adopted summary and server portions remain the basis for this integration:

Use the greatest exact updatedAt among accepted project-sync summaries as the
next request's since value. The server queries updated_at >= since - overlap,
with DAYNIGHT_TASK_SYNC_OVERLAP defaulting to 10s. Only successfully applied
project-sync summaries establish coverage; detail GETs and mutation responses
do not advance this watermark.

Preserve the current three task states and the nullable requiredPlatform field
in summaries, dialogs and standalone task/attachment surfaces.

Keep updatedAt in its existing business transaction. Reuse business task
versions for duplicate and stale-row merging. Each IndexedDB write transaction
reads the current durable summaries, merges by ID/version, validates the graph,
and atomically saves changed facts and their maximum time. Timestamp equality
alone is not a content CAS token.

One project cache epoch remains solely for supported restore/import invalidation.
Normal writes do not change it. Local user and project lifetime fences prevent
late work from restoring content after identity or project invalidation.

The [requirements](../../../../docs/spec/daynight-task-sync.md) own behavior;
the [architecture](../../../../docs/design/daynight-task-sync.md) owns the protocol.
The [rejected revision proposal](../../rejected/architecture/2026-10-24-task-view-incremental-cache.md)
preserves why transactional counters were considered.

The [server summary API](../../implemented/architecture/2026-10-24-task-summary-window-api.md)
implements selection, epochs and response provenance. The
[persistent summary cache](../../implemented/architecture/2026-10-24-persistent-task-summary-cache.md)
implements browser storage, local projection, exact versions and shared lifecycle
boundaries. Only detail content reuse, freshness and eviction remain proposed;
their runtime delivery must include their own behavior and failure evidence.

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

## Acceptance Criteria

Matching detail bodies survive close/reopen under the same authorized scope,
while opening still performs a live GET before enabling writes. Unchanged summary
versions do not schedule repeated detail GETs; prerequisite-only changes update
derived state without downloading all successors. Exact-version conflicts,
unknown mutation results, stale responses and persistence failures retain the
existing write/reconciliation guarantees. Native tests prove reload, eviction,
failure and identity behavior. Project-sync watermarks remain independent, and
existing graph and interaction budgets remain.

## Risks

The last overlap window can be transmitted indefinitely when writes stop;
large batches in that window can repeat many rows. This cost is accepted and
must be measured, not hidden by a zero-record acceptance rule. The correctness
argument relies on the existing project writer serialization and normal database
time. Wall-clock rollback and bypassed maintenance require recovery policy;
supported history replacement rotates epochs before service resumes.
