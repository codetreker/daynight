# Agent Note: Task Graph Queries by Chain

Status: implemented

## Problem

A project-wide CLI dependency graph mixes independent delivery chains and can
refuse a small chain because unrelated work exceeds its response limit.
Dependency review also requires complete relationship IDs without project,
status and title fields obscuring them. A task may belong to a branched or
merged chain, so inspecting only its direct ancestors and descendants omits
siblings that share the same delivery ownership.

## Decision

`daynight task graph <task-id>` requires an explicit target. The existing
project-scoped task-graph API requires exactly one taskId query and returns the
target's ordinary-edge undirected component plus the external prerequisites
directly declared by those members. All statuses participate. Added external
nodes do not expand further, and external tasks depending on the chain do not
enter the result. This reuses the chain ownership established by the
[external dependency decision](2026-10-23-external-dependency-design.md).

The store selects the component and one external layer in SQL. Authorization,
target validation, selection counts, payload and clock share one existing
read-only repeatable-read snapshot. The existing forward and reverse dependency
indexes support ordinary traversal, without a stored group identity or new
schema. Limits apply to returned node IDs and all dependency references declared
by those nodes. A large unrelated component does not consume that budget.

Every returned node retains its full dependency, external classification,
blocking and readiness facts. External context can therefore reference omitted
nodes. The decoder validates the requested component and direct external layer,
while permitting omitted prerequisites only for added context. It still checks
known target states, classifications, statistics and cycles among returned
nodes. Deleting references to make a local projection look closed would prevent
an accurate dependency audit.

`--depends-only` changes output fields rather than selection. Text contains only
the ID and the two dependency labels; JSON is a bare array of objects containing
id, dependsOn and externalDependsOn. Both use full UUIDs and preserve references
outside the returned rows. The normal response keeps the TaskGraph envelope and
statistics for all returned nodes. Requirements and mechanisms belong to the
[CLI specification](../../../../docs/spec/daynight-project-task.md) and
[server design](../../../../docs/design/daynight-server.md#任务链图查询).

Web continues to consume task-sync and derive a complete project graph locally,
including its complete all-edge ancestor context. The
[summary API decision](2026-10-24-task-summary-window-api.md) retains the full
project capacity check for that feed. A CLI chain response cannot serve as a
complete browser graph or synchronization baseline.

## Alternatives

**Download the complete project graph and filter in the CLI.** Unrelated tasks
would still consume transfer and response limits before the requested chain
could be selected. SQL selection keeps the query's budget tied to its result.

**Recursively include all external prerequisites.** This matches Web's browsing
context, but can pull large portions of other chains into a dependency audit.
A single external layer gives immediate prerequisite context while preserving
explicit IDs for further investigation.

**Trim external nodes' dependencies to returned IDs.** This makes every response
look dependency-closed, but reports an incomplete dependency declaration as if
it were the task's true state. Preserving raw relationships requires a decoder
that recognizes the selected component and external context separately.

## Consequences

A task in any position selects its whole ordinary chain, including forks,
joins and sibling branches. The graph endpoint and CLI require a target; there
is no whole-project fallback or second compatibility mode. Existing callers
must provide that task ID, while Web's complete data continues through task-sync.

The output is intentionally not an induced closed graph. Consumers must retain
its raw references and distinguish a missing task row from a missing dependency.
Node limits count the selected union; edge limits count even references whose
target rows are outside it. Exact counts still traverse the target component,
so the response bound does not establish a constant database-query cost.

This decision changes no dependency classification, readiness, scheduling or
write authorization. A future complete-project audit or richer graph export
would be an additive query with its own selection and size contract; it must
not reinterpret this query's raw dependency fields or the browser's full cache
baseline.
