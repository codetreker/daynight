# Agent Note: Direct Team Membership for External Identities

Status: implemented

## Problem

An administrator needs to add a known external identity to an ordinary Team even
when that identity has no local account. Account initialization must be complete,
and the administrator must still have valid credentials and current authority
when the member relationship commits. Repeating an addition must preserve a
matching relationship without silently replacing a different role.

## Decision

The direct-member API accepts the actor's expected UUID, an exact external-user
input and an explicit admin/member role. The target identity never becomes the
actor. The dedicated DirectMembers service coordinates three phases: a short
original Team scope checks current credential and ordinary-Team administrator
access, independently committed EnsureUser initializes the complete target
account and Personal Team, then an original Team scope rechecks current authority
and adds or reads the membership with eligibility in the same transaction.

TeamWriteScope binds the existing identity and credential-family DAOs to its
transaction while preserving the Team prelock. Native Session/PAT admission uses
the existing reader-compatible SHARE capability; internal API admission uses the
fixed API resource/scope/client tuple. A fresh credential check after member and
eligibility contention prevents expiry during those waits from authorizing the
commit. The initial refusal creates no target account. A later refusal may retain
a complete independently committed account while rolling back the member phase.

Core checks the real target member under the Team scope. A matching role returns
the original membership and added=false. An absent relationship is inserted with
an explicit role and added=true. A different role is a resource_conflict with no
member write; the existing versioned PATCH owns role changes. Invitation
acceptance uses the same explicit-role AddMember primitive with member and
retains its recipient, expiry, version and consumption rules.

The [authentication requirements](../../../../docs/spec/daynight-auth.md#team-生命周期)
and [design](../../../../docs/design/daynight-auth.md#管理员直接添加-team-成员)
own the API and transaction details. The [Team boundary decision](../architecture/2026-11-05-server-team-boundaries.md)
retains the original scope and completion responsibilities; the
[complete account decision](2026-11-12-user-profile-patch.md) owns EnsureUser and
the native credential-reader lock rationale.

## Alternatives

No alternative mechanism was considered.

## Consequences

A confirmed response identifies the actual target UUID and stored membership
version and timestamps. Same-role additions converge without advancing those
values, while different roles require an observed-version change. Team metadata,
Personal immutability, final-admin protection and independent Project grants
retain their existing rules. Direct addition creates and consumes no invitation.

Independent target initialization costs a separate transaction and can leave a
complete account after a late membership rejection. This preserves the account's
own completion boundary without permitting partial membership or eligibility.
Unknown commits remain visible and stop subsequent work; response loss after a
confirmed member commit does not repeat the operation. Normal integration uses
real PAT authentication and independent member-directory readback, while Core,
service and PostgreSQL tests own refusals, completion failures and concurrency.
