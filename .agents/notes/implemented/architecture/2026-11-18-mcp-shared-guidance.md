# Agent Note: Concentrate MCP Shared Guidance

Status: implemented

## Problem

Readers need complete operation rules, but repeated explanations of result
envelopes, examples, authorization and completion increase the material required
for each operation and risk inconsistent guidance. Reading a link as an
unconditional prerequisite can also pull unrelated topics into a read-only task.

## Decision

The overview owns result-envelope and schematic-example conventions and selects
required and conditional topics by operation. Clients reuse complete guidance
while it remains applicable. Write-safety owns shared authorization, exact
versions, conflicts and completion classification; operation topics retain
their specific identities, conditions, integrity and recovery procedures.
Materials owns formal material responsibilities and sufficiency.

At adoption, the thirteen-resource catalog retained complete Task lifecycle,
dependency replacement and Session history guidance at their existing URIs. The
[Task read/write decision](2026-11-18-mcp-task-read-write.md) separates Task
reads and lifecycle writes while preserving the original read URI. The
[dependency decision](2026-11-18-mcp-dependency-read-write.md) separates graph
reads from relationship writes. The [Session history decision](2026-11-18-mcp-session-history.md)
separates observation and history reads. The [topic guide decision](2026-11-11-mcp-topic-manuals.md) explains the original
operation boundaries; the [overview entry decision](2026-11-18-mcp-overview-entry.md)
explains the handshake. The [server design](../../../../docs/design/daynight-server.md#http-传输准入)
owns the current publication mechanism.

## Alternatives

**Only shorten the existing topics.** This reduces repeated prose but leaves
readers of Task and Session observations with unrelated lifecycle and history
rules in their reading set.

**Provide one guide per tool.** Many small resources increase navigation and
repeated prerequisite costs for work spanning related operations, while Steps,
Thread and transfers share important conditions across their tools.

**Generate aggregated or section-addressable manuals.** A new assembly or
addressing protocol adds client and failure behavior; static complete Resources
already support explicit reading sets and existing clients.

## Consequences

Shared explanations have clear owners and operation-specific recovery remains
local. Required reading sets and conditional prerequisites must stay accurate as
the catalog evolves. The mixed Session topic still carries unrelated material for some operations; measuring an operation requires its complete reading set rather
than a single shortened topic. Publication continues to synchronize bodies,
metadata, references and validation without changing business tool contracts.
