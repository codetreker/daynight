# Agent Note: Team Member Result Ownership

Status: implemented

## Problem

A member write can finish after the user has left and revisited the Team settings
workspace. Its receipt remains meaningful for the original Team, but closing a
confirmation or changing the current Team choice and route can overwrite a later
interaction. A confirmed departure must also prevent reuse of its old authority.

## Decision

The member panel captures its immutable confirmation and the admitted browser
navigation snapshot at submission. It accepts the receipt under the existing
identity, Team and membership-version checks. Closing the confirmation and the
departure selection reset and navigation require both captured values to remain
current. A retained original confirmation becomes stale when navigation changes;
a confirmed departure removes the obsolete roster and write freshness and denies
management across the retained Team workspace. A newer confirmed membership
prevents an old departure from withdrawing it. After departure, an admitted Team
read restores the workspace only for a higher membership version; failures leave
the departure in force and can be retried. The success notice and Team list
refresh remain available independently of navigation.

This refines the [member decision](../feature/2026-11-05-web-team-members.md)
and the [settings sections decision](../feature/2026-11-10-team-settings-sections.md).
The earlier live-location check protected unrelated destinations but also treated
returning to the same Team or changing its section as unchanged navigation.

## Alternatives

**Use only the current Team or URL.** A user can leave and return to the same
address while a write is pending, so equality at receipt time would still allow
the old operation to replace the user's later choice.

## Consequences

Member facts remain visible or are withdrawn according to the confirmed receipt,
while later navigation is preserved. A retained confirmation cannot repeat a
completed operation. The original delivery retained the shared operation's pending
and admission timing; the [local settlement decision](2026-11-12-team-operation-local-settlement.md)
subsequently separated settlement from publication. Other consumers retain their
own presentation handling.
