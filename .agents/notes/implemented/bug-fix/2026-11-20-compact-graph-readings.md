# Agent Note: Compact Graph Readings

Status: implemented

## Problem

Dependency graph cards occupy substantial canvas space, while long titles,
execution warnings and complete usage readings compete for a fixed card area.
Readers need exact values without losing dependency inspection on touch devices.

## Decision

Both graphs share a 300×124 body and a 60px footer only for actual actions.
Three title lines include the external marker; Goal ownership is not projected
onto cards. Graph-specific compact token and duration formats retain exact values
and execution details in one canvas-owned hint. Hover, body focus and touch
activation expose that hint; touch also preserves dependency inspection. The
[inspection design](../../../../docs/design/daynight-task-inspection.md) owns
geometry and interaction details. This replaces the earlier
[compact card decision](2026-11-20-compact-graph-cards.md) while preserving its
shared dimensions, typography roles and proportional scaling rationale.

## Alternatives

**Keep ownership and full readings on every card.** Their space competes with
three-line titles, warning state and independent Details in the smaller body.

**Add a separate reading button.** A small target and extra tab stop would make
navigation through dense graphs more costly. The existing body supports touch
without changing the original inspection action.

**Shrink only the rendered box or graph zoom.** Layout and edge endpoints would
disagree with the card, or text would become less readable.

## Consequences

More graph content fits at the same text size. Exact readings remain available
without new requests or per-node clocks, but the shared hint must track data,
focus and viewport movement. Both graph layouts, languages, large text and touch
need real-browser geometry and interaction verification.
