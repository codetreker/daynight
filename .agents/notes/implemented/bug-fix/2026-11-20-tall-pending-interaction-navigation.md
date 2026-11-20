# Agent Note: Tall Pending Interaction Navigation

Status: implemented

## Problem

Following the latest activity can leave the bottom of a pending form visible
while its title and first required field are above a short timeline viewport.
The user has no direct way to return to the start of the request.

## Decision

For answerable cards taller than the actual timeline viewport less 24px, the
locator also requires the heading to be fully visible. It points toward a
clipped heading and uses the existing explicit card reveal and focus behavior.
Short cards retain the existing visibility rule. This replaces the tall-card
criterion in [pending interaction navigation](2026-11-06-pending-interaction-navigation.md).
The [Session requirements](../../../../docs/spec/task-sessions.md) own the
user-facing behavior.

## Alternatives

**Accept any substantial visible part of a tall card.** This avoids a persistent
locator for oversized forms, but leaves the request title and first field
unreachable directly when following its tail.

## Consequences

The locator can appear without moving the reading position or answering the
request. Navigation normally occupies a separate row so it does not cover form
controls. In a timeline shell at most 120px high, it overlays the right side
instead of consuming the remaining reading area. Its threshold follows the
container rather than device width. A heading
taller than the visible timeline itself cannot be fully shown; such an extreme
layout can retain the locator after navigation.
