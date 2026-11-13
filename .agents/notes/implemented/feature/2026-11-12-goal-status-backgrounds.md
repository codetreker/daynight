# Agent Note: Goal Status Backgrounds

Status: implemented

## Problem

Project Goal headings have a neutral background even when their own lifecycle
states differ. A small status label alone makes those states harder to scan.
Child progress is independent of the Goal state and can disagree with it.

## Decision

Goal list headings and their outer borders use the shared task status palette
for the Goal's own four states. The heading retains separate disclosure and
detail buttons, and the expanded content stays neutral with independently
colored child rows. Auxiliary text uses the shared readable color. The
[UI design standard](../../../../docs/ui-design.md#semantic-color-roles) owns
the required palette, contrast and semantic hierarchy; the
[semantic color decision](../process/2026-11-13-semantic-ui-color-standard.md)
records that ownership. The earlier
[task status background decision](../../archived/feature/2026-10-28-task-status-backgrounds.md)
records the original palette and aggregate chain semantics; the
[Goal browsing decision](2026-11-11-goal-browsing.md) owns the list's scope. The [Goal row disclosure decision](../bug-fix/2026-11-13-goal-row-disclosure.md) describes the current heading actions.

## Alternatives

**Derive the color from child progress or chain state.** A completed set of
children can belong to a Goal that is still in progress, and an ended Goal can
retain unfinished children. This would misrepresent the Goal's own state.

**Color the entire expanded card.** Nested task rows have their own statuses;
coloring their container would blur that distinction and extend hover effects
to unrelated child interactions.

## Consequences

The palette gives the Goal a visible lifecycle cue without changing its progress,
data model or navigation. The heading and border must remain synchronized when
the Goal status changes, and nested task styles remain independently scoped.
