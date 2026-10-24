# Agent Note: Incremental Project Task Views

Status: rejected — Task timestamp overlap selected for the bounded view cache.

## Problem

The visible project page repeatedly downloads the complete task graph. Its
component cache reduces index reconstruction after decoding but does not reduce
transfer or survive navigation. Graph readiness depends on prerequisite state,
while descriptions and pull-request properties belong to separate task reads.
A cache based only on task timestamps would miss both transaction-order gaps and
changes to derived readiness.

## Proposal

Use the existing project write lock to assign transactional project revisions
and stamp each changed task with its latest project revision. Read one bounded
snapshot or delta, persist task facts and cursor atomically in IndexedDB, and
reuse the existing graph model for local readiness, statistics and chain
projection. Preserve five-second visible-page polling and online authority.

The [requirements](../../../../docs/spec/daynight-task-sync.md) own behavior and
the [architecture](../../../../docs/design/daynight-task-sync.md) owns protocol,
identity provenance, durable scope fences, detail caching and recovery. The transactional-revision option was considered for the proposed runtime;
the delivered application still uses the existing complete-graph refresh
contract. The [timestamp-window decision](../../proposed/architecture/2026-10-24-task-view-timestamp-window.md)
selects an overlapping task-time query for this scope and accepts repeated rows.

## Alternatives

**Complete graph with conditional HTTP requests.** It can avoid unchanged
response bodies but still transfers the complete graph after any change and
needs a reliable content validator. It does not provide persistent incremental
state by itself.

**Append-only project change log.** It supports event history and deletion
replay, but the current consumer needs only latest bounded task state. Historical
storage, retention and cleanup would add lifecycle obligations without serving
a confirmed consumer.

**Timestamp-based deltas.** A response-time watermark minus one second can
permanently skip a transaction that remains uncommitted beyond that overlap.
Using only the maximum task timestamp actually returned is a different option:
the existing project lock orders official task writers, so that variant can be
lossless under a nondecreasing database-clock assumption and inclusive,
full-precision reads. It still needs reset rules for clock rollback or restored
history, and repeatedly transfers the final overlap window when writes stop.
The transactional revision avoids those clock and repeated-transfer assumptions.

**Update the timestamp after committing task data.** A process can exit after
the data commit but before the independent timestamp commit, permanently hiding
the change from timestamp-based synchronization. Reliable repair requires a
pending marker in the first transaction and a recovery protocol. The timestamp
update itself also commits after its SQL statement assigns the time. Keep the
change-discovery marker atomic with task data.

**Dexie live queries.** They provide richer query and observation machinery,
but the existing graph snapshot and detail sessions already own publication.
Use the smaller idb transaction wrapper while retaining explicit ownership.

## Acceptance Criteria

The design must define a consistent bootstrap and delta boundary, complete
mutation integration, local derived fields, exact task versions, authenticated
response provenance, atomic IDB commit, cross-tab ordering and account/project
invalidation. Restore and raw-import procedures must rotate epochs before
reopening service. Tests must compare local projections with the authoritative
complete graph and prove native browser persistence and failure behavior.

Architecture acceptance does not establish runtime delivery. Implemented facts
and affected active documents must change with the implementation that proves
them.

## Risks

The latest-row protocol assumes no physical task deletion within an epoch.
Future deletion needs tombstones or an epoch replacement. Database restoration
also restores a stored epoch; failure to rotate it before revision regrowth can
silently preserve divergent cache state. Missing mutation stamping or publishing
before transaction completion breaks cursor correctness. Persisted data remains
private account data and must never become authorization evidence.
