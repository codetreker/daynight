# Agent Note: Authenticated MCP HTTP Entry

Status: implemented

## Problem

Standard MCP clients need a remote entry to the existing service without sharing
request identities, duplicating authorization, or obscuring the outcome of a
write when validation, cancellation, or response delivery fails. Large resource
operations also need admission before materialization.

## Decision

The service composes one set of business use cases and a relay shared by REST and
the stateless MCP entry. Each HTTP request authenticates its own PAT, checks any
Origin against an exact allowlist, and carries its principal and credential ID
into tool handlers. The official SDK supports the two declared protocol versions.
Registered tools use one low-level wrapper with precompiled input and output
schemas, safe structured errors, and explicit completion facts. The production
registry is empty until complete business adapters are registered.

Separate control and large-object permits are selected by internal materialization,
not the returned view. Permits remain held through handler and response delivery.
Shutdown cancels and waits for MCP handlers before stopping the shared relay. It
then waits for the remaining handlers and database cancellation before closing
borrowed storage. An HTTP drain timeout remains an error. A separate five-second
cleanup budget waits for actual work; if it expires, the application retains its
resources for a further close attempt. The [application lifecycle decision](2026-11-06-server-application-lifecycle.md)
owns this bounded cleanup and resource ownership.

## Alternatives

**Typed SDK tool registration.** Its automatic input rejection occurs before
our wrapper can supply the shared error envelope and request ID, so it cannot
preserve the same error contract for valid tool calls.

**Per-connection identity and services.** Retaining a principal or constructing
independent business instances per connection would complicate per-request
credential revocation and risk divergent relay or authorization state.

**Return while cleanup runs in the background.** The executable exits when the
runtime returns, terminating asynchronous PostgreSQL cancellation before a
blocked transaction has necessarily stopped. Waiting for cleanup preserves the
outcome and shared-resource lifetime; bounded failure retains ownership when work
has not stopped.

## Consequences

The entry has no business capabilities by itself; domain adapters must register
only complete tools and select their worst-case materialization class. OAuth and
business tools require their separately owned implementations. Clients and
proxies handling future full resources must support the declared result capacity.
