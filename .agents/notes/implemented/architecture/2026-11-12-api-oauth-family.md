# Agent Note: Fixed API OAuth Family

Status: implemented

## Problem

A trusted application needs revocable authorization tied to a real user's
permissions, with a renewal window that supports continued use beyond the first
30 days. Its credentials must remain distinct from MCP authorization and native
account or producer credentials. Refresh rotation must retain replay detection
without letting a long-expired token revoke a currently renewed family.

## Decision

The existing OAuth family stores both fixed profiles. MCP keeps its resource,
recorded client, scope, secret prefixes, client metadata, authorization-code and
PKCE behavior, and absolute deadline. The API profile fixes the Societas client,
API resource, scope and secret prefixes. It stores only the true client ID and
name in its snapshot. The [authentication design](../../../../docs/design/daynight-auth.md#oauth-family-的固定-profile-与内部-api-能力)
owns their exact values and current operation contracts.

Internal API issuance, authentication, rotation and revocation are real family
operations. The service issuer confirms its transaction before returning secrets.
Public REST authentication still uses PATs or browser Cookies. The S2S issuance
route is not exposed, and existing public OAuth refresh/revoke adapters admit
only the MCP profile. The API
profile uses the same real user and access UUIDs and the existing OAuth
Principal kind; it supplies no independent execution or administrative identity.

Binding-aware family operations validate actual access, grant and user facts.
They return the earlier access/grant deadline. Shared credential readers join
those records at their existing call sites and retain their original snapshot,
access-only lock and completion behavior. The family-specific shared-lock path
retains grant-before-access ordering and a fresh check after both locks. This
extends the [MCP credential decision](2026-11-06-mcp-oauth-credentials.md) without
replacing the existing business transaction and permission checks.

API refresh uses the existing grant-update then refresh-update lock order. After
those locks it obtains a fresh database time, checks the original deadlines and
bindings, and atomically consumes the submitted refresh, updates the grant
expiry, and inserts new access and refresh hashes. The grant and new refresh
expire 30 days after that time; the new access expires one hour after it. The
grant creation timestamp and every older token deadline remain unchanged. The
schema lifetime exception is restricted to the fixed API client and scope;
non-API grants retain the creation-based 720-hour upper bound. The migration
preserves historical IDs, values and nullability and adds no foreign keys.

A consumed refresh retains replay significance only until its own original
expiry. A matching replay during that window commits family revocation before
refusal; an expired replay fails without revoking a renewed family. The
[MCP lifecycle decision](2026-11-06-mcp-oauth-grant-lifecycle.md) continues to own
the common one-use, completion, maintenance and public-client admission rules.

## Alternatives

**Issue PATs or browser sessions for the application.** PATs lose the independent
application family and renewal semantics; browser sessions mix application access
with native account authority. Both obscure the application grant shown to its
owner.

**Replace ordinary business authorization with a new framework.** Existing
business operations already accept OAuth user principals and enforce user
permissions. A separate per-domain authorization layer would duplicate those
rules and change transaction and lock responsibilities without supplying the
fixed profile or rolling-expiry behavior.

**Extend every historical refresh deadline when the grant renews.** This would
keep old replay credentials significant indefinitely and prevent cleanup from
reclaiming them at their recorded deadline. Each token instead retains the
validity window under which it was issued.

## Consequences

The API family can renew beyond its original grant creation deadline while MCP
families preserve their original lifetime and protocol behavior. Native account
and producer boundaries remain separate. Existing owner lists read the true
client projection and current expiry without a second application metadata model.

Concurrent use of the same refresh cannot produce two successful rotations. A
later valid replay can revoke the family renewed by the first request. Secrets
are not recoverable from their hashes: rollback or unknown completion returns no
secrets, and a lost committed response requires a new explicit authorization.
Ordinary access, failed refreshes and last-use metadata do not extend deadlines.
Cleanup continues to use each row's own deadline and its existing bounded work
budget. The fixed profile and schema exception must be revised together if an
additional application or audience is introduced.
