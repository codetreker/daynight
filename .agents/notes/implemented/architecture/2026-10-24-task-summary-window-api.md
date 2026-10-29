# Agent Note: Time-Window Task Summary API

Status: implemented

## Problem

The project dashboard repeatedly reads a complete task graph. A persistent browser
summary cache needs a bounded, authenticated feed of current task facts without
fetching descriptions or duplicating dependency-derived state. The feed must
preserve task-write atomicity, project authorization and the existing graph size
contract while remaining usable after database history replacement.

## Decision

The service exposes GET/HEAD task-sync beside the complete graph. An absent or
changed project epoch returns a complete snapshot; a matching epoch returns a
delta selected by updated_at >= since - overlap, or all rows when since is
absent for an empty baseline. The server owns a positive Go-duration overlap,
configured by DAYNIGHT_TASK_SYNC_OVERLAP with default 10s. Normal task writes
retain their existing business versions and timestamps.
[Task soft deletion](../feature/2026-10-25-task-soft-deletion.md) excludes marked
rows and atomically rotates the project epoch, causing a complete replacement
without changing the summary wire format.

NewTaskSync receives the validated duration at composition and uses one existing
read-only repeatable-read transaction for membership, Project, epoch, full graph
size, intrinsic summaries and observedAt. Domain refusals are returned only after
successful transaction completion. Task versions become decimal strings at the
API boundary. The summary preserves the current three states, execution platform,
Agent permission, timing and both dependency sets, without descriptions,
complete properties or derived readiness. The
[attention-signaling decision](../feature/2026-10-29-worker-attention-signaling.md)
adds the compact workerNeedsAttention boolean; full signal text and execution
identity remain with the complete task. Nanosecond lower bounds are rounded upward to
PostgreSQL microseconds before pgx binding to preserve the exact inclusive set.

The existing project lock is acquired before assigning task statement timestamps.
Under normal nondecreasing database time, the maximum task time actually consumed
by a project-sync reader cannot overtake an older pending same-project writer.
Request time and observedAt do not establish that coverage. Overlap records can
repeat indefinitely and may include most tasks after a dense update; this cost
is accepted. Reads still perform full graph capacity checks.

Migration 015 gives each project a stable task_cache_epoch and indexes task
project/time/ID. Normal writes and restarts preserve epochs. Supported restore,
import or history replacement stops writers, restores data, rotates affected
epochs, and only then resumes service. A backed-up UUID itself cannot detect a
restore. Future-dated imported rows and clock faults need their maintenance
assumptions restored separately; changing an epoch does not repair timestamps.

Authentication.Require emits Daynight-User-ID from the admitted principal before
resource handlers run. Empty mutation responses and later resource errors retain
it; failed authentication emits no unadmitted identity. Request values cannot
control it, and Bearer precedence remains authoritative. The header proves
response provenance rather than granting access.

The [requirements](../../../../docs/spec/daynight-task-sync.md) and
[architecture](../../../../docs/design/daynight-task-sync.md) own the protocol.
This delivers the server portion of the
[browser-cache decision](2026-10-24-task-view-timestamp-window.md).
The [persistent summary cache](2026-10-24-persistent-task-summary-cache.md) consumes
this feed and derives complete project views locally. The
[detail-cache decision](2026-10-24-task-view-timestamp-window.md) supplies intrinsic
detail persistence and version-driven reads within the same scope.

## Alternatives

**Continue complete graphs or add conditional HTTP bodies.** A changed project
would still transfer its entire graph, and a conditional validator alone would
not provide task facts for a persistent incremental store.

**Assign project/task synchronization revisions or retain a change log.** They
can avoid repeated tail rows and provide an independent logical order, but add
per-write assignment or history/retention machinery. The selected bounded cache
consumer accepts repeated timestamp-window rows and uses existing business data.

**Advance from request time or update timestamps after committing data.** Request
time can pass a still-uncommitted change. A second timestamp transaction creates
a crash gap after the business commit and requires recovery machinery. Neither
is needed when data and its existing task timestamp remain atomic.

**Infer response ownership from the previous /me call.** Another browser window
can replace cookies between requests. The actual authenticated response identity
is available at the existing middleware boundary and avoids guessed ownership.

## Consequences

The API supplies latest bounded task summaries without changing existing task,
complete-graph or CLI resources. The API itself introduces no event history,
deletion feed, background cleanup or new task execution authority; browser
persistence belongs to the summary-cache decision. Future task
deletion must add removal semantics or invalidate the project epoch.

Validation covers real PostgreSQL snapshots, equal/submicrosecond boundaries,
long lock waits, rollback/completion failure precedence, stable/restored epochs,
precise int64 output and authenticated HTTP behavior. Source-bound gate and
restoration observations belong to their actual delivery artifacts, not this
note as a claim of universal runtime performance.
