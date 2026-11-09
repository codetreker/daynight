# Agent Note: Dependency Inspection on the Progressive Graph

Status: implemented

## Problem

Opening details on every graph-card action interrupts tracing a prerequisite
path. A visible task may depend on shared or external ancestors outside the
current overview. Inspection needs complete meaning without silently expanding
or moving the graph, while reading remains available as an independent action.

## Decision

The clean replacement gives cards sibling native body-inspection, Details and
direction controls. The body toggles selection with pressed semantics; Details
opens the existing centered dialog, and direction controls retain PR134 behavior.
Pointer, Enter and Space activate the focused control. Same body or blank canvas
clears selection; another task replaces it.

`tracePrerequisites` computes H from the complete graph. Visible members and all
their real visible routes/arrows highlight, while |H−S| reports hidden ancestors
once by task ID. Selected/prerequisite appearance differs; unrelated items dim
without losing readable status, blocked/shared or external-dash meaning. Proposed
and completed tasks keep their normal topology and full-data statistics.

TaskInspectionContext carries selectedTaskId and highlightedIds. TaskNode shells
read normal/selected/prerequisite/unrelated state while memoized content and
controlled React Flow geometry/data remain stable. Each node carries its actual
220-by-96 compact or 220-by-136 expandable dimensions; layout, lateral ports,
viewport fitting and focus reveal consume the same dimensions. Inspection and Details never
expand S, relayout, compile routes or move the viewport. Details and relation
navigation retain independent resource ownership.

The [Bézier route decision](../architecture/2026-10-25-bezier-task-dependency-routing.md)
owns fixed lateral ports, sixteen-unit intermediate clearance and gap-confined
cubic geometry, retaining the planner ownership established by the
[uniform route decision](../architecture/2026-10-22-uniform-task-dependency-routing.md).
`compileDependencyRoute` compiles only geometry changes; actual curved length
preserves 5/4 phase with cumulative error bounded to 0.025 CSS px at maximum 1.8
zoom. Declarative native SVG uses three constant direct-RGB markers and local
body-group stroke inheritance, retaining every visible route, body piece and
arrow. This is a fresh implementation, not adoption of the abandoned PR.

The [progressive decision](2026-10-22-progressive-task-graph.md) remains the
already delivered PR134 baseline: initial50/100, explicit20, full P/actual S,
accurate induced edges, expansion/reset and full progress/statistics. Same-scope
snapshots recompute a surviving visible selection, otherwise clear it; ordinary
failure retains the current scoped view. Session/identity/project or current401
transitions retain inherited invalidation and private-resource unmount rules.
The existing manual/periodic refresh policy is unchanged.

Keyboard visibility uses layout/card/viewport coordinates, avoiding native
focus's temporary overflow scroll. When a focused footer disappears but the task
survives, TaskNode restores the body at its actual DOM commit without viewport
reveal. Whole-card removal retains graph/fullscreen fallback; open dialogs keep
focus. Locale changes update presentation without changing S, selection,
geometry, details, attachments or business requests.

Source-bound runtime and delivery records belong to the task and its primary
plan. [PR #121](https://github.com/codetreker/daynight/pull/121)
is abandoned, not a required merge or current proof. The
[requirements](../../../../docs/spec/daynight-task-inspection.md) and
[design](../../../../docs/design/daynight-task-inspection.md) own fresh acceptance.
PR134's original workload evidence does not establish selection or curve budgets.

## Alternatives

**Keep body activation coupled to details.** This retains one action but covers
the graph whenever a reader tries to inspect a prerequisite. Sibling actions
separate graph selection and reading without nested controls.

**Expand hidden ancestors automatically on selection.** This changes the region,
layout and viewport under inspection. Full H, visible paint and a deduplicated
hidden count preserve meaning while leaving structure changes explicit.

**Put inspection roles in controlled geometry data.** It changes framework node
objects for presentation-only updates. Context supplies roles directly while
geometry owners remain stable and selection cost stays independently measured.

## Consequences

Complete data, actual visibility, inspection, route geometry and detail resources
have separate owners. Selection stability, all-visible route/paint coverage and
real local feedback must be proved on the new source, including negative cases,
auth-scope changes, keyboard/focus, both locales and existing detail/reader flows.
Historical inspection results remain historical; current runtime receipts and
protected platform integration determine completion.
