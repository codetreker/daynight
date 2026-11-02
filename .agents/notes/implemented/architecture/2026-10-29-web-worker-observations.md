# Agent Note: Account-scoped Web Worker Observations

Status: implemented

## Problem

A machine may report while it has no task, and an account can own Workers across
several projects. Project-list success cannot authorize or locate that runtime
view. The browser also cannot infer that a Worker stopped reporting from its own
network failure: an old server observation remains historical evidence, not a
fresh liveness result. Partial pagination and late responses can otherwise mix
incomplete collections or different account/resource lifetimes.

## Decision

The authenticated workspace exposes peer My projects and My Workers navigation.
`/workers` and `/workers/{workerId}` use page-local memory inside the existing
user/generation lifetime. Their strict typed API admits the response principal
before either success parsing or 404 handling. The existing TaskCacheScope
provides only authentication lifetime, foreground readiness and identity-mismatch
invalidation; Worker observations do not enter project storage or IndexedDB.
Resource keys and cancellation include Worker ID as well as account lifetime.

One visible page owns a single-flight five-second reader and one one-second
ticker. A list read traverses all stable cursors privately, then atomically
publishes the collection. Any failed page retains the previous complete result.
The last response's database observation and paired monotonic receipt anchor
online and recent-visibility calculations independently of browser wall time.

Failure, hidden state and identity checking freeze the last published time and
mark retained observations stale. Only a fresh successful read resumes current
liveness calculations. This distinguishes the Worker's report age from the
browser's ability to observe newer reports. Retained badges and task captions
identify the last confirmation; a warning and retry action require an actual
read failure, as owned by the
[quiet recheck decision](../bug-fix/2026-10-30-quiet-worker-rechecks.md).
An admitted current-account 404
clears detail; unknown inventory, observed idleness and stale task snapshots
keep their distinct semantics. The
[Web design](../../../../docs/design/daynight-web.md#我的-worker-列表与详情)
owns the mechanism, and the
[requirements](../../../../docs/spec/daynight-web.md#我的-worker) own its
observable behavior.

The [account snapshot decision](2026-10-28-worker-runtime-snapshots.md) retains
ownership of normalization, current permission filtering and historical task
semantics. The [runtime reporting decision](2026-10-28-worker-runtime-reporting.md)
owns the producer. Web displays actual returned fields, keeps unavailable probes
explicit and uses real task links; it does not reconstruct filtered task data
from other caches or acquire task-control authority.

## Alternatives

**Persist Worker data in the project cache.** Workers are account resources,
including idle machines with no project task. Project cache admission and local
persistence would add a second private-data lifecycle without supplying current
Worker evidence. Page-local memory preserves the existing account fence and
keeps the query independent of project loading.

**Reuse the task execution clock's full lifecycle.** Its monotonic arithmetic is
useful, but advancing a pre-sleep anchor immediately on visibility return would
present an unverified Worker state as current. Worker observation therefore
reuses the arithmetic with its own freeze-and-refresh lifecycle. A task's
elapsed-time display retains the separate semantics owned by its
[timing decision](2026-10-23-task-timing-design.md).

**Publish each list page as it arrives.** A later-page failure would replace a
previously complete account view with a partial one. Private traversal costs
memory proportional to one additional collection while refreshing, but permits
one coherent replacement and a useful retained result on failure.

## Consequences

Idle and busy Workers share one account page without extra per-row detail reads.
One page-level ticker updates all badges and expiry boundaries while stable
React identities preserve still-present keyboard targets. Current project access
continues to filter both saved task rows and counts on the service.

The view retains at most its current complete observation and the in-flight
replacement. Reads can lag reporting by the five-second polling cadence, and a
failed or suspended browser deliberately shows last-confirmed state until a
fresh read succeeds. The page retains no Worker data after its account lifetime and cannot reconstruct
earlier reports. Frontend fixtures and screenshots cannot establish
real collection or combined Server/CLI/Web acceptance.
