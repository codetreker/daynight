# Agent Note: Bottom Account Navigation

Status: implemented

## Problem

The account entry occupied the project navigation area even though personal
settings serve a different destination. Users needed a stable place to find that
entry while reading long pages and using short windows.

## Decision

The authenticated Workspace separated its sidebar into a scrollable main region
and a non-shrinking footer. The main region held the brand and project
navigation; the footer held the existing `/account` link, workspace caption and
sidebar toggle. Sticky viewport height and flex layout kept the footer reachable
without JavaScript measurement or a separately positioned account control. The
account link's `aria-current="page"` state provided its selected appearance, and
the topbar account link retained its accessible name and routing behavior.

The original bottom-placement delivery retained horizontal narrow-screen
navigation, hiding its footer and keeping account access in the topbar. That
choice kept placement independent of a responsive-navigation redesign. The
[sidebar preference decision](2026-10-25-sidebar-preference.md) replaced that
narrow-screen presentation with a rail and temporary overlay and retained the
footer destination in expanded and folded layouts.

The [account menu decision](2026-11-04-topbar-account-menu.md) replaces the
sidebar account entry and direct topbar link with a topbar avatar menu. The
sidebar retains its scrollable main region and non-shrinking footer. Identity,
request and account-management ownership remain in the
[authenticated workspace](2026-10-22-web-auth-workspace.md); the
[Web requirements](../../../../docs/spec/daynight-web.md#工作空间导航) and
[design](../../../../docs/design/daynight-web.md#工作空间导航) own current behavior
and structure.

## Alternatives

**A separately fixed account control.** Its position would need to track sidebar
width, responsive layout and viewport geometry independently of the navigation.
The existing flex footer provided the same placement through ordinary layout.

**A second sidebar account link or only the topbar link.** Duplicating the sidebar
entry created two positions to maintain; retaining only the topbar entry did
not provide the requested bottom-left destination. Moving the existing link
kept a single sidebar account entry and preserved the topbar shortcut.

## Consequences

The original placement remained stable as page content grew, while main
navigation scrolled independently in short windows and the footer did not shrink
away. It added no persistent state, account API or authentication lifecycle.
The later account menu decision changes the entry location; responsive navigation
and its local appearance state remain owned by the sidebar preference decision.
