# Agent Note: Goal Summary Admission

Status: implemented

## Problem

Goal acceptance prerequisites and ordinary Task execution prerequisites belong
to separate graphs. A typed project summary can carry Goal edges, while Goal
detail and write receipts expose no acceptance edges. Treating every dependency
array alike either rejects legitimate Goal summaries or lets a title or status
receipt erase synchronized relationships. Existing browser summaries can also
contain empty Goal edges at the same business version as a new complete result.

## Decision

TaskSync returns each selected Goal's complete direct same-Project acceptance
prerequisites in `dependsOn`, with `[]` for no edges and `[]` in
`externalDependsOn`. `core/task.ReadSync` collects only the Goal IDs actually
selected by the existing snapshot or delta window and reads their prerequisites
once through the same snapshot-bound reader. Target Goals need not occur in the
window. Read and transaction failures reject the complete result. Cross-Project
Goal relationships retain their independent authorized reader.

The Web synchronization parser interprets `dependsOn` by resource type. The
typed summary collection retains Goal edges; the ordinary graph is built only
from ordinary Tasks and their execution dependencies. Goal edges do not enter
ordinary dependency states or Task readiness.

`sameDetailSummary` compares only fields covered by a detail response for both
detail cache admission and confirmed write projections. Same-version receipt
comparison and the before-write baseline comparison follow the same rule. A
newer Goal receipt updates its covered view fields while retaining synchronized
dependency arrays and the durable synchronization watermark. Summary-to-summary
and detail-to-detail comparisons still require equal intrinsic content at equal
versions.

The browser's schema 14 upgrade atomically clears project manifests, summaries,
details and their watermarks, including structurally valid schema 13 Goal
summaries with incomplete empty edges. It preserves user identity fences,
profiles and compatible Session history under the existing upgrade rules. The
next ordinary project read obtains a full snapshot; reopening schema 14 retains
the rebuilt data. Server output and the matching embedded Web ship together.
Old relationship writers that do not touch Goal Task versions and update times
must exit before enabling the output, and existing pages refresh to load the
matching consumer. No URL, epoch/since, watermark or polling change is required.

The [synchronization design](../../../../docs/design/daynight-task-sync.md)
owns protocol, deployment and cache lifecycle details; the
[batch reader decision](2026-11-23-goal-prerequisite-batch-reader.md) owns the
snapshot-scoped storage capability. Consumer admission was prepared before
public output activation so the initial Server's empty edge arrays remained
valid throughout that preparation.

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

Goal summaries retain complete project-local adjacency in snapshots and deltas,
including a final empty set after edge removal, without changing ordinary Task
graphs or readiness. Goal metadata details and receipts preserve these edges;
project synchronization remains their sole source. The schema upgrade requires
one fresh project baseline and discards refetchable detail content while
preserving unrelated stores. Local and cross-Project relationship projections
remain separate, and deployment depends on all active relationship writers
advancing the downstream Goal's existing Task version and update time.
