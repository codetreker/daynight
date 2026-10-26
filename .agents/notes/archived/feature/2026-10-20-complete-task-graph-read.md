# Agent Note: Complete Task Graph Snapshot Read

Status: implemented

## Problem

A project dashboard needs its task counts, dependency edges and readiness to
describe one state. Existing task pages each have their own snapshot, so joining
successive pages can combine incompatible states during concurrent writes.
Returning all task descriptions also makes a graph response unnecessarily large.

## Decision

The task service exposes a complete graph read using the concrete store's
existing read-only REPEATABLE READ callback. It reads the project first, counts
nodes and edges, applies the graph limits, and obtains lightweight task nodes
before deriving the summary. The domain read model belongs in core; SQL belongs
in core/store, and server maps the result to API DTOs.

The [server requirements](../../../../docs/spec/daynight-server.md#完整任务图)
own the public behavior. A successful response contains the complete graph and
summary from one snapshot. Above 1,000 nodes or 5,000 edges, the service returns a
typed limit refusal with exact counts, never a partial success. These bounds
constrain returned data and rendering; exact database counts and character
scans still have costs.

SQL projects the first 160 Unicode code points of each title and an explicit
truncation flag without selecting full titles or descriptions. Existing ordered
dependency and blocked-by expressions are shared with full task reads. No
stored readiness, counters, new schema or write path is introduced.

Missing-project and graph-limit faults remain pending inside the snapshot
callback and are returned only after transaction completion succeeds. An
operational, cancellation or cleanup failure remains authoritative. HTTP rejects
all nonempty query strings, returns no-store, and preserves existing request IDs,
sanitized errors and structured resource logging.

The [dashboard design](../../../../docs/design/daynight-web.md) owns browser
projection and rendering. This endpoint does not
introduce a parent-child task model or change existing paging guarantees.

## Alternatives

**Join existing pages.** Independent page snapshots can disagree about task
states and dependency closures. Adding frontend deduplication cannot recover a
single consistent state from those responses.

**Return full task objects.** Descriptions and unrestricted full titles are not
needed for graph layout and can dominate the payload. Existing detail reads
already provide complete content when a task is opened.

**Truncate a large graph.** Missing nodes or edges would misstate prerequisites,
roots and progress. A complete refusal states the actual counts and limit.

## Consequences

Graph consumers get one project-scoped state without changing mutation policy,
database layout or transaction ownership. Raw-profile coverage gates and real
PostgreSQL tests apply to the owning packages. Tests must prove snapshot
interleavings, exact limits, bounded Unicode projections, failures and HTTP
error semantics.
