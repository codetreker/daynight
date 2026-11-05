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
dispatch. Leaving the route cancels an undispatched confirmation. Confirmed
revocation and real failures retain their existing handling. The
[transfer decision](../feature/2026-11-05-web-project-transfer.md) owns the
receipt and unknown-result semantics.

## Alternatives

**Disable management during every check.** This prevents a stale submission but
interrupts focus and interaction even for unchanged permissions.

**Use the displayed access as mutation authority.** A demotion or ownership
change during the check could submit an operation on stale assumptions.

## Consequences

The existing UI remains stable across ordinary checks while a user-initiated
write may wait for admission. Real authorization changes still affect controls
and invalidate stale operations; failed checks remain visible. The server
continues to enforce authorization and exact version preconditions.
