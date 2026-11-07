# Agent Note: Authenticated MCP HTTP Entry

Status: implemented

## Problem

Standard MCP clients need a remote entry to the existing service without sharing
request identities, duplicating authorization, or obscuring the outcome of a
write when validation, cancellation, or response delivery fails. Large resource
operations also need admission before materialization.

## Decision

The service composes one set of business use cases and a relay shared by REST and
the stateless MCP entry. Each HTTP request authenticates its own PAT or MCP OAuth
access token, checks any Origin against an exact allowlist, and carries its
principal and stable authority reference into tool handlers. The
[OAuth credential decision](2026-11-06-mcp-oauth-credentials.md) describes the
family and transaction boundaries. The official SDK supports the two declared
protocol versions.
Registered tools use one low-level wrapper with precompiled input and output
schemas, safe structured errors, and explicit completion facts. The production
registry exposes registered business adapters. The [Team adapter decision](2026-11-06-mcp-team-management.md)
records its oversized-item limitation.

Separate control and large-object permits are selected by internal materialization,
not the returned view. Permits remain held through handler and response delivery.
Shutdown cancels and waits for MCP handlers before stopping the shared relay. It
then waits for the remaining handlers and database cancellation before closing
borrowed storage. An HTTP drain timeout remains an error; if work has not stopped,
the application retains its resources for a further close attempt. The
[webhook runtime decision](2026-11-08-webhook-application-runtime.md) sets the
shared shutdown budget; the [application lifecycle decision](2026-11-06-server-application-lifecycle.md)
records resource ownership.

## Alternatives

**Typed SDK tool registration.** Its automatic input rejection occurs before
our wrapper can supply the shared error envelope and request ID, so it cannot
preserve the same error contract for valid tool calls.

**Per-connection identity and services.** Retaining a principal or constructing
independent business instances per connection would complicate per-request
credential revocation and risk divergent relay or authorization state.

**Return while cleanup runs in the background.** At this decision, the executable could exit before asynchronous PostgreSQL cancellation finished, so waiting preserved the outcome and shared-resource lifetime. The later [shared deadline](2026-11-08-webhook-application-runtime.md) bounds process shutdown while retaining dependencies when work has not stopped; forced exit can leave an unknown outcome.

## Consequences

Domain adapters select their worst-case materialization class. OAuth protocol
endpoints and other business tools require their separately owned implementations.
Clients and proxies handling full resources must support the declared result capacity.
