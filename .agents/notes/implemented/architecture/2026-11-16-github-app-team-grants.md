# Agent Note: GitHub App Team Grants

Status: implemented

## Problem

An independently managed GitHub App can serve several Teams without giving its administrators access to private Project contents. Revocation must stop work authorized by the old grant even when connections, ownership, or other operations change concurrently. A reusable authorization identity would let stale requests regain access after a later grant.

## Decision

Each Team grant has a permanent identity and a revoked tombstone. Grant changes use a Team-to-App transaction and recheck the administrator and original versions before changing the grant. Revocation stops the grant's connections and advances their fences in the same transaction. Impact previews count the full affected set but filter Project details by current access before pagination. The [design](../../../../docs/design/github-app-team-grants.md) describes the lock order, projection and adoption boundary.

## Alternatives

**Reactivate a revoked grant.** A stale grant UUID could become valid again after reauthorization, allowing an old request or execution identity to refer to new authority.

**Read all affected Projects and filter in the application.** This would materialize private details outside the database permission filter and make bounded pagination and hidden counts unreliable.

## Consequences

The immutable grant and short root locks preserve identity and collection consistency at the cost of serializing related changes. Project connection and resource-retirement operations participate in the same lock order and impact-version contract. The App workspace exposes grant management after the coordinated protocol cutover; its Team-ID preview avoids a global directory, and grant revocation shares Project visibility checks and presentation with App removal. Workspace-owned result notices preserve confirmed and unknown outcomes across section changes and permission loss.
