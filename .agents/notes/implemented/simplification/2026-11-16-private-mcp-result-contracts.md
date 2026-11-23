# Agent Note: Private MCP Result Contracts

Status: implemented

## Problem

The MCP discovery catalog originally included a complete output schema for every
tool. These schemas made the catalog substantially larger even though callers can read
actual JSON results and use product manuals to understand their business meaning.
The catalog must retain the information needed to call tools, and reducing it
must not weaken existing input, output or error guarantees.

## Decision

The discovery catalog omits the `outputSchema` member for every tool. The
remaining metadata, actual `content` and
`structuredContent`, and product manual Resources retain their contracts. No
output schema is relocated to another discovery field or a required Resource.

At this decision, internal output schemas continued to support registration,
error-envelope and applicable runtime checks. The later [output schema removal
decision](2026-11-16-remove-mcp-output-schemas.md) removes those definitions and
checks while retaining write and upload capacity and completion semantics.
Protocol tests directly assert results and check the complete discovery catalog.

The original [MCP entry decision](../architecture/2026-11-06-mcp-http-entry.md)
published output schemas to support client validation and type discovery. The
[typed Task resource](../architecture/2026-11-11-typed-task-resources.md) and
[Session history](../feature/2026-11-10-task-session-history.md) contracts used
those definitions for their respective result shapes. These business contracts
remain, while schema-based discovery is no longer provided.

## Alternatives

**Retain public schemas with local references.** A lossless prototype reduced
schema bytes only modestly while requiring reference derivation and compatibility
proof. It also retained the public member, so it did not achieve complete
omission.

**Replace definitions or add a separate schema registry.** At that decision, the
shared registration boundary owned the definitions and validators. A second
source or a replacement tool model would add synchronization and migration cost
without changing the required publication behavior.

## Consequences

The discovery catalog is smaller without removing result fields; the original
validation policies were subsequently changed by the linked removal decision.
Clients lose the ability to generate output types or validate results from
discovery metadata. Actual results and manuals remain
available, but neither establishes compatibility for every client or model.
Clients that cache discovery metadata control when they refresh it. The change
makes no claim about model token savings or a fixed reduction ratio.
