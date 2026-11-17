# Agent Note: Sidebar Navigation Icons

Status: implemented

## Problem

Sidebar navigation mixed font glyphs and SVGs. Font metrics varied with the
installed font, while the global SVG color rule treated otherwise equivalent
entries differently. Their visible size, baseline and visual weight were uneven.

## Decision

The sidebar owns nine decorative SVG shapes in `SidebarIcon`, with a shared
24×24 canvas and 1.6 stroke. A fixed 18px centered slot aligns them across
sidebar layouts. Scoped color inheritance makes each icon follow its entry text
in default, hover and selected states. Navigation continues to own labels, routes
and visibility.

## Alternatives

**Keep font symbols with adjusted font sizes.** Font-dependent glyph bounds and
baselines would still vary across systems and cannot consistently match SVGs.

**Use a shared icon dependency or feature-specific icons.** The sidebar needs a
small fixed set; a dependency or borrowing feature-owned components would add
ownership and styling coupling without resolving the local alignment contract.

## Consequences

The shapes require local maintenance and visual calibration. Their common slot,
canvas and inherited color provide consistent alignment and state treatment
without changing other uses of the global navigation styles.
