# Agent Note: Separate MCP Session Observation and History

Status: implemented

## Problem

Session observers need current state, location and inspection rules without
loading the history paging and complete-entry protocol. Combining these rules
in one Resource increases the required context for read-only observation.

## Decision

The existing session-reads Resource owns observations, grouped work, Session
location and inspection. The session-history Resource owns history pages,
filtering and complete-entry reads. Clients with an exact Session and source can
read history directly; clients that first need to locate or inspect a Session
also read session-reads. Sending guidance requires session-reads when identity or
admission must be established, and recovery retains the original operation.
The overview selects these prerequisites and write-safety remains the shared
owner of write rules. The [topic guide decision](2026-11-11-mcp-topic-manuals.md)
explains the earlier boundaries, and the [shared guidance decision](2026-11-18-mcp-shared-guidance.md)
explains common rules. The [server design](../../../../docs/design/daynight-server.md#http-传输准入)
owns publication details.

## Alternatives

**Keep the combined Session guide.** Its URI supports both kinds of read, but
observers must load the history chunking and recovery contract even when they
do not read history.

**Publish a Resource per tool.** Many small Resources add navigation and
prerequisite costs to related Session operations that share conditions.

## Consequences

Observation alone needs less content; readers who locate a Session and then
read its history need both Resources and an additional request. The existing
session-reads URI remains available with a revised scope. Metadata, links,
sizes and independent catalog expectations change together; business schemas
and runtime composition do not change.
