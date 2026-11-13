# Agent Note: Chain completion time layout

Status: implemented

## Problem

Chain summaries put completion time in a separate right-hand column between
progress and status, while Task and Goal rows present completion time as secondary
information below the title. The different placement makes the same fact harder
to scan and competes with the chain's actions on narrow screens.

## Decision

Full and scoped chain summaries place the independent completion-time button in
the metadata beneath the title, alongside assignee or child count and Worker
information. A non-interactive container holds the heading and metadata; the
native disclosure and time buttons remain separate controls. Progress, status,
and the graph entry retain their responsibilities. The [flat Goal list decision](../simplification/2026-11-13-goal-flat-list.md)
replaces scoped chain summaries in Goal disclosures with individual Task rows. The
[completion time design](../../../../docs/design/daynight-completion-time.md)
owns the interaction and aggregation details.

The [completion time presentation decision](2026-11-12-completion-time-presentation.md)
continues to explain why chain time has its own button and how its hint remains
accessible; this decision changes its position without changing that interaction.

## Alternatives

**Keep time in the right-hand action area.** This preserves the former layout
but leaves chain completion time apart from the equivalent Task and Goal
metadata and consumes space between progress and status.

**Place the time button inside the disclosure button.** This would visually put
time below the title, but nested buttons are invalid interactive markup and
cannot preserve independent keyboard and pointer operations.

## Consequences

Completion time follows the same visual hierarchy across full and scoped chains,
including when collapsed. The separate controls retain their accessibility and
hint behavior. The header must allow its metadata to wrap without obscuring
progress, status, or graph access; aggregation and time sampling are unchanged.
