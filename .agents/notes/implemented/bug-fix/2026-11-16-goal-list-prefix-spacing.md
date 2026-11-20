# Agent Note: Goal list prefix spacing

Status: implemented

## Problem

Goal list arrows started farther from the card edge than task-chain arrows,
and the icon's fixed background box, font glyph and surrounding gaps consumed
space needed by titles and metadata. The mismatch occurred at both desktop and
narrow widths while disclosure still needed a usable independent target.

## Decision

The Goal card supplies an inline-size container, aligning the arrow viewport
with the chain at 15px from the inner edge above 600px and 11px at or below it.
The original 740px viewport breakpoint governed row rearrangement; the later
[card layout decision](2026-11-20-goal-card-container-layout.md) moves that
choice to card content width while retaining the prefix and progress alignment.
The native disclosure button remains 22px wide and at least 34px high; negative
logical margins leave a 14px layout column for its 14px square arrow while
keeping its hit area inside the card and clear of the icon. A 20px decorative
SVG target replaces the font character and 34px background box. Both adjacent
gaps are 8px, and wrapped progress starts at the title column.

The [Goal specification](../../../../docs/spec/daynight-goals.md) owns the
visible requirements and the [Web design](../../../../docs/design/daynight-web.md)
describes the layout. The [row density decision](2026-11-13-goal-list-row-density.md)
retains the vertical sizing rationale, and the [title details decision](2026-11-14-goal-title-details.md)
retains disclosure and reading semantics.

## Alternatives

No other approach was recorded for this prefix repair.

## Consequences

The prefix occupies 50px before the title, leaving more room for content while
retaining a keyboard-focusable disclosure and the broad pointer target. Container
width controls alignment, so a narrow card in a wide viewport follows the same
alignment as a narrow chain.
Long content can still wrap and increase row height. Changes to prefix sizes
must keep the wrapped progress offset and disclosure hit area in sync.
