# Agent Note: Management Card Description Width

Status: implemented

## Problem

Invitation, personal token and application authorization card headings grouped
their title and description beside an action. On narrow screens the action
reserved a column for the entire text block, leaving unused space beside long,
fragmented descriptions.

## Decision

The three consumers opt into `panel-heading-description`. At widths up to 600px,
its grid places the title and action in the first row and spans the description
across the second. A flexible title column and an action column capped at 45%
allow long labels to wrap. A heading without an action spans both columns.
Existing desktop alignment, semantic headings, button behavior and focus
ownership remain with their consumers. The [authentication design](../../../../docs/design/daynight-auth.md#现状与可复用机制)
owns the current presentation mechanism.

## Alternatives

**Change every panel heading.** Composite headings, including member search,
have different content and layout responsibilities. A global change would apply
the two-row contract to unrelated consumers. The [App heading decision](2026-11-17-github-app-list-heading-hierarchy.md)
also preserves consumer-specific presentation.

**Extract a new React heading component.** The existing markup already shares
the necessary structure. A component would need to forward heading IDs, refs
and focus attributes without owning their behavior; the selective CSS mode
shares the layout without moving those responsibilities.

## Consequences

Descriptions use the card's available content width on phones while preserving
interface typography. The mode relies on a text wrapper containing the heading
and description, followed by an optional direct action button. Browser
regressions exercise the real Team and account pages with controlled responses;
they establish rendering and interaction, not server authorization behavior or
physical mobile keyboard behavior.
