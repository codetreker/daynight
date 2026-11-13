# Agent Note: Semantic UI Color Standard

Status: implemented

## Problem

Independent color choices make different meanings look alike. A pale teal
proposal can resemble a completed task, while a warm yellow proposal competes
with warnings. Green activity markers and aggregate progress can suggest
successful completion even when work is running or some tasks were cancelled.
Focus, selection, permission and connection health add further meanings beside
the same task.

## Decision

The [UI design standard](../../../../docs/ui-design.md#semantic-color-roles)
owns the exact semantic palette and its application rules. Product specifications
and designs reference that owner while retaining their own status, aggregation,
interaction and lifecycle contracts. The standard defines required rendering;
source-bound checks establish whether each consumer conforms.

Tinted lifecycle rows use lavender for proposed, near-white for todo, blue for
in_progress, green for done and neutral gray for cancelled. Mixed ended summaries
remain neutral; real ended statistics retain done/cancelled counts. Attention uses orange and errors
use red. Actual activity, runtime health, execution policy and keyboard focus
retain separate meanings and independent visual cues. Dark task/status focus
indicators and selection outlines do not redefine unrelated brand treatments.
Completion tracks use the done green because the [completion-progress decision](../bug-fix/2026-11-13-completion-progress-excludes-cancelled.md)
excludes cancelled tasks from the display ratio. The real ended count still
includes done and cancelled and remains distinct from completion progress.

The [original row palette](../../archived/feature/2026-10-28-task-status-backgrounds.md)
and [graph reuse](../../archived/feature/2026-11-04-graph-status-backgrounds.md)
record the earlier palette's circumstances and adoption of shared surfaces.
The [Goal background decision](../feature/2026-11-12-goal-status-backgrounds.md)
continues to require the Goal's own state independently of child progress.

## Alternatives

**Use pale teal for proposed.** It is too close to completed green in adjacent
rows, so background scanning does not reliably distinguish a proposal from a
successful outcome.

**Use warm yellow for proposed.** It separates proposals from completed tasks
but competes with the existing overdue, blocked and paused attention family.

**Keep every lifecycle row neutral with colored chips and a narrow rail.** This
provides a viable compact vocabulary but changes the established whole-row scan
pattern and introduces another visual structure. The adopted standard retains
tinted rows with explicit labels and a consistent semantic hierarchy.

**Give every summary and auxiliary condition a unique hue.** The number of
meanings exceeds a small reliable palette, and a distinct hue does not establish
recognition under different color vision. Neutral closure states use accurate
labels and counts; auxiliary conditions retain their own text or shapes.

## Consequences

Exact values have one documentation owner, reducing drift between list, graph,
detail, Step and activity rules. Consumers still require actual adoption and
verification; recording the standard does not establish implementation or
product acceptance.

The palette requires coordinated readable text, hover and interaction colors.
Replacing only the background can reduce contrast. Color remains an additional
cue, with labels, mixed-outcome counts and warning indicators carrying the same
meaning. Archived decisions remain unchanged and retain their historical
rationale.
