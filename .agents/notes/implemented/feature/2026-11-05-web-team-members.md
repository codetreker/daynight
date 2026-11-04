# Agent Note: Web Team Members

Status: implemented

## Problem

Team members need to see their Team's directory and leave an ordinary Team;
administrators need to manage existing roles without confusing Team membership
with independent Project grants. Concurrent changes and lost responses require
explicit outcomes and current versions.

## Decision

The Team members page reads the scoped directory and its real membership
versions. Administrators can confirm role changes and removals, while members
can confirm their own departure. Personal membership is fixed, and the last
visible administrator is disabled; the server remains authoritative for
concurrent changes. Confirmed receipts produce a success notice independently
of subsequent refresh, update actor context, and navigate a departing actor to
Personal. The operation remains bound to its identity and Team across navigation; a late receipt does not override a newer route or Team selection. Unknown writes stay unknown and offer a read without replay. The
[Team membership decision](../architecture/2026-11-04-team-membership-management.md)
owns the server's authorization and transactional rules.

## Alternatives

**Reuse Project participants as the Team directory.** A Project grant does not
establish Team membership, and participants can include external users or omit
Team members. This would expose the wrong scope and supply the wrong version for
Team mutations.

## Consequences

Members can review nullable profiles and manage relationships within the Team's
actual scope. Independent Project grants survive these operations. Invitation
creation and global user discovery remain outside this page; adding them later
does not require treating Project access as Team membership.
