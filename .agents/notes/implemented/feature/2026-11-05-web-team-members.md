# Agent Note: Web Team Members

Status: implemented

## Problem

Team members need to see their Team's directory and leave an ordinary Team;
administrators need to manage existing roles without confusing Team membership
with independent Project grants. Concurrent changes and lost responses require
explicit outcomes and current versions.

## Decision

The Members & invitations section of Team settings reads the scoped directory
and its real membership versions. The
[settings sections decision](2026-11-10-team-settings-sections.md) owns its
placement, shared navigation and retained section lifetime. Administrators can
confirm role changes and removals, while members can confirm their own departure. Personal membership is fixed, and the last
visible administrator is disabled; the server remains authoritative for
concurrent changes. Confirmed receipts produce a success notice independently
of subsequent refresh and update actor context. A departure navigates to
Personal when the live browser location still shows either settings section of
the departed Team. The operation remains bound to its identity and Team across
navigation; a late receipt does not override an unrelated route or newer Team
selection. Departure fallback discards only the departed Team's pending selection and writes Personal
only when the stored choice still names that Team. The existing save retry retains
this condition after a storage read or write failure, so a subsequent choice is
preserved. Unknown writes stay unknown and offer a read without replay. The
[Team membership decision](../../archived/architecture/2026-11-04-team-membership-management.md) records the rationale for the server's authorization and transactional rules.
The [role alignment decision](../bug-fix/2026-11-05-team-member-role-alignment.md)
owns roster layout and select spacing.

## Alternatives

**Reuse Project participants as the Team directory.** A Project grant does not
establish Team membership, and participants can include external users or omit
Team members. This would expose the wrong scope and supply the wrong version for
Team mutations.

**Persist Personal unconditionally after departure.** The originating tab can
retain Team A in memory on Shared projects or a Task while another tab stores
Team B. An unconditional write loses B despite the successful exit concerning
only A. Rechecking only the first attempt would still lose B when storage fails
and the user retries after choosing B.

## Consequences

Members can review nullable profiles and manage relationships within the Team's
actual scope. Independent Project grants survive these operations. The
[invitation management decision](2026-11-05-web-scoped-invitations.md) adds
scoped invitations without treating Project access as Team membership. Global
user discovery remains outside this section.

The next default workspace restores a newer saved Team, and a missing preference
remains missing. This protection compares the current stored value on each
attempt; it does not synchronize visible Team context across tabs.
