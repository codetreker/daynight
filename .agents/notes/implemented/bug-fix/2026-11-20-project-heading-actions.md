# Agent Note: Narrow Project Heading Actions

Status: implemented

## Problem

The Project heading's secondary actions and creation controls occupy two
right-aligned rows on narrow screens, leaving unused space while pushing the
section navigation down.

## Decision

At a heading content width of 420px or less, the heading puts its actions below
the project identity, left aligned. Settings and refresh use 44px icon controls
with localized names and hover and keyboard-focus hints. The creation controls
keep their labels and stay grouped when possible. The settings reservation uses
the same compact geometry during Project access loading, and the refresh busy
indicator does not resize its control. Wider headings retain text actions.
The [header role decision](../simplification/2026-11-12-project-header-role.md)
owns the settings entrance and its admission boundary.

## Alternatives

**Keep text on all actions.** The controls consume two rows at common phone
widths despite unused space beside them.

**Use a viewport breakpoint.** The heading can be narrow inside a wider
workspace, so viewport width does not represent its available content width.

## Consequences

The normal 320px heading fits its four actions in one row. Larger text or longer
translations can wrap the creation group without truncating labels. Icon-only
actions require their localized names and discoverable hints to remain usable.
