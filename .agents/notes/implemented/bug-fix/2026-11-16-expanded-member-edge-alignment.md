# Agent Note: Expanded member edge alignment

Status: implemented

## Problem

Expanded Goal and chain members showed a neutral strip between the content
container's leading edge and the member rows' backgrounds and borders. That
space reduced the width available to read members and prevented their rows from
meeting both inner edges of the expanded content area.

## Decision

The shared `goal-task-list` has `padding-inline-start: 0` at every viewport width,
with no responsive leading-padding override. Goal, full-chain and scoped-chain
members share this rule. TaskRow retains its own content padding, backgrounds,
borders and controls; standalone and personal rows keep their existing layout.
The parent heading, disclosure control and content divider express hierarchy.

This replaces the [expanded member inset decision](2026-11-16-expanded-member-inset.md),
whose 16px/12px leading space was chosen to distinguish parent and member rows.
The list still owns 5px of bottom padding for full and scoped chains; Goal
overrides only that bottom padding to zero. The [Goal card seams
decision](2026-11-14-goal-card-seams.md) and [flat Goal list
decision](../simplification/2026-11-13-goal-flat-list.md) retain their outline and
membership responsibilities. The [Web requirements](../../../../docs/spec/daynight-web.md#项目普通-task-行)
and [Web design](../../../../docs/design/daynight-web.md) own the visible rule
and its style ownership.

## Alternatives

**Retain the leading inset.** Its hierarchy cue requires the neutral strip that
the edge-alignment requirement removes, and reduces member width at narrow
viewports. The existing heading, disclosure and divider remain available to
identify the containing Goal or chain.

## Consequences

Member backgrounds and borders meet both inner edges of expanded content, with
more width available for long titles and metadata. Hierarchy no longer has the
additional cue of a leading inset. The shared rule keeps all three consumers
consistent across viewport widths while preserving row content spacing, chain
bottom space and Goal clipping, rounded outline and continuous seams.
