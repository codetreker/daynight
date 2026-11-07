# Agent Note: MCP OAuth Public Clients

Status: implemented

## Problem

Public OAuth clients need a trustworthy callback binding without treating a
self-declared name as an identity. Remote client metadata and unauthenticated
registration also introduce network and storage costs before a user authorizes
an application. Client cleanup must not race initial grant issuance.

## Decision

Client resolution accepts configured clients, dynamic public registrations,
and HTTPS client metadata documents. It freezes the validated metadata digest,
provenance, allowed redirects, selected exact redirect, and metadata deadline for
an authorization request. HTTPS redirects match exactly; literal loopback HTTP
redirects may differ only in port. Names remain self asserted.

CIMD retrieval rejects unsafe DNS answers and connects to a validated address
with the original TLS hostname, no proxy or redirect. Per-instance concurrency,
response size, time, and cache lifetime are bounded. Persistent public budgets
precede allocation, network retrieval, and secret lookup. Registration stores
only public clients, and an omitted authentication method is explicitly replaced
with `none` in the returned configuration.

DCR allocation and cleanup share a capacity lock. Cleanup locks each candidate
and checks its current expiry and active grant references after the lock wait.
Initial issuance must use the provided pin operation to hold the DCR row through
the transaction that creates its grant; configured and CIMD clients have no DCR row. The [credential family decision](2026-11-06-mcp-oauth-credentials.md)
owns grant and secret lifecycle semantics. The [authorization lifecycle](2026-11-06-mcp-oauth-grant-lifecycle.md)
schedules cleanup; the [browser integration decision](2026-11-06-mcp-oauth-browser-consent.md)
owns the production OAuth profile.

## Alternatives

**Trust a pre-lock cleanup candidate.** A concurrent initial grant can commit
while cleanup waits, leaving a valid grant whose registered client was deleted.
The fresh post-lock reference check and issuance pin close that race.

**Follow metadata redirects or resolve again at dial time.** Either permits the
network target to differ from the address that passed validation, including a
private service reached through DNS rebinding or an ambient proxy.

## Consequences

The validated client snapshot is independent of later metadata changes, and
expired unreferenced registrations can be reclaimed without deleting referenced
clients. Budget and capacity state are shared across server instances. Network
availability and metadata expiry can prevent a new authorization; clients whose
unused registration has expired must register again. Client registration itself
does not grant access, and the self-declared name is not verified branding.
