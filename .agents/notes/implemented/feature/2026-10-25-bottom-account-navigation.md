# Agent Note: Bottom Account Navigation

Status: implemented

## Problem

The account entry occupies the project navigation area even though personal
settings serve a different destination. Users need a stable place to find that
entry while reading long pages and using short windows.

## Decision

The authenticated Workspace separates its sidebar into a scrollable main region
and a non-shrinking footer. The main region holds the brand and project
navigation. The footer holds the existing `/account` link, workspace caption and
sidebar toggle. The sidebar's sticky viewport height and flex layout keep the
footer reachable without JavaScript measurement or a separately positioned
account control. The account link's `aria-current="page"` state provides its
selected appearance. The topbar account link keeps its accessible name and
routing behavior.

The original bottom-placement delivery retained the existing horizontal
narrow-screen navigation, hiding its footer and keeping account access in the
topbar. That choice kept placement independent of a responsive-navigation
redesign. The [sidebar preference decision](2026-10-25-sidebar-preference.md)
replaces that narrow-screen presentation with a rail and temporary overlay while
preserving this footer's account destination. Desktop folding also retains the
footer as an icon entry.

This presentation belongs to the existing
[authenticated workspace](2026-10-22-web-auth-workspace.md); identity, request and
account-management ownership remain there. The [Web requirements](../../../../docs/spec/daynight-web.md#工作空间导航)
and [design](../../../../docs/design/daynight-web.md#工作空间导航) own the current
behavior and structure.

## Alternatives

**A separately fixed account control.** Its position would need to track sidebar
width, responsive layout and viewport geometry independently of the navigation.
The existing flex footer provides the same placement through ordinary layout.

**A second sidebar account link or only the topbar link.** Duplicating the sidebar
entry creates two positions to maintain; retaining only the topbar entry does
not provide the requested bottom-left destination. Moving the existing link
keeps a single sidebar account entry and preserves the topbar shortcut.

## Consequences

Account placement stays stable as page content grows. The main navigation can
scroll independently in short windows, while the footer does not shrink away.
Bottom placement itself adds no persistent state, account API or authentication
lifecycle. Responsive navigation and its local appearance state are owned by the
sidebar preference decision, with the same account destination and accessible
name in expanded, folded and narrow-screen layouts.
