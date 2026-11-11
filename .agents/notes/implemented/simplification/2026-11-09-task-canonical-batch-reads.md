# Agent Note: Task canonical batch reads

Status: implemented

## Problem

Task reads duplicated write-time property normalization and capacity checks.
A handwritten JSON parser and substring loader maintained another stored-value
interpretation, while ordinary Task pages and sync queried properties for each
selected Task. Search repeated graph reads for separate components and built
presentation snippets and representatives in SQL. Step reads reused strict write
candidate codecs and byte admission. These responsibilities increased normal
query and decoding work without changing the canonical representation produced
by accepted writes.

The original [encoded response decision](../architecture/2026-11-07-encoded-response-budgets.md)
included historical values in the read model and tried to bound their
materialization and encoded output. The
[Worker/Bot canonical-read decision](2026-11-09-worker-bot-canonical-reads.md)
separates write validation from stored-data reads. The same division applies to
the complete Task, property, sync, graph, search and Step read paths.

## Decision

Write ingress retains structure, fields, normalization, existing capacity rules
and transaction-state conditions. Task writes keep their 512 KiB protocol
response admission before commit; Step mutations keep strict candidate codecs
and the 64 MiB complete-collection admission with reserved version width. Their
atomicity and completion facts remain.

Stored properties load directly into `json.RawMessage` maps. Reads do not call
Normalize, Validate or Admit, parse values through a separate JSON interpreter,
substring-load them, or repeat field and capacity checks. Natural typed decoding,
JSON serialization, query, scan, cancellation and transaction errors retain their
causes. Historical data has no compatibility, scan or migration path, and
removed read limits do not become aggregate Project write quotas.

Ordinary REST Task pages select `limit+1` candidates once and load the selected
IDs' complete properties with one `ANY` query. Worker-filtered Task inventory
uses one joined candidate scan, ordinary claim decoding and active/user/Worker
matching before count pagination and lookahead. Task show uses the required
ordinary reader directly. Sync scans matching Tasks once and bulk-loads their
properties in the same snapshot. Query counts do not grow linearly with Task or
property counts for these ordinary batch paths.

Graph reads return the complete selected component and direct external
prerequisites without stored node/edge capacity admission. Search computes the actual returned description snippets and reads distinct
parent Goal titles in one batch. The [typed resource read decision](../architecture/2026-11-11-typed-task-resource-reads.md)
replaces the earlier ordinary-component search context with actual membership. Exact-ID
ranking, Boolean evidence, the project fence, sort order and count cursors remain.

Step collection and item reads use pure `ProjectCollection`/`ProjectItem`
projection. MCP Step lists use one `limit+1` DAO query; ordinary Get/GetSummary
preserve their response views. Request syntax and explicit expected parent
versions remain checked before page reads. Task MCP lists keep their existing
priority selection and fence; full views batch their selected-item materialization. Task graph summary and full views both return the complete
selected graph. These domain paths have no read-byte slicing or admission; the
shared MCP entry has no read-output schema or byte admission. Input checks,
deadlines and resource permits remain independent. The
[ordinary resource-read decision](2026-11-09-canonical-resource-pages.md)
removes the remaining resource-list admission and preserves their count pages.

Task sync retains current access, people versions and its complete lightweight
Session state map. Task, Worker and persisted Session sources share the existing
snapshot; the Engine reads committed live scalars and compares the actual
binding and fence. Ordinary decoding replaces stored-value validation while
Session lifecycle, heartbeat, drain and missing-live semantics remain. Sync
still returns the complete response once, with no intermediate publication.

The [property design](../../../../docs/design/daynight-task-properties.md),
[sync design](../../../../docs/design/daynight-task-sync.md),
[search design](../../../../docs/design/daynight-task-search.md) and
[Step design](../../../../docs/design/daynight-task-steps.md) own current data flow
and observable contracts. The
[Task encoding ownership](../architecture/2026-11-05-task-data-ownership.md),
[MCP query decision](../architecture/2026-11-06-mcp-task-queries.md),
[graph fixture decision](../testing/2026-11-06-task-graph-fixture-statistics.md)
and [service test ownership](../testing/2026-11-08-task-service-test-ownership.md)
retain their original rationale while reflecting the new read responsibilities.

## Alternatives

**Restore the earlier files wholesale.** Earlier readers also normalized stored
properties and enforced read capacities. A file-level revert would restore those
responsibilities and discard later Session integration and exact-ID search. The
canonical read paths preserve those current contracts explicitly.

**Keep a bounded parser or introduce another read-admission framework.** Batching
queries alone would still leave a second JSON interpretation and read-byte
refusal contract. Ordinary canonical values already come from the write codecs,
so that framework does not serve the chosen read responsibility.

**Issue independent per-item queries concurrently.** This can overlap database
round trips but retains their amplification and duplicate work. Bulk selection
and property or context queries make the ordinary query count independent of
page length without adding concurrent read orchestration.

## Consequences

Ordinary Task pages, sync and search context use batch queries. Stored properties
are decoded only by consumers that need typed fields, and Step reads project
without write-candidate validation. Server reads no longer promise encoded-byte
or stored graph-size bounds; memory and processing cost follow the actual
selected data. Existing client transport, detail-cache and browser quotas remain
separate, and failures preserve valid caches or local ownership rather than
publishing partial results.

Tests retain fields, current access, count continuation, explicit parent versions,
Session projection, exact-ID search and natural errors. Ordinary Store graph
witnesses prove real traversal and snapshot behavior. The former capacity-only
matrices are retired, while CLI and Web tests accept complete responses beyond
the former thresholds; overflow refusal requirements are historical. Write capacity and rollback tests retain
their production codecs. Query-count and runtime comparisons must use matching
normal inputs and database settings; package timings cannot establish hosted
request or CI savings.
