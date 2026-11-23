# Agent Note: Task Dependency Limit

Status: implemented

## Problem

Tasks with more than 15 direct prerequisites were rejected even when the work
requires a larger set. Increasing the limit must retain a single budget across
ordinary and external edges and keep oversized writes out of graph processing.

## Decision

A Task admits at most 30 direct prerequisites, including external edges. Core
owns the limit and the policy catalog publishes it. MCP checks the combined
ordinary and external partitions against the same limit before merging them;
its refusal reports both the actual count and the limit. The existing graph,
identity, transaction and response-size rules remain in force. The shared
[admission policy](2026-11-07-api-input-policy.md) retains its domain ownership.

## Alternatives

**Retain 15.** This rejects valid dependency sets of 16 to 30 and prevents the
requested workflows.

**Give external edges a separate allowance.** This would make the total graph
work and response size depend on classification rather than the direct set.

## Consequences

Larger valid sets can be written without a schema migration; requests over 30
are rejected before per-edge graph work. Graph processing can do more work per
admitted write, while the existing complete Task response budget remains in
force.
