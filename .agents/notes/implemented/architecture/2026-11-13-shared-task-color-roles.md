# Agent Note: Shared Task Color Roles

Status: implemented

## Problem

Task rows, graph nodes, detail markers, Steps and activity annotations encoded
colors separately. Their values drifted even when they expressed the same state.
Execution, attention, connection health and permission also appeared beside the
same task with conflicting visual meanings. Recoloring a shared working class
could misrepresent waiting for input as active execution.

## Decision

`task-state-colors.css` is the shared CSS value owner loaded by the application
style entry. Existing row and graph variables, status chips, menu dots, progress,
metadata and task-scoped outlines consume its roles. The
[UI standard](../../../../docs/ui-design.md#semantic-color-roles) owns the required
palette and semantic hierarchy; the
[standard ownership decision](../process/2026-11-13-semantic-ui-color-standard.md)
records that documentation boundary.

Lifecycle colors remain independent of pause, blocking, overdue attention,
permission and connection health. Existing overdue surfaces retain their
precedence. Combined ended progress uses a neutral fill, while existing Goal
segments retain separate done and cancelled colors. Graph selection stays on
the node's outer outline, and keyboard focus uses the body's inner outline so
neither cue replaces the other. Compact chain headers place the graph action on
its own row, keeping progress and status readable when their independent minimum
widths cannot fit beside the action.

The composer exposes its actual activity as a presentation attribute only while
the snapshot is connected and synchronized. Working and waiting for input map to
different roles. Timer eligibility, interruption, state inference and protocol
fields keep their existing responsibilities. Online health remains a separate
green dot, and automatic execution permission remains a neutral labeled policy.

## Alternatives

**Keep literal colors in each consumer.** Small local edits are straightforward,
but every palette change requires discovering all independent copies. A shared
value owner keeps the existing consumers without duplicating exact values.

**Replace colors globally by their old hex values.** Shared brand colors and
transport health can use the same old value while representing different
meanings. Role adoption follows each consumer's meaning rather than a global
text replacement.

**Recolor the existing working class.** That class covered both working and
waiting for input. A narrow presentation attribute distinguishes them without
changing the execution and timer logic that intentionally groups them.

## Consequences

Application and browser fixtures load the same role definitions. Actual browser
checks verify computed colors, readable text and simultaneous interaction cues;
component checks preserve the presentation distinction through connection and
synchronization transitions. Missing style wiring remains visible rather than
being hidden by per-consumer fallback colors.

The change affects presentation only. Business statuses, aggregation scopes,
protocols, persistence and existing control actions remain independent of color.
The palette still requires labels and mixed-outcome counts; a unique hue alone
cannot establish recognition for every reader.
