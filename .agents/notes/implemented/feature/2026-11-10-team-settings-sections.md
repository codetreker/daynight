# Agent Note: Team Settings Sections

Status: implemented

## Problem

Team information, membership and invitations are managed in separate navigation
locations even though they describe the same Team. The settings page has only
basic information and deletion, while the roster already hosts invitations.
Grouping these functions must preserve ordinary-member access and operation
ownership when the visible section changes.

## Decision

The workspace sidebar has one Team settings entry for ordinary Teams. General is
the default section at `/teams/{teamId}/settings`; Members & invitations uses
`/teams/{teamId}/members`. Both share a Team settings heading, the current Team
name and horizontal native navigation links, and both select the sidebar entry.
General contains saved name and ID information plus a separate deletion panel at
the bottom. The other section keeps the roster and admin-only invitations
together. Ordinary members can enter settings to read the directory and leave;
Project grants do not confer Team access. The
[Personal visibility decision](2026-11-05-personal-team-sidebar.md) continues to
hide the sidebar entry for Personal, while both explicit URLs retain their
existing access rules.

A stable owner is bound to the authenticated identity and Team. It mounts each
section on first visit and keeps visited sections while either section for that
Team is current. Inactive sections are hidden and inert, with their dialogs
suspended. Section navigation preserves drafts, confirmations, pending or unknown
writes and one-time links. Retained state does not establish permission: new
writes wait for current Team, membership and invitation admission. Leaving Team
settings retains the owners required by protected operations or receipts; identity
invalidation still disposes of the old scope. Background checks follow the
[stable Team management decision](../bug-fix/2026-11-05-stable-team-management-checks.md).

A confirmed leave or delete updates directories and safely clears the affected
Team choice. Its completion inspects the live browser location: either settings
section for that Team returns to Personal; unrelated destinations remain in
place. A hidden section cannot take focus on completion. The
[Team member decision](2026-11-05-web-team-members.md) retains the membership and
conditional preference rules, and the
[invitation decision](2026-11-05-web-scoped-invitations.md) retains one-time secret
and uncertain-result semantics.

## Alternatives

**Place every panel on one settings page.** Long rosters and invitation lists
would separate basic information and deletion from their navigation context and
make each management activity harder to locate.

**Give basic information, members, invitations and deletion separate sections.**
Invitations already belong to membership management, and deletion alone does not
need another navigation destination. Four sections add switching without a
corresponding division of responsibilities.

**Nest the member URL beneath the settings URL.** Native navigation and the shared
shell express the grouping with the existing two URLs. An address migration
would add routing changes without improving the visible organization.

## Consequences

Team management has one discoverable entry and two bounded activities. The same
horizontal navigation fits desktop and narrow layouts, and existing direct URLs
continue to locate their section after reload or browser history traversal.
Lazily retained sections add explicit lifetime ownership so a visual switch
cannot discard an unresolved write or invitation receipt. Disposal and callback
routing must respect identity, Team and current destination independently of
which section originally submitted an operation.
