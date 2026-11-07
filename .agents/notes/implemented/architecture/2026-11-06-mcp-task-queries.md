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
The summary query reads bounded title previews and counts without materializing
properties or dependency arrays. Full list results are materialized incrementally
under the large-object permit and the response byte budget. Graph reads retain
the existing snapshot, limits and title-preview semantics; bounded summaries
mark omitted nodes and provide a full-read continuation.

Ready queries use the separate count-limited operation described by the
[single-batch ready decision](../simplification/2026-11-06-mcp-ready-candidates.md).
That decision supersedes the original ready continuation and byte-budget behavior;
the list fence and graph decisions remain in effect.

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

Every list page scans project task headers in O(n) time with constant-size
aggregate state. This relies on increasing versions, soft deletion and
project-local prerequisites; physical purges or version rewrites require a new
fence. Full list results reserve the large-object budget and may require more work
per page. Summary graph omissions are explicit and a full read preserves the
complete graph within the existing node and edge limits.

The original ready continuation used the task list, preserving task identities
but omitting descriptions; it disclosed that difference and relied on a separate
Task adapter for complete details. Ready now returns a single current batch,
while complete list traversal remains an independent operation.
