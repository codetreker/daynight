# Agent Note: Webhook Detail Tabs

Status: implemented

## Problem

At a 320px English viewport, Webhook endpoint navigation placed Deliveries on
its own full-width second row although all three labels could fit together.
The extra row displaced configuration content. Larger fonts and subscription
counts also require access to complete labels within a bounded detail panel.

## Decision

Webhook detail navigation uses the reusable `HorizontalTabList` presentation
component. It owns a single horizontal scroll track, passive selected-item
reveal and non-intercepting edge shadows that identify additional content.
The page retains tab semantics, URL navigation, keyboard handling and permissions.
Container queries compact spacing at a track width of 360px or less while
preserving semantic typography and touch targets. Wider panels keep their
existing spacing.

Route and locale changes reveal the selected item by adjusting only the track's
`scrollLeft`. Resize observation covers the track and its labels, including font
changes. Passive correction does not focus an element or scroll ancestors;
manual scrolling updates edge indicators without restoring selection position.
The [project-tab decision](2026-11-19-project-active-tab-visibility.md) uses the
same local-scroll principle for its independently owned navigation.

## Alternatives

**Keep wrapping tabs.** Wrapping accommodates larger text but creates a wasted
row at ordinary phone widths, obscuring useful detail content.

**Force equal-width tabs or shrink their labels.** Equal fractions cannot honor
the different English label widths. Shrinking text conflicts with semantic
typography and browser font preferences.

**Reveal with scrollIntoView.** That operation may move ancestor scroll
containers. Direct track scrolling keeps the user's document position stable.

## Consequences

Ordinary narrow layouts retain all labels in one row. Oversized content remains
reachable through local scrolling, with the selected item revealed after layout
changes. Geometry, focus and touch behavior require real browser validation;
DOM-only tests cannot establish the rendered result. The layout does not issue
business writes or change the independent history and configuration permissions.
