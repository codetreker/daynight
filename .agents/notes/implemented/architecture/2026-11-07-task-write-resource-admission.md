# Agent Note: Task Write Resource Admission

Status: implemented

## Problem

Unbounded Task dependencies multiply graph queries, while unrestricted text and
property values can make a single write or its successful response expensive.
Transport limits alone do not cover internal and lifecycle writes. The final
Task version, timestamps and derived fields are known only after persistence.

## Decision

Task write owners apply the shared text, complete dependency and per-property
policies, preserving structural normalization and ownership checks. Dependency
count is checked before allocation and graph validation. Each normalized value
has its own budget, including values owned by worker lifecycle operations.
The write transaction measures the final Task with the production protocol
encoding before commit; a capacity failure rolls back the transaction. MCP
measurement includes the JSON-RPC ID, protocol version and selected projection.
For a legacy batch, the SDK does not expose each call ID to its tool handler.
The bounded input adapter associates each Task write with its own ID using an
internal marker, removed before tool handling, without replacing client metadata.
The [input policy decision](2026-11-07-api-input-policy.md) owns the shared
limits and the rationale for separating normalization from admission.

## Alternatives

**Enforce only at transport.** MCP and internal lifecycle writes would bypass
business admission, and raw bytes cannot represent normalized property size.

**Measure after commit.** A deterministic capacity rejection would conceal an
already committed write and leave callers unable to distinguish it from failure.

## Consequences

Public and lifecycle writes share the same budgets without changing read-side
normalization or truncating stored values. A dependency bound limits the number
of graph queries, not the size of the graph traversed by each query. Full
unpaged directories and historical data retain their existing growth risks.
