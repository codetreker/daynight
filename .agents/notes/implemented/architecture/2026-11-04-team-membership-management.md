# Agent Note: Team Membership Management

Status: implemented

## Problem

Team members need to see their colleagues and leave an ordinary Team, while
administrators need to manage existing roles and removals. A Project grant does
not imply access to the owner's Team directory. Concurrent departures or
self-demotions must not leave an ordinary Team without an administrator, and an
old request must not act on a membership deleted and created again.

## Decision

The Team member API reads a complete directory only for current Team members,
with nullable profile fields and real membership versions. It does not create
members or expose a global user directory. Administrators may change an existing
role or remove a member; a member may also remove their own membership. Personal
Team membership is immutable. Writes compare the expected actor before domain
SQL and compare the observed membership version before accepting a no-op.

Membership mutations use the Team existence lock and recheck authority and the
number of administrators inside that transaction. The last administrator cannot
be demoted or removed. Membership versions come from the existing monotonic
sequence, including after deletion and rejoining. Responses report the actor's
remaining Team role only after a confirmed commit. Independent Project grants
are not changed by membership operations.

The [Team lifecycle decision](2026-11-04-team-lifecycle.md) owns the shared Team
lock and transaction completion rules; the [authentication design](../../../../docs/design/daynight-auth.md#team-元数据与生命周期事务)
describes the implementation and the [requirements](../../../../docs/spec/daynight-auth.md#team-生命周期)
own the public behavior.

## Alternatives

**Count administrators without serializing on the Team.** Concurrent admin
self-demotions or departures could each observe another admin and both commit,
leaving no administrator. The existing Team lock serializes the check and write.

**Copy membership changes into Project grants.** Grants are independent facts;
rewriting them would destroy access that should survive leaving a Team and
would require writes across all of the Team's Projects.

## Consequences

Directory access remains scoped to membership and concurrent Team mutations
preserve an administrator without locking Projects. Clients must use the real
membership version and reconcile an unknown write outcome before making a new
explicit decision. Invitation acceptance remains the only member-creation path.
