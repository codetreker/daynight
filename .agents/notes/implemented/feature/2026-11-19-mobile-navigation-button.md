# Agent Note: Mobile Workspace Navigation Button

Status: implemented

## Problem

A permanent navigation rail takes 60px from narrow workspace content. Its bottom
expansion control also separates navigation entry from the visible page header.
Removing that column requires a reachable entry throughout document scrolling
and the assistant and Test session pages' independent scroll layouts, while
preserving navigation, Team interactions and keyboard access.

## Decision

At 740px and below, the authenticated topbar reserves a 44×44px hamburger button
before the breadcrumbs. Its sidebar-dark surface, white icon, 8px radius and
light shadow identify a separate navigation action. Document pages use a sticky
topbar; independent session shells keep their existing visible header. Content
occupies the first and only grid column, including the small-screen generic
layout. Closed navigation is hidden and cannot receive focus.

The existing single `WorkspaceNavigation` opens in a 220px left modal drawer
with a dedicated 44×44px close button. Workspace owns `useWorkspaceDrawer` and
shares temporary state, the opener reference and dismissal reasons with
`WorkspaceSidebar`. Dismissal by close
button, backdrop or Escape releases background inert before restoring a visible
opener. Ordinary route navigation closes the drawer and uses target content
focus; modified links keep native behavior. Team popover Escape precedence and
Team creation focus handoff remain inside their existing owners.

The drawer keeps modal semantics, a visible-control focus loop and the shared
reference-counted body scroll lock. Route changes, crossing the 740px breakpoint,
actual identity blocking or account changes, and unmount clean up its state and
isolation without focusing hidden controls. Unchanged-account background checks
retain the open drawer. Desktop widths remain 190px and 68px, and mobile actions
never write the desktop appearance preference.

This replaces the narrow 60px rail in the archived
[sidebar preference decision](../../archived/feature/2026-10-25-sidebar-preference.md).
That decision's local persistence, separate mobile state and shared lock
rationale still apply. The [sidebar scopes](../architecture/2026-11-12-sidebar-navigation-scopes.md)
and [Team popover](2026-11-05-team-switcher-popover.md) decisions retain their
navigation and data ownership. The [Web requirements](../../../../docs/spec/daynight-web.md#工作空间导航)
and [design](../../../../docs/design/daynight-web.md#工作空间导航) own current behavior
and mechanisms.

## Alternatives

**Keep the mobile rail and its bottom toggle.** This preserves the existing
entry but continues to reserve 60px on a 320px screen and leaves the expansion
control apart from the page header.

**Reuse the desktop collapsed value for the drawer.** Mobile opening would
overwrite the stored desktop width and restore an unintended layout after a
breakpoint change. Separate temporary drawer state preserves the browser's
desktop choice.

## Consequences

Narrow pages recover the navigation column's width while retaining one visible
header and one navigation data consumer. The drawer, opener and background
isolation now cross component boundaries, so focus restoration must run after
inert cleanup and distinguish dismissal from route navigation. Hidden controls
must stay outside keyboard navigation, and breakpoint cleanup must preserve
other overlays' scroll locks. Desktop persistence and business data contracts
remain independently owned.
