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
properties or dependency arrays. Full results are materialized incrementally
under the large-object permit and the response byte budget. Graph reads retain
the existing snapshot, limits and title-preview semantics; bounded summaries
mark omitted nodes and provide a full-read continuation.

## Alternatives

**Use the task synchronization epoch.** It changes on deletion but not on
ordinary status or dependency updates, so it cannot detect priority changes.

**Sort after fetching a REST page.** Filtering and grouping after the limit can
omit tasks or produce a different order between pages.

**Add a ready-task cursor now.** That would allow complete ready resources to
continue directly, but changes the confirmed tool input. The oversized ready
continuation is deferred while retaining the existing cursor-free input.

## Consequences

Every list page scans project task headers in O(n) time with constant-size
aggregate state. This relies on increasing versions, soft deletion and
project-local prerequisites; physical purges or version rewrites require a new
fence. Full results reserve the large-object budget and may require more work
per page. Summary graph omissions are explicit and a full read preserves the
complete graph within the existing node and edge limits.

If a full ready response exceeds its budget, continuation through the existing
task list preserves task identities but omits descriptions. `task_show` can
provide those descriptions when its adapter is available. The continuation
states that limitation; the ready input remains available for a later compatible
cursor design without changing REST ordering.
