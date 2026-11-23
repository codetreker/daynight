# Agent Note: Goal Summary Admission

Status: implemented

## Problem

Goal acceptance prerequisites and ordinary Task execution prerequisites belong
to separate graphs. A typed project summary can carry Goal edges, while Goal
detail and write receipts expose no acceptance edges. Treating every dependency
array alike either rejects legitimate Goal summaries or lets a title or status
receipt erase synchronized relationships.

## Decision

The Web synchronization parser interprets `dependsOn` by resource type. A Goal
summary accepts project-local acceptance prerequisites and requires an empty
`externalDependsOn`. Ordinary Task dependency rules remain unchanged. The typed
summary collection retains Goal edges; the ordinary graph is built only from
ordinary Tasks and their execution dependencies.

Confirmed Goal write projections compare only fields covered by the detail
receipt. Both same-version comparison and the before-write baseline comparison
retain the current synchronized dependency arrays. A newer receipt can update
its covered view fields without replacing Goal edges or advancing the durable
synchronization watermark. Summary-to-summary comparisons still require equal
intrinsic content at equal versions.

The Server continues to emit empty Goal dependency arrays, and the browser disk
schema remains 13. Enabling the batch reader's public output requires a paired
summary rebuild so cached empty edges cannot conflict with same-version
synchronized edges. The [synchronization design](../../../../docs/design/daynight-task-sync.md)
owns protocol and projection details; the [batch reader decision](2026-11-23-goal-prerequisite-batch-reader.md)
owns the snapshot-scoped storage capability.

## Alternatives

**Compare Goal detail dependencies as complete summary content.** The detail
response's empty placeholder would reject a legitimate same-version summary
containing acceptance edges and prevent title or status receipt projection.

**Replace synchronized edges from the Goal detail receipt.** Such a receipt does
not observe acceptance relationships. Using it as an edge update would clear
valid edges until another project synchronization restores them.

**Activate Server output before rebuilding existing summaries.** Existing caches
can contain empty Goal edges at the same business version. Strict equal-version
summary comparison would correctly reject the differing adjacency sets.

## Consequences

The Web can retain typed Goal adjacency without changing ordinary Task graph or
readiness semantics. Goal metadata receipts update the immediate view while the
project synchronization remains the sole owner of these edges. Parser and
projection tests cover nonempty and empty Goal edges, receipt updates and actual
covered-field conflicts. Existing Server output and persisted cache format stay
usable during this consumer preparation.
