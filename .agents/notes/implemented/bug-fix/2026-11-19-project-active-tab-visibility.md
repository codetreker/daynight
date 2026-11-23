# Agent Note: Project Active Tab Visibility

Status: implemented

## Problem

An English project opened directly at Tags on a 320px viewport displayed its
content while clipping the selected tab. Keyboard navigation corrected horizontal
scrolling, but URL entry, history, locale changes and resizing did not.
The 481px horizontal layout also clipped English labels because scrollable
overflow was limited to widths at or below 480px.

## Decision

`ProjectSectionTabs` reveals the committed selection in a layout effect when
the section, project, locale or orientation changes. A ResizeObserver watches
the strip and each tab, including label and font size changes. Horizontal
correction writes only the strip's scrollLeft when the selected rectangle lies
outside it, requesting 4px of inner spacing and allowing native range clamping.
The observer disconnects when the effect ends.
Scrollable overflow applies throughout the existing horizontal breakpoint
(740px and below), including the wider layout with icons.

Passive correction never focuses an element or scrolls an ancestor. Keyboard
navigation retains its existing admitted-commit focus callback. Scroll events
are not observed, so users can browse other tabs without being pulled back.
The [project URL decision](../feature/2026-11-17-project-tab-urls.md) continues to
own selection and navigation admission.

## Alternatives

**Call scrollIntoView on selection.** This can move ancestor scroll containers
and disturb the user's content position. Direct scrollLeft adjustment confines
the side effect to the navigation strip.

**Correct only on window resize and keyboard input.** This misses direct entry,
history and label-size changes. Observing the strip and its tabs covers actual
layout changes without polling or listening to manual scrolling.

## Consequences

Selected tabs remain legible on narrow layouts without changing labels,
breakpoints, navigation semantics or draft ownership. Vertical layouts and
already-visible selections require no horizontal writes. Real browser tests own
geometry, focus and scrolling evidence; DOM-only tests cannot establish them.
