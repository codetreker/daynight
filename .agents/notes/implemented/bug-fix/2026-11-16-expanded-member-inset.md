# Agent Note: Expanded member inset

Status: implemented

## Problem

Expanded Goal and chain members shared the parent's leading edge, obscuring
their hierarchy even though the member rows have their own backgrounds and borders.

## Decision

The shared `goal-task-list` owns a logical leading inset of 16px above a
600px viewport and 12px at or below it. It moves the whole member row while
keeping its trailing edge aligned. Goal overrides only the list's bottom padding;
chains retain their 5px bottom space. The [flat Goal list](../simplification/2026-11-13-goal-flat-list.md)
and [Goal card seams](2026-11-14-goal-card-seams.md) decisions retain their
membership and outline rationale.

## Alternatives

**Indent row contents.** Changing the shared TaskRow padding would leave the
background and border aligned with the parent and affect standalone and personal rows.

**Indent each consumer separately.** Goal, full chains and scoped chains share
the same list structure; separate rules could diverge at the viewport boundary.

## Consequences

The neutral leading space makes hierarchy visible without adding an action.
Rows have less available width, so their wrapping and focus must remain usable
at narrow widths. Empty states retain their own padding.
