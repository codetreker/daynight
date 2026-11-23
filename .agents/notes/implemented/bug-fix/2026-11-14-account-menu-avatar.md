# Agent Note: Account Menu Avatar

Status: implemented

## Problem

The authenticated profile already includes an avatar URL, but the workspace
account menu always displayed an initial. Users with an image could not see
their account picture in the shared header.

## Decision

The workspace passes the existing user ID and nullable avatar URL to the
account menu. A local avatar owns loading and failure state for that identity
and exact source, preserving the initial until the image loads and removing a
failed image. A change of identity or source resets only the avatar. The
[Web requirements](../../../../docs/spec/daynight-web.md#工作空间导航) and
[design](../../../../docs/design/daynight-web.md#工作空间导航) own its behavior.
The [original account menu decision](../../archived/feature/2026-11-04-topbar-account-menu.md)
records the placement rationale, and the [sign-out decision](2026-11-06-account-menu-sign-out.md)
retains the menu's action and logout boundaries.

## Alternatives

**Reuse the task assignee avatar.** That component belongs to project-specific
assignee presentation; the global account menu should not depend on that feature.

**Reset the whole menu on source change.** This would also close the menu and
discard its interaction state during profile updates.

## Consequences

The image uses the profile's exact source without a separate profile request or
persistent cache. Empty sources and failed loads retain the initial without a
retry loop. A failed source is retried when the account or source changes, not
on an unchanged revalidation. Other avatar consumers retain their own behavior.
