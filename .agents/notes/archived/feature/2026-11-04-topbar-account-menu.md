# Agent Note: Topbar Account Menu

Status: implemented

## Problem

Account settings are personal controls, but the workspace offered separate
account entries in the sidebar and the topbar. The sidebar entry consumed space
in both expanded and folded navigation, while the topbar avatar directly opened
the account page and could not host account actions.

## Decision

The topbar avatar and name open a localized account menu. Its Account settings
item navigates to the existing `/account` page. The expanded and folded sidebar
no longer contain an account entry. The trigger exposes its accessible name and
expanded state; keyboard access, outside-click and Escape dismissal, focus
restoration after Escape, and route-change dismissal make the menu usable across
viewport sizes. Account identity, the account page and logout retain their
existing ownership.

The original placement retained the adjacent topbar logout action. The
[sign-out placement decision](../../implemented/bug-fix/2026-11-06-account-menu-sign-out.md)
moves that action into this menu while preserving authentication ownership.

This replaces the sidebar entry and direct topbar shortcut selected by the
[bottom account navigation decision](2026-10-25-bottom-account-navigation.md),
whose original rationale and layout trade-offs remain recorded there. The
[Web requirements](../../../../docs/spec/daynight-web.md#工作空间导航) and
[design](../../../../docs/design/daynight-web.md#工作空间导航) own current
behavior and structure.

## Alternatives

**Keep the sidebar entry and direct topbar shortcut.** The previous placement
provided a stable bottom-left destination, but retained two account entry points
and did not provide a menu for the topbar avatar. The requested placement groups
account settings under the identity control and releases the sidebar space.

## Consequences

Account settings remain reachable in desktop and narrow layouts through one
identity control. The additional menu interaction requires keyboard access,
dismissal and focus handling, and placement within the viewport. The change
adds no account API or authentication lifecycle.
