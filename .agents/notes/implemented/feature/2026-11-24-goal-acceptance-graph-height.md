# Agent Note: Goal Acceptance Graph Height Allocation

Status: implemented

## Problem

The acceptance graph places its canvas inside a grid beside the relationship
inspector. In an ordinary dialog the grid does not grow with the surrounding flex
layout, leaving the canvas at its minimum height and unused space below the
legend. Long inspection content can instead determine the grid's intrinsic row
height and expand the canvas beyond the dialog.

## Decision

The acceptance graph's reading grid owns the remaining height in both ordinary
and fullscreen dialogs. Its desktop row is bounded by `minmax(200px, 1fr)`;
the status region does not shrink and both status and inspector scroll within
their bounds. At the phone breakpoint, the canvas and inspector occupy separate
rows, the inspector remains capped at 260px, and the canvas retains its 200px
minimum. When the viewport cannot contain those regions, the dialog scrolls.
This extends the [acceptance graph decision](2026-11-23-project-goal-acceptance-graph.md)
without changing the shared Task graph layout.

## Alternatives

**Only make the reading grid grow.** The default intrinsic grid row still lets
long inspection content expand the canvas and dialog.

**Change the shared canvas or all graph dialogs.** Other graph consumers do not
have this grid wrapper, so a shared rule would widen the change without fixing
the inspector's intrinsic contribution directly.

## Consequences

The canvas uses available space while long relationship lists remain readable
inside their own scroll region. Short screens may require dialog scrolling; the
minimum canvas and controls remain reachable without reducing text size. Browser
geometry tests exercise the production component and styles at desktop and phone
sizes, including long content and changing relation states.
