# Agent Note: MCP Task Resource Operations

Status: implemented

## Problem

MCP clients need to manage Task resources with the same authorization, version,
dependency classification and lifecycle effects as other service clients. A
summary result must not conceal the cost of materializing a complete Task.

## Decision

Eight Task tools call the shared Tasks service. Ordinary and external dependency
inputs are disjoint sets compiled into the domain union and external subset;
either field replaces both classes. Omitted versions are read once before a
single write. Property text is parsed by the existing property rules. Marked
summary results are the default, with full resources available explicitly.
Creation accepts Task or Goal, and Task updates preserve Parent presence so a
caller can retain, assign or clear membership. Type-specific defaults and
capabilities remain with the shared service; the adapter accounts for both
fields in the business body. The [Goal admission decision](../architecture/2026-11-11-goal-write-admission.md)
owns the underlying lifecycle and membership rules.

The static property schema uses the control budget. Operations that materialize
Tasks reserve the large budget even when returning summaries. Task writes obey
the existing 1 MiB business JSON limit independently of MCP routing fields.

## Alternatives

**Treat dependency inputs as the domain union and subset.** This would make an
ordinary-only update retain or accidentally reclassify external dependencies and
would expose an internal representation as an editing contract.

**Retry a version conflict with a fresh version.** A retry could apply a stale
caller decision to a different resource state and cannot resolve an unknown
commit outcome.

## Consequences

MCP and HTTP share authorization, optimistic concurrency and deletion side
effects. Full Task materialization limits concurrency even for summary writes;
static schema reads remain independent of that limit. The remaining MCP tools
are separately owned implementations.
