# Agent Note: Stable Workspace During Identity Checks

Status: implemented

## Problem

Returning to a visible, focused workspace starts an identity check even when the
account and permissions are unchanged. Treating that pending check as the end of
a page or overlay lifetime interrupts the user's navigation, editing and focus.
The check must still prevent requests and results from crossing an identity
change and must allow recovery from a real failure.

## Decision

Workspace presentation follows the actual route, resource, explicit user action,
identity loss and blocking recovery. Ordinary identity checking does not end the
active lifecycle of settings or member pages, the Team creation dialog, or the
narrow navigation overlay, and does not suspend management dialogs. An unchanged
identity and data retain the existing interface throughout the wait and recovery
reads. The overlay retains its focus containment, background isolation and scroll
lock until it is closed or blocking recovery needs its own focus.

Request and publication admission remain independent of presentation. Existing
identity generation, principal checks, `admissionBlocked`, `readEnabled`,
`TaskCacheScope.ready/signal` and the shared request gate continue to enforce
identity and resource boundaries. Team settings, member and invitation reads
retain their displayed data while recovery rechecks fresh authorization and
versions; stale member confirmations cannot submit. Project settings, membership
and transfer results wait for scope admission and recheck current access before
publication where required. A confirmed settings write awaiting access is reread
without replaying it. A confirmed change, loss of access or failure retains its
existing isolation and recovery behavior. The [UI principles](../../../../docs/ui-design.md#keep-rendered-interfaces-stable-during-background-checks),
[authentication requirements](../../../../docs/spec/daynight-auth.md#web-交互与状态)
and [design](../../../../docs/design/daynight-auth.md) own the current contracts.

This replaces the checking-time drawer closure in the [sidebar preference](../../archived/feature/2026-10-25-sidebar-preference.md)
and [foreground verification](../../archived/bug-fix/2026-10-23-silent-foreground-identity-checks.md)
decisions, and extends the [authenticated workspace](../../archived/feature/2026-10-22-web-auth-workspace.md)
presentation policy.

The later [document account synchronization decision](../architecture/2026-11-11-document-account-sync.md) replaces foreground identity revalidation and its blocking recovery overlay; the earlier rationale below is retained as decision history.

## Alternatives

**Close the navigation overlay at the start of every check.** The original
policy ensured its focus trap and background lock could not compete with a later
identity recovery dialog. It also dismissed an active navigation interaction on
every ordinary return. Releasing it when recovery actually blocks retains the
same separation without that interruption.

**End presentation on a pending check.** Hiding or suspending pages and dialogs
would conflate the need to gate requests with the lifetime of already displayed
content, interrupting drafts and focus even when nothing changes.

## Consequences

Normal checks preserve the user's current workspace and local interaction while
continuing authentication and authorization. A visible retained interface does
not itself authorize a request, publication or mutation. Until a check confirms
an account change, previously displayed content remains visible; confirmed
identity loss and access revocation still remove or isolate it. A failure closes
the temporary navigation overlay before blocking recovery, while retained
component state can be restored after successful recovery.
