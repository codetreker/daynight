# Agent Note: Preserve assistant rows within a content-driven height budget

Status: implemented

## Problem

Assistant tasks share a sidebar with the assistant inventory. Task content cannot
shrink, while a remaining-space assistant list can shrink to zero. Two task rows
can hide both assistants on a short phone viewport, and scrolling the outer panel
cannot recover rows inside a zero-height list.

## Decision

The sidebar owns scrolling across its sections. Its direct children do not shrink.
The assistant list uses its natural content height up to
`clamp(144px, 40dvh, 288px)` and scrolls internally above that budget. There is no
minimum content height, including on short viewports, so empty and short lists do
not create unused space before tasks. Task loading, errors and record counts do
not change the assistant list's allocation.

The inner list permits normal scroll chaining to the sidebar. The sidebar retains
its own overscroll containment. Keyboard navigation follows the existing DOM order
and can reveal focused controls in either section without new focus management.
The [management design](../../../../docs/design/bot-management-web.md) owns the
mechanism and the [management specification](../../../../docs/spec/bot-management-web.md)
owns observable behavior.

## Alternatives

**Keep a flexible remainder with a minimum height.** This prevents total collapse,
but reserves blank space for empty or short lists and still lets task growth
change the assistant browsing area. A natural height with only an upper budget
keeps the allocation tied to assistant content.

**Keep scroll containment on both nested regions.** This prevents wheel and touch
gestures from continuing to the task section at the inner list boundary. Normal
inner chaining preserves access through the same sidebar gesture.

## Consequences

Short inventories occupy only their rows, while long inventories retain a bounded
browsing region. More task content requires scrolling the sidebar and can move the
assistant section out of view; the rows retain their height and remain reachable
by scrolling back. The two nested scroll regions remain a deliberate interaction
cost. The budget limits height rather than guaranteeing a fixed number of rows
when names or status text wrap or browser text preferences enlarge content.
