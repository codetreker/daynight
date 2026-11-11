# Agent Note: MCP Product Manual Resources

Status: implemented

## Problem

Connected MCP clients need accurate product guidance without a local CLI or a
Project selection. The public installation page describes connection setup but
does not provide the detailed operating knowledge needed after authentication.

## Decision

The original publication organized seven complete English topics as fixed
Markdown Resources embedded in the server, with short protocol instructions and
absolute links between topics. The [operation-topic decision](../architecture/2026-11-11-mcp-topic-manuals.md)
replaces that broad catalog while preserving this publication mechanism. The
manifest and content are validated before registration. Each read obtains a
shared Control permit before constructing its result and holds it through both
handler completion and HTTP delivery. Valid credentials suffice; no Project
membership or business mutation is involved. The [server design](../../../../docs/design/daynight-server.md#http-传输准入)
records the protocol and lifecycle boundaries.

## Alternatives

**Inject the entire manual in instructions or every tool response.** This would
repeat large content in client context when only one topic may be needed.

**Fetch documentation or rewrite links at runtime.** External availability and
mutable sources could diverge from the serving version; embedded final bytes and
fixed links make each release self-contained.

**Release the permit when the callback returns.** Encoded responses can remain
retained until delivery ends, so that boundary would not limit retained successful
manual reads in a batch.

## Consequences

Manual updates ship with the service. Clients discover the current catalog and
request current content after an update; the operation-topic decision owns topic
boundaries and removed URI behavior. Control limits
successful manual reads, not SDK list paths or total batch memory; saturation
returns a protocol error rather than a partial manual. The public installation
page remains separately available before authentication.
