# Agent Note: Timestamp Windows for Project Task Views

Status: proposed

## Problem

The browser repeatedly downloads complete project task graphs and loses its
component cache on navigation. A persistent summary cache needs a way to read
updates while preserving existing task versions, identity boundaries and graph
semantics. The selected scope accepts overlapping responses and client deduplication.

## Proposal

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
implements the window/epoch and response-provenance portion. Browser persistence,
local projection and intrinsic detail integration remain proposed; server API
availability does not establish their runtime delivery.

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

The server subtracts the configured positive duration from the unadjusted
client task watermark. Ties and duplicate rows merge by existing business
version without duplicate persistence or layout work. Native tests cover
current-durable-set merging, delayed same-timestamp responses, interval bounds,
empty project baselines, identity fences, restore epochs and actual window
transfer volume. Existing graph and interaction budgets remain.

## Risks

The last overlap window can be transmitted indefinitely when writes stop;
large batches in that window can repeat many rows. This cost is accepted and
must be measured, not hidden by a zero-record acceptance rule. The correctness
argument relies on the existing project writer serialization and normal database
time. Wall-clock rollback and bypassed maintenance require recovery policy;
supported history replacement rotates epochs before service resumes.
