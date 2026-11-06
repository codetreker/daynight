# Agent Note: Team Switcher Popover

Status: implemented

## Problem

Expanding the Team list in the sidebar's document flow displaces navigation and
can be clipped by its scroll containers. Collapsed desktop and mobile rail users
must first expand navigation to reach the list. The selector must remain usable
without disturbing navigation state or losing loaded pages during background
checks.

## Decision

The Team trigger opens a viewport-positioned, non-modal top-layer popover in
all sidebar layouts. The menu remains a DOM descendant of the sidebar so the
mobile drawer's focus isolation includes it. Its own scrolling contains long
lists, and positioning responds to viewport, scroll and content size changes.
Escape closes the menu before the drawer and restores the trigger. Links retain
native modified-click behavior; creation passes focus to the existing dialog.
The directory and preference owners retain their existing loading, recovery,
identity and navigation responsibilities.

## Alternatives

**Expand the list in the sidebar.** This keeps the list in the normal flow but
moves other navigation and leaves it subject to sidebar clipping.

**Portal the menu outside the sidebar.** This escapes clipping, but separates
its focus from the mobile drawer's existing modal boundary and requires that
boundary to recognize an external subtree.

## Consequences

The same selector is directly available from each layout without changing the
stored desktop preference. Top-layer positioning and focus coordination require
browser validation, including short viewports, scrolling and drawer interaction.
The [stable Team checks decision](../bug-fix/2026-11-05-stable-team-checks.md)
continues to govern retained directory pages and real revalidation failures.
