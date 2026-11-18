# Agent Note: Separate MCP Task Reads and Writes

Status: implemented

## Problem

Task readers need projections, filters and pagination without loading the full
lifecycle and mutation contract. Combining both increases the required context
for ordinary queries and obscures which rules writers must read.

## Decision

The existing tasks Resource owns complete Task and Goal read guidance. A separate
task-writes Resource owns creation, metadata, status, property and deletion
conditions. The overview identifies the required reading set; writes also require
write-safety. Dependency-only writes continue to use dependencies and write-safety,
while creation with dependencies and mixed updates also require task-writes.
Dependency and Session topics retain their current mixed boundaries. The
[shared guidance decision](2026-11-18-mcp-shared-guidance.md) owns the common
rules and the [topic guide decision](2026-11-11-mcp-topic-manuals.md) explains
the original boundaries. The [server design](../../../../docs/design/daynight-server.md#http-传输准入)
describes publication.

## Alternatives

**Keep the combined Task guide.** Its single URI remains convenient for mixed
work, but every read requires the complete lifecycle contract.

**Split every operation into its own Resource.** This increases navigation and
prerequisite costs for related operations that share mutation conditions.

## Consequences

Read-only Task operations load a smaller complete topic, while writers need the
separate write guide and shared safety rules. The catalog grows by one Resource;
metadata, size, links and independent catalog expectations must change together.
The existing tasks URI remains readable with its revised scope. No business
schema or runtime composition changes are needed.
