# Agent Note: Preserve assistant rows within a content-driven height budget

Status: implemented

## Problem

Assistant tasks share a sidebar with the assistant inventory. Task content cannot
shrink, while a remaining-space assistant list can shrink to zero. Two task rows
can hide both assistants on a short phone viewport, and scrolling the outer panel
cannot recover rows inside a zero-height list.

## Decision

The original fix made the sidebar's direct children nonshrinking and assigned the
assistant list its natural content height up to `clamp(144px, 40dvh, 288px)`.
Content above that budget scrolled internally. No minimum content height was
reserved, including on short viewports, so empty and short lists did not create
unused space before tasks. Task loading, errors and record counts could no longer
collapse the assistant list.

The inner list permitted normal scroll chaining to the sidebar, whose own
overscroll containment prevented scrolling outside the workspace. Keyboard
navigation followed the existing DOM order and revealed focused controls in
either section without new focus management.

The [continuous sidebar decision](2026-11-24-assistant-sidebar-continuous-scroll.md)
supersedes the upper budget and nested scrolling while preserving natural row
height and reachability. The [management design](../../../../docs/design/bot-management-web.md)
owns the current mechanism and the
[management specification](../../../../docs/spec/bot-management-web.md) owns
observable behavior.

## Alternatives

**Keep a flexible remainder with a minimum height.** This prevents total collapse,
but reserves blank space for empty or short lists and still lets task growth
change the assistant browsing area. A natural height with only an upper budget
keeps the allocation tied to assistant content.

**Keep scroll containment on both nested regions.** This prevents wheel and touch
gestures from continuing to the task section at the inner list boundary. Normal
inner chaining preserves access through the same sidebar gesture.

## Consequences

The original allocation made short inventories occupy only their rows and gave
long inventories a bounded browsing region. More task content required scrolling
the sidebar and could move the assistant section out of view; rows retained their
height and remained reachable by scrolling back. The two nested scroll regions
were a deliberate interaction cost. The budget limited height rather than
guaranteeing a fixed number of rows when names or status text wrapped or browser
text preferences enlarged content. It also kept four assistants behind internal
scrolling even when an empty task section left enough unused sidebar space, which
motivated the replacement.
