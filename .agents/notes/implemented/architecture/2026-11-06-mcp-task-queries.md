# Agent Note: MCP Task Queries

Status: implemented

## Problem

Clients need bounded task discovery in actionable order without missing or
repeating tasks when status and dependency changes move items between pages.
The REST task list has a different default order and must keep that contract.

## Decision

The MCP task list filters and orders in the DAO before applying a keyset limit.
Its cursor binds the caller, project, filters, view, ordering and the last
returned key to a repeatable-read fence of task count and exact version sum.
The fence includes deleted and filtered-out tasks because their changes can
alter readiness of visible dependents. A changed fence rejects continuation.
The summary query reads title previews and counts without materializing
properties or dependency arrays. Full list results retain their selected-item
materialization under the large-object permit. Pages continue by requested item
count without Task-specific response-byte slicing.

Graph summary and full views return the complete selected graph with the
existing snapshot and title-preview semantics. The shared MCP entry does not
validate or budget read output; its input checks, deadlines and resource permits
remain, as recorded in the [ordinary resource-read decision](../simplification/2026-11-09-canonical-resource-pages.md). The
[Task canonical batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md)
partially supersedes the original Task list byte admission, graph size checks
and summary graph truncation.

Ready queries use the separate count-limited operation described by the
[single-batch ready decision](../simplification/2026-11-06-mcp-ready-candidates.md).
That decision supersedes the original ready continuation and byte-budget
behavior; list fences and complete graph selection remain.

## Alternatives

**Use the task synchronization epoch.** It changes on deletion but not on
ordinary status or dependency updates, so it cannot detect priority changes.

**Sort after fetching a REST page.** Filtering and grouping after the limit can
omit tasks or produce a different order between pages.

**Add a ready-task cursor at the original query delivery.** That would have
allowed complete ready resources to continue directly, but changed the confirmed
tool input. The original delivery retained the cursor-free input and deferred
complete ready continuation. The later single-batch decision explicitly chooses
count-limited selection without continuation.

## Consequences

Every list page scans project Task headers in O(n) time with constant-size
aggregate state. This relies on increasing versions, soft deletion and
project-local prerequisites; physical purges or version rewrites require a new
fence. Full results reserve the large-object permit and require selected-item
materialization. Complete graphs have work and memory proportional to their
selected data, without domain node, edge or encoded-byte admission.

The original ready continuation used the Task list, preserving Task identities
but omitting descriptions; it disclosed that difference and relied on a separate
Task adapter for complete details. Ready now returns a single current batch,
while complete list traversal remains an independent operation. The original
summary graph omitted nodes explicitly and offered a full read; both graph views
now preserve the complete selected nodes.
