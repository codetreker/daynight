# Agent Note: Web Team Member Search

Status: implemented

## Problem

Team administrators need to find and add an existing account without knowing
its external identity. Names and email addresses do not uniquely identify an
account, and a lost write response cannot establish whether membership changed.

## Decision

The Team members section searches existing account profiles and adds the selected
local UUID. The complete Team roster owns the displayed membership fact. A
separate retained operation owns addition results across searches and section
navigation; unknown results permit only a read of current membership. Search
and publication are scoped to the original identity, Team and current permission.
The [Web design](../../../../docs/design/daynight-web.md) describes the owners and
continuity rules; the [server search](2026-11-17-team-member-candidates.md) and
[addition](2026-11-17-existing-team-members.md) decisions own the API choices.

## Alternatives

**Use the external identity addition operation.** It may initialize an account
and requires an exact external identity, so it cannot express choosing an
existing local account from profile search.

**Store membership in each search result.** The panel already reads the complete
roster; a second membership snapshot could conflict with concurrent changes and
would require another reconciliation owner.

**Treat a later roster read as the original write result.** A concurrent change
can produce the same current state without proving the original outcome. It would
also allow a second submission while the first may still commit.

## Consequences

Administrators can distinguish identical profiles by UUID and add the intended
account without changing independent Project grants. Search remains usable while
an addition is unresolved, but the retained unknown result prevents another
management write until its original scope can be safely handled. After confirmed
loss of administrator permission, the retained record does not prevent a member
from leaving the Team.
