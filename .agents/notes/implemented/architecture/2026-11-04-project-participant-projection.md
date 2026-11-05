# Agent Note: Project Participant Projection

Status: implemented

## Problem

A member row mixes profile display, current authority and a writable grant
observation. A roster consumer cannot safely treat one effective role or version
as all three. Dropping a source whose user profile is missing also makes damaged
authorization data appear to be a valid smaller directory. A form rendered for
one account can otherwise submit after its browser credential changes accounts.

## Decision

The existing project-members route returns one `ProjectParticipant` per source
user: `userId`, a required `profile` object with nullable name/email/avatarUrl,
`effectiveRole`, nullable `inheritedFrom:{team:TeamRef,role}` and nullable
`directGrant`. Real owner Team members and direct
grants supply the source identities; inherited-only participants have a null
direct grant. Raw source identities survive a LEFT JOIN to users; missing or
mismatched canonical identity fails the complete roster. Existing canonical
access SQL owns the effective role, while the stored grant owns its independent
role, exact positive int64 version and timestamps.

Management edits and removals review the direct grant's role/version. Legacy
PATCH returns `ProjectGrant`; DELETE retains 204. Both require canonical
`expectedUserId` and compare it to the authenticated principal before the domain
transaction. The new fault is mapped and logged as 409 `identity_mismatch`.
Web verifies response principal on JSON and empty results, ends a mismatched
identity lifetime and does not replay a dispatched unconfirmed write. Read-only
reconciliation reports current facts and may supply a new observation to review;
it does not recover the original commit receipt.

Caller authority remains with the existing access owner. Claim-owner names,
email, loading, failure/retry and former-user display remain project-scoped
profile observations. Invitation direct-relation readers do not supply a second roster or a fallback decoder.
The [invitation result decision](2026-11-04-project-invitation-results.md) owns its separate grant and access responses.
The [Personal ownership decision](2026-11-04-personal-project-ownership.md)
activates real inherited access and permits removal of the final direct admin.

The roster envelope contains items and same-snapshot actorAccess. MembersPanel
publishes that observation through the existing access owner and identity fences
before displaying management controls. The
[public ownership decision](2026-11-04-public-project-ownership.md) owns the
coordinated source expansion and derived cache rebuild.

## Alternatives

**Keep a flat member role and writable version.** This makes an effective role
appear to be a stored grant and cannot represent a missing direct grant without
inventing a version. Separate fields preserve the distinct facts.

**Return null profile or silently omit an orphan source.** Nullable user fields
are valid data, but a missing canonical user is an integrity failure. Hiding that
failure would misidentify it as an ordinary absent or former participant.

**Replace claim profiles with the assignee resolver.** That scoped resolver does
not supply the claim owner's email and has a different purpose. Retaining the
actual profile reader preserves its visible loading, retry and former state.

**Convert invitations and add new grant routes at the same time.** Those changes
have independent existing callers and lifecycle contracts. Keeping their current
DTO/read owners allows this roster and observation conversion to stand alone.

**Publish roster actor metadata without its live consumer.** An unused field
would not establish the snapshot-consistency guarantee. Its later coordinated
read-contract change must publish through the existing access fences; this
projection preserves that seam instead of creating another permission owner.
The separate [grant management decision](2026-11-04-project-grant-management.md)
adds grant routes without changing the existing invitation DTOs.

## Consequences

Profiles can be unavailable without becoming authorization decisions. Versioned
writes use real grant observations and cannot cross a changed actor identity.
The CLI keeps its existing roster facade with a participant result, and Web's
lossless decoder handles grant versions only at the declared resource path.
The original projection introduced no Team data or source placeholders.
Real inheritance now uses the same nullable-grant shape; no compatibility roster,
new command or persistent actor cache is needed. The complete roster/access envelope updates its actual consumers together
while retaining these identity and publication fences.
