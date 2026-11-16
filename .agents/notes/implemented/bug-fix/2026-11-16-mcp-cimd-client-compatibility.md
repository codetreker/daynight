# Agent Note: MCP CIMD Client Compatibility

Status: implemented

## Problem

Public metadata can describe more client capabilities than one authorization
server implements. GitHub Copilot CLI declares authorization code, refresh token,
and device code grants in its CIMD document. Applying Daynight's registration
allowlist to that document rejects a usable authorization-code client. Claude
Code declares a portless localhost callback and chooses a local port at runtime;
the original IP-literal-only port exception rejects that callback before consent.

## Decision

Remote CIMD documents use a distinct parsing entry point. An explicit grant list
must contain authorization_code and may include other syntactically valid grant
names or absolute URIs. An omitted list retains the existing default. DCR,
preregistered configuration, and stored registrations keep the strict supported
grant policy. Metadata identity, public-client authentication, redirect safety,
and network retrieval protections remain shared.

The HTTP port exception includes the exact localhost hostname alongside literal
loopback addresses. It never substitutes hosts or relaxes scheme, path, query,
or other URL components. This is a compatibility choice beyond RFC 8252's
loopback IP requirement. Token exchange still compares the complete redirect
selected at authorization time.

This partially replaces the parsing and callback decisions in
[MCP OAuth Public Clients](../architecture/2026-11-06-mcp-oauth-clients.md).
The [current design](../../../../docs/design/daynight-mcp-oauth.md) owns the
resulting protocol behavior.

## Alternatives

**Require clients to use DCR.** Clients that select their published CIMD identity
already send an authorization request. Rejecting that request does not reliably
cause a registration fallback and leaves otherwise compatible clients unusable.

**Allow extra grants in every parser.** This would make registration accept
unsupported server operations and weaken existing configuration validation.
Remote capability declarations and local registrations need distinct policies.

**Implement device authorization.** Copilot can use authorization code; adding
another grant flow does not address the metadata parsing error and introduces
unnecessary endpoints and credential lifecycle behavior.

## Consequences

Claude Code and Copilot CLI metadata can authorize through the existing code
flow. Extra CIMD grants do not enable new server endpoints or token grants.
Only exact localhost receives the added port exception; aliases, subdomains,
and cross-host redirects remain rejected. Regression coverage must retain
strict registration rejection and exact token-exchange binding as well as
the successful client-shaped inputs.
