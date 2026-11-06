# Agent Note: Single-Batch MCP Ready Candidates

Status: implemented

## Problem

Ready-task selection needs a small batch of actionable candidates. The original
MCP query could return complete Tasks initially but direct continuation through
a task-list projection that omitted descriptions. Combining this selection with
encoded-byte pagination also introduced response sizing and cursor machinery
that callers could not use through the ready tool itself.

## Decision

`task_ready` selects the current first matching candidates in creation-time/UUID
order. The limit defaults to 5 and accepts 1 through 20. Filters apply before the
limit, and permission checks and full Task reads use the same read snapshot.

The tool has no cursor input or continuation output. Its successful result
contains `items` and `projection`; summary retains marked title previews and
selection fields, while full retains complete descriptions and properties.
Candidate selection depends on the count limit without a per-result encoded-byte
budget. The shared MCP response limit and admission policy remain applicable.

The single-batch query does not calculate the project traversal fence or encode
item cursors. The [task-query decision](../architecture/2026-11-06-mcp-task-queries.md)
continues to own paginated task-list consistency and graph behavior; this decision
replaces only its original ready continuation and byte-budget behavior.

## Alternatives

**Add native ready pagination.** This would preserve complete Tasks across pages,
but requires cursor scope, change detection and traversal semantics for a tool
whose purpose is selecting a bounded current batch. Complete discovery is already
available through the paginated task list.

**Continue through task list and read each Task separately.** This can retrieve
current descriptions, but separate detail reads do not inherit the list fence and
must not be presented as one consistent full ready traversal. It remains an
explicit workflow for callers that need discovery followed by current details.

**Reject a batch that exceeds a ready-specific encoded budget.** This would
require encoding-size calculations and asking callers to reduce an otherwise
valid count. The small count limit is the chosen selection control; ready does
not add its own result-size budget.

## Consequences

Ready selection has one call and one count limit, with no transition to another
projection. Increasing descriptions or properties does not cause the ready query
to silently return fewer selected candidates. A result containing fewer than the
limit means fewer matching tasks were found in that read snapshot.

The count limit does not bound encoded response bytes. Shared transport limits
can still reject an oversized response, and full reads retain the large-object
admission policy. A returned Task can stop being ready after the query. Callers
that need all ready task identities use paginated `task_list(ready: true)` and
read current details separately when needed.
