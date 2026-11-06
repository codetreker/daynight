# Agent Note: MCP Invitation Workflow

Status: implemented

## Problem

MCP clients need to manage Team invitations and receive Team or Project
invitations without bypassing existing authorization, single-use rules, or the
one-time disclosure of bearer links. A list can grow beyond a practical tool
response and must not materialize every invitation before pagination.

## Decision

The MCP invitation tools call the shared Team and Project membership use cases.
The receiver validates the configured service origin, invitation path and
canonical secret before selecting the appropriate use case. Acceptance requires
explicit confirmation and reports the established transaction outcome; an
unknown result is not replayed. Only the creation receipt contains the link.

Team invitation pages use a bounded database query ordered by creation time and
ID. Cursors bind the caller and Team and follow the last returned item, including
when the response budget requires a shorter page. The existing REST list and
invitation lifecycle retain their own contracts. The [MCP entry decision](2026-11-06-mcp-http-entry.md)
owns authentication, request budgets and error envelopes.

## Alternatives

**Fetch the full invitation list and truncate it in the adapter.** This would
materialize an unbounded collection before applying the response limit, defeating
the MCP resource budget. The bounded query preserves whole items and the
continuation point without imposing a new limit on the REST list.

## Consequences

MCP clients can inspect and accept both invitation types and manage Team
invitations with the same permissions and transactions as REST. A lost creation
receipt cannot be recovered from list metadata; a lost acceptance receipt cannot
be reconstructed by automatically repeating the write. Pagination reflects the
existing live invitation filter, so expired, consumed or revoked invitations
may disappear between requests.
