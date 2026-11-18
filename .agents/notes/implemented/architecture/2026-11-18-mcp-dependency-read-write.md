# Agent Note: Separate MCP Dependency Reads and Writes

Status: implemented

## Problem

Graph readers need scope, projections and relationship interpretation without
loading the complete replacement and verification contract. Combining those
rules increases the context required for read-only graph work.

## Decision

The existing dependencies Resource owns graph reads and returned collections.
The dependency-writes Resource owns the input partition, whole-set replacement,
reduction and verification rules. Dependency-only writes require both topics and
write-safety; creation or changes to other Task fields also require task-writes.
The overview and operation guides expose these prerequisites. The
[original topic decision](2026-11-11-mcp-topic-manuals.md) explains the earlier
boundaries and the [Task decision](2026-11-18-mcp-task-read-write.md) describes
the related Task split. The [server design](../../../../docs/design/daynight-server.md#http-传输准入)
owns publication details.

## Alternatives

**Keep the combined dependency guide.** Its single URI supports mixed work but
requires graph readers to load all mutation and failure rules.

**Publish a Resource per operation.** Multiple small Resources increase navigation
and prerequisite costs for related relationship changes with shared constraints.

## Consequences

Graph-only reads require less content, while writers obtain complete graph, write
and safety guidance. The existing URI remains available with a revised scope;
metadata, links, sizes and independent catalog expectations change together.
The catalog grows by one Resource without changes to business schemas or runtime
composition. At adoption, Session observation and history remained in their
existing topic; the [Session history decision](2026-11-18-mcp-session-history.md)
subsequently separates them.
