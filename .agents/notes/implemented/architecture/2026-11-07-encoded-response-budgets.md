# Agent Note: Encoded response budgets

Status: implemented

## Problem

Row-count limits alone do not bound encoded responses or the work needed to
materialize a page. An encoding failure after a successful HTTP header can also
make an incomplete resource appear successful. At the original decision,
historical records exceeding input limits were included in the read model, so
write admission alone could not bound every read.

## Decision

Task mutations retain transactional response admission and report post-commit
delivery failures with their completion facts. Step mutations retain their
strict complete-candidate capacity encoding. Ordinary JSON responses are encoded
before a successful header is committed, so natural encoding failures do not
publish a partial successful representation.

The original read mechanism measured complete protocol projections, envelopes,
cursors and REST newlines. Paginated readers admitted bounded candidates within
a snapshot; a candidate that did not fit remained reachable after the last
returned item, and an unreturnable first item failed explicitly. MCP Step limits
included the individual JSON-RPC success response and request ID. Those were the
historical read guarantees, separate from write completion and response admission.

The [Worker/Bot read decision](../simplification/2026-11-09-worker-bot-canonical-reads.md),
[Task batch-read decision](../simplification/2026-11-09-task-canonical-batch-reads.md)
and [ordinary resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md)
replace all stored-data read admission. Reads trust canonical data and preserve
current authorization, request bounds, count continuation and natural errors.
The shared MCP entry no longer validates or budgets successful read output;
input checks, deadlines and resource permits remain. Write-output schema and
capacity admission retain their independent responsibilities.

The [Task sync design](../../../../docs/design/daynight-task-sync.md),
[Steps design](../../../../docs/design/daynight-task-steps.md),
[Worker design](../../../../docs/design/daynight-worker-snapshots.md), and
[attachment design](../../../../docs/design/daynight-task-attachments.md) own
their current mechanisms and protocols. The
[MCP Team decision](2026-11-06-mcp-team-management.md) retains authorization,
version and count-pagination rules.

## Alternatives

**Read an entire page and truncate its encoded output.** A row limit could still
materialize many large records before the byte check, and truncation could lose
the continuation position or publish an incomplete resource. This was the
comparison behind the original bounded-reader choice; the canonical-read
simplifications record the later choice of write validation and ordinary reads.

## Consequences

The write admission and actual completion guarantees remain. Stored-data reads
no longer provide the former encoded-byte refusal or historical field-validation
guarantees. Complete pages and unpaged directories preserve their original
representations, with work and memory proportional to selected data. Client
transport and cache limits remain independently owned and do not constitute
server read admission.
