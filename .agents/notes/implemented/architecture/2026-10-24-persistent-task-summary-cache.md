# Agent Note: Persistent Task Summary Cache

Status: implemented

## Problem

Visible project pages repeatedly transfer complete task graphs, while their
component caches disappear on navigation. Persistent summaries can reduce that
transfer, but they must preserve complete dependency-derived state, exact task
versions, current access checks and atomic coverage. A delayed response or another
tab must not replace newer durable content or revive an invalidated identity.

## Decision

The browser uses the time-window task-sync resource for project views. It stores
intrinsic summaries and the greatest exact accepted summary updatedAt in one
IndexedDB transaction, merges against the transaction's current complete set by
task ID and business version, and derives readiness, blockers, statistics and the
existing GraphIndex locally. Network decoding and authentication happen outside
the transaction; publication follows transaction completion. Equal versions must
have identical intrinsic content. Older rows cannot advance coverage.

The origin-local daynight-task-cache database uses schema 1 and idb 8.0.4. Its
userScopes store owns durable user fences; projects owns project manifests and
cache generations; summaries owns intrinsic task rows; details establishes the
shared intrinsic-detail record and transaction shape. Manifest counts, edges,
maximum time, ownership and graph validity are checked against the complete
durable collection before applying a delta. Missing independent rows are
corruption, even when the remaining graph is valid. Central lifecycle validation
also checks invalidated manifests: ownership and canonical fences/generations
must match, the reason is recognized, epoch/Project/watermark are null, and both
counts are zero. An invalidated record cannot preserve an old incremental epoch.

Missing or malformed user scope records require a user-wide repair because their
fence guards every project owned by that user. One dedicated transaction replaces
the fence without parsing the damaged value, clears that user's summaries/details
and invalidates its rebuildable project baselines. Other users remain intact.
Binding memory, retiring scopes and broadcasting wait for transaction completion.
An unbound scope then binds the new fence and resumes; a bound scope retires and
requests identity verification instead of adopting a replacement lifetime. Failed
repair rolls back, retains a live retry path and exposes the storage failure.
All data entrypoints use this lifecycle check, and stale tickets or scopes cannot
publish across the replacement after commit.

TaskCacheScope belongs to the authenticated user/session generation and spans
project, standalone task and attachment routes. Every mounted project view needs
its own successful authenticated sync before publishing private cached content.
The foreground identity gate also covers local reads and publication. A valid
different response principal invalidates the scope and immediately releases the
old authenticated UI. An absent or malformed principal is a protocol error;
only a verified same-user not_found response can revoke project content.
Invalidation rotates durable fences or generations before future work can be
accepted, and logout releases memory synchronously while storage cleanup runs.

Visible-page five-second scheduling, automatic serialization and manual-refresh
priority retain their existing owner. Duplicate or empty results update the
mount's successful clock receipt without rewriting rows, invalidating detail
records, replacing the published graph index or broadcasting. Hints carry only a scope
and project; already-authorized receivers read the committed stores and do not
start another network cycle. Timestamp comparison preserves UTC seconds and all
nine fractional digits. Task and settings versions remain bigint values.

The [time-window API decision](2026-10-24-task-summary-window-api.md) owns server
selection, epochs and response provenance. The
[requirements](../../../../docs/spec/daynight-task-sync.md) and
[architecture](../../../../docs/design/daynight-task-sync.md) own complete current
contracts. This implements the summary portion of the
[timestamp-window decision](2026-10-24-task-view-timestamp-window.md)
and replaces the transport portion of the
[automatic-refresh decision](../feature/2026-10-22-project-task-auto-refresh.md).

## Alternatives

**Keep complete graphs or add conditional HTTP responses.** Conditional bodies
can avoid some unchanged transfers, but a changed project still downloads its
whole graph and has no persistent per-task merge base. The selected feed reuses
the existing bounded graph model after merging intrinsic task facts.

**Use timestamp equality as a local compare-and-swap token.** Distinct task
versions and separate tasks can share a timestamp. Reading the current durable
set inside the serialized write transaction preserves both without another
local commit counter.

**Use Dexie live queries or a second UI store.** Rich observation machinery
would add another publication owner beside existing graph snapshots and detail
sessions. A thin idb wrapper preserves explicit transaction and component
ownership.

**Enable persistent detail reuse with summary transport.** Detail freshness,
mutation reconciliation and memory/disk budgets have independent behavior. Their
integration was kept additive by establishing the details store, intrinsic type,
lifecycle checks and exact summary-version signal with summary transport. The
[detail-cache decision](2026-10-24-task-view-timestamp-window.md) now connects the
separate content, freshness and eviction policy to the same scope.

## Consequences

Navigation retains a durable summary base while online access remains mandatory
before private publication. Each apply can read and validate the full bounded
local set; its local work is not guaranteed proportional to the changed rows.
The accepted tail window can still repeat indefinitely. Storage failures remain
visible through existing error and Retry states, with an allowed current view
retained; there is no silent network-only fallback.

Native browser evidence is required for persistence, transaction failure and
cross-tab behavior; fake-indexeddb supplies deterministic unit coverage without
claiming browser scheduling or disk guarantees. The existing graph limits and
four-dataset interaction budgets remain. Detail LRU, live-GET admission and
change-driven detail refresh are implemented by the detail-cache owner. The
current GraphSnapshot revision remains a mount-local successful-read receipt,
not a persistent revision or task version.
