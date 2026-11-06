# Agent Note: MCP OAuth Browser Consent

Status: implemented

## Problem

An MCP client needs to discover the authorization server and obtain a user's
explicit decision through the existing Daynight account. A browser decision can
commit even when its response is lost, and client-supplied display names cannot
establish the identity of the callback recipient.

## Decision

The production server composes public registration, authorization, token and
revocation endpoints with discovery and the MCP authentication challenge. The
browser consent route uses the existing session and the request-specific browser
binding. It displays the current account, client, actual callback and resource;
decisions include the displayed user ID and require the exact site Origin.
Configured client metadata is validated at startup alongside dynamically
registered and HTTPS metadata-document clients. The displayed source identifies
the mechanism without treating the client-supplied name as verified.

An uncertain decision is reconciled by reading request state. An approved state
does not prove code delivery or client connection, and recovery requires a new
request from the client. The [authorization code decision](2026-11-06-mcp-oauth-authorization-code.md)
owns one-time code and transaction semantics; the [grant lifecycle decision](2026-11-06-mcp-oauth-grant-lifecycle.md)
owns token renewal, revocation and maintenance.

## Alternatives

**Recover and resend the original code.** Persisting recoverable bearer material
would weaken the one-time delivery guarantee; current state cannot reconstruct a
lost response.

**Publish discovery before the consent journey is usable.** A standard client
would find an authorization server that cannot complete its browser flow.

## Consequences

Clients can complete authorization using the existing account without receiving
a PAT. A lost decision response can require the user to start a new connection;
approval alone does not establish that the client received credentials.
