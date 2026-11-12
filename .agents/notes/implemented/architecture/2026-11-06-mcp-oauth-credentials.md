# Agent Note: MCP OAuth Credential Families

Status: implemented

## Problem

MCP access needs a revocable credential that preserves the user's existing
permissions and cannot be used at other service entry points. Authentication at
HTTP admission alone cannot protect a business operation that waits for a lock
while its credential expires or is revoked. Authorization code exchange must
also be able to issue all family records atomically with consuming the code.

## Decision

OAuth grants, access tokens and initial refresh tokens are stored as a family.
Only secret hashes are persisted. Issuance and revocation use caller-bound
transaction DAOs, allowing code consumption and family creation to commit or
roll back together. The grant retains the validated client snapshot, resource,
scope and absolute expiry for MCP. The internal
[fixed API profile](2026-11-12-api-oauth-family.md) shares these family records
with a separate binding and rolling deadline policy. Access authentication checks
its resource, scope and any fixed client binding;
the principal identifies the access credential while the MCP authority reference
identifies the stable grant. Nullable grant usage metadata persists independently
of access and refresh rotation; its [persistence decision](2026-11-12-credential-usage-persistence.md)
describes its write and lock isolation.

The initial business adapters locked the access row without acquiring a grant
lock in reverse order. Thread and Bot checks retain that protocol, and family
revocation locks the grant and invalidates access rows in one transaction. Task
Session send and receipt checks use the later
[grant-before-token protocol](../bug-fix/2026-11-10-task-oauth-family-locks.md):
their dispatch path reauthorizes an original Actor after acquiring the Session,
so token-only locking can deadlock with partial deletion of a rotated family.
Business checks re-evaluate expiry after waiting. The shared CredentialReader
joins the actual family and user and returns the earlier access/grant deadline
while retaining its original access-only shared locks and snapshot behavior.
REST and private Worker admission retain their existing credential boundaries.

## Alternatives

**Authenticate only at the HTTP entry.** A credential could expire or be
revoked while a Thread or Bot operation waits for its business locks, allowing a
write after the authority has ceased to be valid.

**Give OAuth an independent identity or use PATs as access tokens.** Either
would duplicate business authorization or widen an MCP credential to ordinary
REST and Worker routes. A distinct credential kind retains the existing user and
permission checks while restricting its entry point.

## Consequences

The family interface is available to authorization code and refresh lifecycle
implementations without committing their transactions. Revocation contends with
in-flight business credential locks, and secret loss after a committed issuance
cannot be repaired by reading the stored hashes. Public OAuth discovery, code
exchange and refresh endpoints remain owned by their respective delivery stages.
