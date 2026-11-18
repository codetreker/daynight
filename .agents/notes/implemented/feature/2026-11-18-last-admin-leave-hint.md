# Agent Note: Last Admin Leave Hint

Status: implemented

## Problem

A persistent last-administrator caption adds height to the roster and places
the explanation beside the role field even when the blocked intention is to
leave the Team. A native disabled button cannot receive keyboard focus, so an
explanation attached only to its pointer interaction is inaccessible.

## Decision

Only an ordinary Team's sole administrator's own Leave Team control uses a
focusable button with `aria-disabled` and `aria-describedby`. It has no departure
handler. The existing localized reason is available to assistive technology
while visually hidden and appears on hover or focus in a body portal. Fixed
positioning, viewport clamping and vertical flipping preserve roster geometry
and avoid panel clipping. Hover and focus independently retain visibility;
Escape dismisses the hint, and inactive settings sections hide it.

This replaces the persistent explanation row described in the
[role alignment decision](../bug-fix/2026-11-05-team-member-role-alignment.md).
The shared roster columns remain unchanged. Other disabled states retain their
native behavior, and server `last_admin` refusals retain the confirmation error.

## Alternatives

**Reuse TaskControlTip directly.** Its focusable wrapper and task-specific
interaction ownership would move focus away from the actual Leave Team button;
its positioning lifecycle also does not own this viewport-contained portal.

**Position the hint inside the row.** The panel clips overflow, and an in-flow
reason changes row sizing. A body portal gives the bubble independent geometry.

## Consequences

The roster loses its persistent caption without losing the accessible reason.
The small Team-specific component owns event cleanup and inactive-section
visibility. Browser tests own actual focus, clipping and layout observations;
component tests verify scope, dismissal and absence of departure actions.
