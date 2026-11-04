# Agent Note: Project Invitation Results

Status: implemented

## Problem

A project invitation can be accepted by a person whose effective project role
comes from the owner Team, a direct grant, or both. A flat membership result
cannot distinguish a writable direct relationship from inherited access. A form
reviewed under one account can also be submitted after its credential changes.

## Decision

Project invitation inspection exposes the current principal's nullable direct
grant and effective access alongside the project identity. Acceptance returns
the actual grant and post-write access with joined and consumed flags. The
transaction checks the stored direct grant for the no-op: inherited-only access
still gains a direct member grant, while an existing grant retains its role and
does not consume the invitation. The [membership decision](2026-10-22-project-membership.md)
retains the project lock and invitation lifecycle.

Create, revoke and accept bind `expectedUserId` before domain SQL. The Web
consumer checks response identity, keeps a created link only in its one-time
result, and does not replay a dispatched write whose outcome is unknown. The
[authentication design](../../../../docs/design/daynight-auth.md) owns the
HTTP and browser contracts.

## Alternatives

**Use effective access as the existing relationship.** An inherited Team role
would suppress the direct grant and disappear when the person leaves that Team.
Reading the stored grant preserves the two independent sources.

**Keep the flat member response.** Its role and version conflate stored grant
facts with effective authority and cannot represent inherited-only access.

## Consequences

Existing producers and Web consumers must change together, including invitation
creation and revocation. A lost creation response cannot recover its secret;
reading current metadata cannot prove the original write's outcome. The result
contains no member directory. The [Team invitation decision](2026-11-04-team-invitations.md) owns the separate Team receiver and lifecycle.
