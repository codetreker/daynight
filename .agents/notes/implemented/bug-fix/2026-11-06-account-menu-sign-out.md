# Agent Note: Account Menu Sign Out

Status: implemented

## Problem

The small topbar sign-out button sat beside the avatar trigger and immediately
discarded the authenticated workspace. An accidental touch could lose an
unsent draft. The account menu omitted sign out, splitting related account
actions across nearby controls and consuming narrow-header space.

## Decision

The account menu places Sign out after Account settings, separated by a divider
and a danger color. The topbar has no independent sign-out button. Selecting the
menu item calls the existing workspace callback; the account page retains its
own sign-out control. Opening the menu then selecting sign out provides two
deliberate actions without changing the authentication lifecycle.

The [original account menu decision](../../archived/feature/2026-11-04-topbar-account-menu.md)
grouped account settings under the avatar while retaining logout's original
placement. This decision changes that placement. The
[Web requirements](../../../../docs/spec/daynight-web.md#工作空间导航) and
[design](../../../../docs/design/daynight-web.md#工作空间导航) own the menu behavior
and callback boundary.

## Alternatives

**Retain the adjacent button.** Direct access saves one interaction but leaves
the small immediate action beside the avatar and duplicates account entry
locations.

**Add a confirmation dialog.** Confirmation would add another focus boundary
and interaction to every exit. The menu already separates opening account
actions from selecting sign out; confirmation is outside this placement change.

## Consequences

Sign out requires opening the account menu. Both items support keyboard
navigation and activation, with Escape restoring the trigger focus. Divider
and danger styling distinguish sign out without relying on color alone.
Progress, failure retry, cross-tab cleanup and successful navigation remain
owned by the existing logout flow. This does not preserve drafts after an
intentional exit or establish a measured reduction in real-device mistouches.
