# Agent Note: MCP OAuth Metadata Compatibility

Status: implemented

## Problem

Claude Code's public metadata registers a portless localhost callback, while
its listener selects a port. Copilot CLI's public metadata includes device-code
capability alongside code flow. Exact hostname-port matching and rejecting
every unsupported CIMD capability each prevent an otherwise shared code flow.
Neither observation establishes the complete cause of a production failure.

## Decision

The shared redirect matcher permits a port change only for a portless exact HTTP
localhost registration, preserving raw path/query suffix bytes. Fixed localhost
ports, HTTPS, and existing literal loopback IP rules retain their semantics.
The actual complete redirect is frozen and remains exact at code exchange.

An explicit core CIMD parser validates metadata and intersects capabilities in
server order, requiring authorization code and code response. Each omitted field
defaults to code flow; explicit malformed or empty fields fail. Service fetch
and cache validation bind this parser explicitly. DCR, stored DCR and configured
clients retain strict parsing, regardless of whether their ID resembles a URL.

This partially replaces the original matching and uniform capability policy in
the [public-client decision](../architecture/2026-11-06-mcp-oauth-clients.md).
Those restrictions originally bounded supported public-client inputs without
the complete portable documents that expose these compatibility gaps.
The [current design](../../../../docs/design/daynight-mcp-oauth.md) owns parser
composition, errors, network constraints and validation responsibilities.

## Alternatives

**Fix only localhost.** This leaves the independent rejection of Copilot's
complete public metadata unresolved.

**Relax every client source or special-case brands.** DCR/config describe
registration with this server, unlike portable CIMD. Relaxing them changes their
existing contract; URL or device-string heuristics conflate provenance and
capability and miss other valid supersets.

**Add device authorization or per-client refresh permissions.** Device
authorization requires a new endpoint and credential journey. Refresh gating
requires snapshot/storage, issuance, rotation and existing-record migration
contracts, not a partial admission check. Neither is needed to admit shared
code flow.

**Disable network defenses or substitute PAT.** These weaken retrieval or
avoid OAuth without establishing compatibility.

## Consequences

Portable supersets can enter code flow without granting unsupported execution.
Snapshots and storage formats do not change; code exchange still issues access
and refresh even when the CIMD default declares only authorization code.
The localhost exception is a compatibility policy, not a claim that RFC 8252's
literal-IP rule mandates hostname wildcards.

Core tests retain complete public documents; service tests use equivalent
documents under a controlled certified identity with real fetching and IP
pinning. Process integration uses actual DCR rather than impersonating official
CIMD domains. These proofs do not establish original failing client versions,
production SHA, official-domain egress, or real client refresh/tool success.
Those require independent client acceptance.
