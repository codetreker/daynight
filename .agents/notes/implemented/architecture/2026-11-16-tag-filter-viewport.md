# Agent Note: Tag Filter Visible Viewport

Status: implemented

## Problem

A tag filter positioned only against the layout viewport can extend outside the
visible area when the browser zooms, pans or reduces its visible height. An
anchor scrolled outside that area can also make its apparent available space
larger than the space a user can actually reach. Closing, focus and positioning
must continue to respect independent filter conditions and other overlays.

## Decision

A task-tags local lifecycle composes the existing controlled filter with its
root, trigger, panel and search elements. It retains the
[dismissal decision](../bug-fix/2026-11-16-tag-filter-dismissal.md), handles
opening focus only on an interactive transition within the mounted instance,
so remounting an already-open controller preserves external focus. It observes geometry without
replacing the content or starting another data lifecycle. The
[Web design](../../../../docs/design/daynight-web.md) owns the current interface
and event boundaries.

Position and height follow the visible viewport rectangle, falling back to the
layout viewport where `visualViewport` is unavailable. The natural panel width
remains the current 285px, capped by the available width with side margins.
Available space above and below the anchor is intersected with the visible
rectangle before choosing placement. Extremely small visible areas reduce margins
and padding, and placement may overlap the anchor to retain a scrollport. The
list and, when needed, the panel itself
scroll so that controls remain reachable. The [toolbar decision](../feature/2026-11-14-unified-tag-filter-toolbar.md)
retains the independent filter ownership and its original placement rationale.

The local lifecycle does not own filter data or the panel's presentation. This
keeps the existing native matching control and skin while allowing the separate
selector presentation to change without duplicating event and geometry rules.

## Alternatives

**Use only the layout viewport.** This supports ordinary window resizing but
cannot represent the reduced or offset area visible during zoom and keyboard
changes; offscreen distances can be mistaken for usable space.

**Move the panel to a portal or register it as a modal overlay.** This changes
the DOM ownership used by outside actions and overlay events. The existing modal
registration also acquires an inert lease, which the non-modal filter does not
need.

## Consequences

Visible area changes update geometry without resetting search, selection, focus
or directory state. Listeners and observers require cleanup with the open panel.
The retained DOM must provide the lifecycle's refs and keep the panel within its
root. Controlled viewport checks establish geometric behavior, not physical phone
keyboard behavior; the latter needs separate device evidence.
