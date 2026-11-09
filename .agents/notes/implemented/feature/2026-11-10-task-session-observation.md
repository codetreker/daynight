# Agent Note: Task Session Observation

Status: implemented

## Problem

Task users need to identify the current execution that requires attention without
opening a Session or loading its content for each row. Filtering only root Tasks
misses ongoing work below completed requirements or design Tasks. A chain can
contain several owners and executions, so one synthetic Session or send flag
would misrepresent the actual target and permissions. Database selection and
live activity also change independently while a query is in flight.

## Decision

Task reads expose versioned Session observations, and a separate work overview
groups ordinary dependency components containing the selected user's ongoing
Tasks. The [requirements](../../../../docs/spec/task-session-observation.md)
own observable behavior; the [design](../../../../docs/design/task-session-observation.md)
owns source selection, live sampling, pagination and response encoding.

The shared Session Engine owns activity classification and ordinary-message
eligibility. Observation preserves the real actor and current execution fence;
attention and send permission remain independent. Sources are lightweight,
selected in batches of at most 200, and never load message or control content.
The original database snapshot closes before live sampling and a fresh snapshot
reauthorizes and rechecks the selected binding. Work target batches also check a
stable Task graph fence, with a final check before publication.

Work groups select by assignee but aggregate every accessible ongoing member.
External prerequisites remain references rather than members. Group and target
cursors preserve different ordering boundaries; response trimming resumes after
the last item actually returned. Only the dedicated work overview has a 256 KiB
complete-response budget, including its transport envelope. Ordinary Task reads
remain complete, and successful MCP reads retain ordinary encoding without
runtime output-schema admission.

Explicit Session inspection supplies a reusable read-only target and fence
without substituting a later execution. Public CLI and MCP registration points
expose only implemented consumers. History reading and sending remain separate
capabilities with their own operation-time authorization.

## Alternatives

**Fetch the full current Session for every Task.** This repeats permission,
content and transport work and scales requests with visible rows. The earlier
[TaskSync projection decision](../architecture/2026-11-08-task-sync-session-projection.md)
established a lightweight shared producer for Web annotations. The richer
observation reuses its indicator rules while providing execution and caller
eligibility facts required by non-Web consumers.

**Keep one database snapshot open through sampling and rechecking.** Repeatable
read cannot observe a newer committed claim in the same snapshot. Opening a
second snapshot while retaining the first can exhaust a pool when concurrent
requests each hold a connection and await another. Released snapshots plus fresh
checks preserve change detection without nested connection acquisition.

**Apply one generic response budget to all Task reads.** This would reverse the
[canonical resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md)
and truncate existing complete representations. The work overview has its own
summary DTO and resumable pagination, so its dedicated capacity does not require
a generic read wrapper or restored runtime MCP output validation.

**Use count-only pages for the new overview.** This preserves the ordinary read
policy but loses the overview's complete encoded-response guarantee. Its explicit
byte budget therefore remains a scoped exception, with protocol overhead counted
before selecting the final returned prefix.

## Consequences

Consumers locate concrete tasks, owners and Sessions directly from ordinary
reads or one grouped page. Unknown observations preserve Task data and remain
visible as partial results; authorization refusal fails the operation. A group
has no aggregate Session identity or write authorization.

The observation is a bounded-time sample, not a transaction spanning PostgreSQL
and every live cell. Even a successful fresh check can become stale afterward,
so future sending must retain and revalidate the explicit target. Full group
aggregation still scans all ongoing members, and each target continuation
recomputes the summary. Sources and output are bounded per batch/page; total
aggregation work grows with the selected components.

The existing minimal TaskSync map and full current/content APIs retain their
separate purposes. This capability does not prove message delivery, provider
recovery or historical-content completeness; those require their actual owning
operations and evidence.
