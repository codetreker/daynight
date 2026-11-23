# Agent Note: Work Snapshot Targets

Status: implemented

## Problem

A Work overview can contain several matching ongoing Tasks in the same ordinary
dependency component. Expanding the component separately from each matching Task
repeats the same graph work. Reconstructing selected components for each source
batch repeats it again, even though the request already rejects changes to its
Task graph fence. Sparse-owner requests also need to avoid unrelated components.

## Decision

The initial authorized repeatable-read snapshot computes one deduplicated
reachable set from all matching ongoing Tasks. A specified group starts from its
own ID and validates both its minimum-UUID identity and a matching ongoing owner.
The reachable vertex array also bounds a streamed edge query. Shared pure
`utils/graph` disjoint sets assign each vertex its component's minimum UUID.
SQL aggregates, orders and pages the member mapping in the same snapshot.

After excluding the lookahead group, that snapshot returns every ongoing target
key in the selected groups, ordered by group and Task ID, including other owners.
The request retains these keys and reads at most 200 exact keys per fresh
snapshot. Each batch reauthorizes and checks the original Task graph fence before
reading Task projections and lightweight Session sources. Returned keys must
match the selected keys completely. No source batch expands dependencies.

The [observation design](../../../../docs/design/task-session-observation.md)
owns sampling, source rechecks, target preview cursors and response fitting. The
[observation decision](../feature/2026-11-10-task-session-observation.md) retains
the released-snapshot consistency model and partial-result semantics.

## Alternatives

**Repeat traversal for each matching seed and batch.** This was the original
query mechanism. It avoids retaining the complete target key list, but pays for
identical component expansion many times while already enforcing a stable graph
fence. Shared seed deduplication and exact-key batches remove that repeated work.

**Persist component membership.** Edge removal, reclassification and effective
Task deletion can split or merge components. Maintaining stored labels requires
write-side invalidation, reconstruction and freshness rules. Snapshot-local
computation retains the existing graph and cursor semantics without that state.

## Consequences

Graph computation scales with reachable vertices and edges rather than matching
seed count multiplied by component size. Subsequent batches use direct Task keys.
Unrelated components are excluded by the initial sparse reachable query.

The request retains one key per selected ongoing member. Graph and target-key
memory therefore grows linearly with reachable vertices and selected contributors.
Session source batches and response previews keep their existing bounds; every
target continuation still recomputes the complete group summary. The original
fence, permission and source rechecks remain necessary because no transaction
spans live sampling.
