# Agent Note: MCP Invitation Workflow

Status: implemented

## Problem

MCP clients need to manage Team invitations and receive Team or Project
invitations without bypassing authorization, single-use rules, or the one-time
disclosure of bearer links. Requested pages need a stable continuation without
materializing every invitation before selecting the page.

## Decision

The MCP invitation tools call shared Team and Project membership use cases.
The receiver validates the configured service origin, invitation path and
canonical secret before selecting the appropriate use case. Acceptance requires
explicit confirmation and reports the established transaction outcome; an
unknown result is not replayed. Only the creation receipt contains the link.

Team invitation pages use one ordinary database batch ordered by creation time
and ID. Cursors bind the caller and Team and follow the last returned item.
Reads do not byte-trim pages or invoke optional admission/fallback readers. The
[ordinary resource-page decision](../simplification/2026-11-09-canonical-resource-pages.md)
replaces that read-budget mechanism while preserving lifecycle rules. The
[MCP entry decision](2026-11-06-mcp-http-entry.md) owns authentication, input,
request deadlines and error envelopes.

## Alternatives

**Fetch the full invitation list and truncate it in the adapter.** This would
materialize the full collection before applying the requested page. At the
original decision, response-byte admission also motivated a bounded query;
ordinary count pagination now preserves whole items and continuation without
encoded read admission or a new REST directory limit.

## Consequences

MCP clients inspect and accept both invitation types and manage Team invitations
with the same permissions and transactions as REST. A lost creation receipt
cannot be recovered from list metadata; a lost acceptance receipt cannot be
reconstructed by automatically repeating the write. Pagination reflects the
live invitation filter, so expired, consumed or revoked invitations may disappear
between requests. Existing complete directories remain complete.
