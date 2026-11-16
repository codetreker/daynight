# Agent Note: Task chain dependency icon

Status: implemented

## Problem

Task chain graph actions used a text button while the Goal graph action used a
compact icon. The inconsistent controls consumed space in chain headers and
made the same kind of graph action harder to recognize across the list.

## Decision

Complete and scoped task chains use the Goal graph action's 32×32 icon treatment.
The icon is decorative; the native button retains a localized accessible name
with the chain title and an action tooltip. The graph trigger and the list
disclosure remain independent. Scoped chains still open with an in-scope member
as their witness. The [graph dialog decision](../../archived/feature/2026-10-26-task-chain-graph-dialog.md)
records the existing dialog and focus behavior.

## Alternatives

**Keep the visible text button.** Its explicit label is readable without a
hover, but it differs from the Goal action and takes more room in the compact
chain header. The icon retains a localized accessible name and tooltip.

## Consequences

Both chain variants share the Goal action's visual affordance without changing
graph selection or disclosure state. Users need the accessible name or tooltip
to identify the icon's action when its meaning is unfamiliar.
