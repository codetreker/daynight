# Agent Note: Stable Team Management Checks

Status: implemented

## Problem

Team settings and member management can have loaded content, an open confirmation,
or an uncertain write when identity and resource checks start. Replacing those
views with loading interrupts editing and can hide an invitation receipt even
when the account, role and returned data are unchanged. Displaying old content
must not authorize a write against stale membership or a lost receipt.

## Decision

Team settings, roster and invitation reads distinguish initial loading,
background revalidation and explicit reconciliation. Loaded content and local
interaction remain visible during background reads; confirmed role determines
whether the invitation area is displayed. Request and publication admission,
fresh versions and the original operation's pending or unknown result continue to
govern writes. Reconciliation reads current facts without replaying a mutation or
claiming to recover its receipt. Actual denial, changed role and read failures
retain their respective handling.

This applies the [workspace presentation decision](2026-11-05-stable-workspace-during-identity-checks.md)
to [Team management](../feature/2026-11-04-web-team-management.md),
[members](../feature/2026-11-05-web-team-members.md) and
[invitations](../feature/2026-11-05-web-scoped-invitations.md). The
[Team browsing decision](2026-11-05-stable-team-checks.md) owns directory and
selection revalidation.

## Alternatives

**Show loading for every read.** This makes request progress visible but moves
or hides existing controls and interrupts an unchanged confirmation or draft.

**Keep old content without rereading.** This avoids interruption but fails to
observe actual role, membership or invitation changes and cannot establish
fresh write admission.

## Consequences

Background checks continue to consume network requests and can reveal a real
failure or permission change. Retained presentation is not permission to submit;
the current identity, resource scope and fresh versions still control writes.
An unknown result remains distinct from the current facts returned by a later GET.
