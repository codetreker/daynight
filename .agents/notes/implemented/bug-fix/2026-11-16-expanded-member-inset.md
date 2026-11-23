# Agent Note: Expanded member inset

Status: implemented

## Problem

The original inset decision addressed expanded Goal and chain members sharing
the parent's leading edge, which was considered insufficient to express their
hierarchy even though the member rows had their own backgrounds and borders.

## Decision

The original implementation gave the shared `goal-task-list` a logical leading
inset of 16px above a 600px viewport and 12px at or below it. It moved the whole
member row while keeping its trailing edge aligned. The [member edge alignment
decision](2026-11-16-expanded-member-edge-alignment.md) supersedes that inset:
the shared list now has no leading padding at any viewport width. The later
[member inner indent decision](2026-11-16-expanded-member-inner-indent.md)
restores the same content offset within each member row. Goal still overrides
only the list's bottom padding; chains retain their 5px bottom space.
The [flat Goal list](../simplification/2026-11-13-goal-flat-list.md) and
[Goal card seams](2026-11-14-goal-card-seams.md) decisions retain their membership
and outline rationale.

## Alternatives

**Indent row contents.** This was rejected for the original hierarchy treatment
because changing the shared TaskRow padding would leave the background and border
aligned with the parent and affect standalone and personal rows.

**Indent each consumer separately.** Goal, full chains and scoped chains shared
the same list structure; separate rules could diverge at the viewport boundary.

## Consequences

The inset expressed hierarchy without adding an action, at the cost of a neutral
leading strip and less available row width. The alignment decision removed that
strip and initially relied on the parent heading, disclosure control and content
divider for hierarchy. The inner indent restores the offset without moving the
row background and border. Empty states retain their own padding.
