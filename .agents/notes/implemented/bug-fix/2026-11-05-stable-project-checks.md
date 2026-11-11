# Agent Note: Stable Project Management Checks

Status: implemented

## Problem

Project permission checks can interrupt settings and membership interaction
even when the account, role and resources are unchanged. Displaying an earlier
access observation throughout a check cannot itself authorize a later mutation,
and a delayed operation must not act on a different resource or version.

## Decision

Project management retains confirmed access for presentation while the existing
access session continues its foreground and timed checks. Settings resource
reads and conflict reconciliation remain separate from ordinary access checks,
so a revalidation does not replace a draft. Membership and transfer retain their
dialogs, lists and selections during the check. Member and invitation reads
refresh the retained snapshot without hiding it. Mutations lock the original
operation, await identity, active access admission and relevant in-flight resource
reads, and check its role, ownership and resource identity or version before
dispatch. Leaving the route cancels an undispatched confirmation. Settings saves
and ownership transfers independently retain their original Project and user
scope while a dispatched result still needs presentation. Returning to settings
requires an authoritative read without silently rebasing a draft onto another
settings version. Project membership operations record actual dispatch and trusted
receipts separately from publication. Their local pending state ends without
waiting for presentation admission; the panel owns cancellable publication and
checks the original dialog and navigation context before destructive effects.
Confirmed revocation and real failures retain their existing handling. The
[transfer decision](../feature/2026-11-05-web-project-transfer.md) owns the
receipt and unknown-result semantics.

## Alternatives

**Disable management during every check.** This prevents a stale submission but
interrupts focus and interaction even for unchanged permissions.

**Use the displayed access as mutation authority.** A demotion or ownership
change during the check could submit an operation on stale assumptions.

**Discard settings operations on navigation.** A dispatched write may already
have committed, so unmounting its owner would lose both confirmed receipts and
unknown outcomes. Keeping every visited settings page instead would retain
unrelated private state after normal navigation.

## Consequences

The existing UI remains stable across ordinary checks while a user-initiated
write may wait for admission. A dispatched result can keep its settings owner
alive until the original page can present it; the settings and transfer owners
must release independently. Confirmed Project revocation withdraws private
content and invalidates reads without cancelling a dispatched save; its result
waits for renewed access. Identity invalidation still retires the old scope,
and failed checks remain visible. A cancelled membership preparation does not
dispatch; an unconfirmed dispatched write remains unknown, and a confirmed
receipt is not reclassified if later publication fails. The server
continues to enforce authorization and exact version preconditions.

The dispatched-save navigation regression uses the real `AuthenticatedApp`
route transition. It checks request survival, the confirmed receipt, final value
and a single write, including the App's responsibility for retaining the owner.
A panel-only route-flag smoke repeated the save-survival proof without exercising
that owner. The form tests separately retain the Chinese receipt and exact large
version request body, while queued-save cancellation and return-read ordering
remain covered independently. The integration case costs more to localize a
panel defect, but protects both ownership layers with one navigation proof.
