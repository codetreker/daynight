# Agent Note: Chain Actions Text Size

Status: implemented

## Problem

Expanded project task chains display their usage and representative-task actions
larger than the adjacent completion time. The differing sizes weaken the visual
relationship between these secondary readings and actions.

## Decision

Project task chain action buttons use the shared `xs` size alongside the
existing `xs` completion time. The rule applies to complete and scoped chain
action bars, while other uses of the shared detail link retain their own size.
An invisible label at the former `sm` size reserves the original button space,
so changing the visible text does not reduce its target or alter wrapping.
The [Web typography standard](../../../../docs/spec/web-typography.md) owns the
scale and browser-relative sizing.

## Alternatives

**Change every detail link.** The shared class appears outside this action bar,
where a smaller size would alter unrelated interfaces.

**Only change the font size.** The button's text determines its dimensions, so
this would also reduce its clickable area and could change wrapping.

## Consequences

The action bar presents a consistent secondary size in both languages and scales
with the browser's root font. The reserved label space keeps the prior target and
wrapping, at the cost of retaining the label in a presentation attribute. The
project-specific selector must continue to override the broader link rule.
