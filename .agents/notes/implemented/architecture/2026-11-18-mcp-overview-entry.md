# Agent Note: Read the MCP Overview Before Using Tools

Status: implemented

## Problem

Clients need operation navigation and shared guidance before using Daynight tools.
Some clients repeat server instructions alongside each discovered tool, so a
complete navigation table in the handshake can consume context repeatedly even
when its guidance has already been read.

## Decision

The handshake briefly introduces Daynight and gives the absolute URI of an
overview Resource to read before using tools. The overview contains operation
navigation and shared reminders; the twelve operation guides retain their
detailed rules and existing URIs. The server embeds and registers the overview
with the same fixed manifest, validation, authentication and delivery lifetime
as those guides. Clients can read the URI directly without listing the catalog.
The [topic guide decision](2026-11-11-mcp-topic-manuals.md) retains the rationale
for independent operation guides; the [server design](../../../../docs/design/daynight-server.md#http-传输准入)
describes their publication and transport.

## Alternatives

**Keep the navigation in handshake instructions.** Clients that attach those
instructions to every matching tool repeat the same table even after reading it.

**Put the overview in an existing topic.** General navigation would be coupled
to a particular operation, requiring other operations to read that larger guide.

**Add a manual tool.** This would add a tool definition and bypass the existing
authenticated Resources discovery and reading channel.

## Consequences

Clients using the overview incur one Resource read per context where it has not
already been read. The two-sentence instruction is 214 UTF-8 bytes including its
final newline, compared with the previous 2,267-byte instruction. Repetition and
total context costs depend on client behavior, matching tools and reused guides;
byte counts alone do not establish token savings. Existing topic identities and
read semantics remain unchanged, while clients discovering the catalog see one
additional Resource.
