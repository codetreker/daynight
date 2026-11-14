# Agent Note: Goal card seams

Status: implemented

## Problem

Expanded Goal cards showed gaps at the heading and bottom edge: the heading's
own rounded corners exposed the underlying surface at the divider, and inherited
member-list padding left a neutral strip below the last child. The expanded
background could also extend beyond the outer rounded outline.

## Decision

The Goal card owns the rounded outline and clips its contents. Its heading has
no separate radius, and its expanded member list overrides the shared bottom
padding while retaining its container sizing context. Empty states keep their
own padding. The heading and contents retain their divider, and the native
completion-time popover remains in the top layer outside the clipping boundary.
The [Goal specification](../../../../docs/spec/daynight-goals.md) owns the
visible requirements; the [Web design](../../../../docs/design/daynight-web.md)
describes the style ownership.

The [Goal status background decision](../feature/2026-11-12-goal-status-backgrounds.md)
continues to assign the heading and border to the Goal's own state and child rows
to their individual states. The [flat member list decision](../simplification/2026-11-13-goal-flat-list.md)
retains the membership and ordering rationale.

## Alternatives

No other approach was recorded for this seam repair.

## Consequences

Collapsed and expanded cards share one continuous outline, with the final child
meeting the inner edge. The override is limited to Goal members, so ordinary
chain lists retain their spacing. Controls and focus indicators inside the card
must remain within its clipping boundary; completion-time hints use the existing
top-layer mechanism to remain visible near the edges.
