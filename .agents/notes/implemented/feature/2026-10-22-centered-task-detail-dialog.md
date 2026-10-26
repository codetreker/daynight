# Agent Note: Centered task detail reading

Status: implemented

## Problem

Task details combine descriptions, pull requests, attachments, relationships and
metadata. The original 460px right-side layout constrains reading space,
particularly for planning documents and previews, while a full-width narrow-screen
layout leaves no visible separation from the page. Moving that content must
preserve keyboard containment, nested fullscreen behavior and focus restoration
when refresh removes the original entry.

## Decision

`TaskDetailDialog` remains the default task-detail entry for graph nodes and
standalone rows. It composes `TaskDetailSurface`, which retains the existing
detail request hook, relationship navigation, PR pagination, attachment state
and stale-snapshot notice. The
[standalone-detail decision](../architecture/2026-10-24-standalone-task-detail.md)
shares that complete surface with a normal page and adds the title-bar popout,
while this decision retains modal geometry and focus ownership. `task-detail.css` owns one
`task-detail-*` namespace for its shell and content.

In normal mode, the body portal centers the dialog in the available viewport, with a maximum
width of 960px and 24px gutters, reduced to 12px at 600px and below. Maximum height
is `min(880px, 100dvh - 2 × gutter)`. The original centered composition used one
content scroller to keep the heading and footer accessible while preserving all
task content. The [split-view decision](../architecture/2026-10-22-task-attachment-split-view.md)
partially supersedes that content ownership: Overview scrolls the task reading
columns, while the separate Attachments tab bounds adjacent file and preview
panes with one right-side vertical scroll owner. Heading, tabs, close and footer
remain outside panel scrolling; short fullscreen hides the informational footer
under the fullscreen-reading decision to retain readable content. The
[compact-header decision](../simplification/2026-10-24-compact-task-detail-header.md)
places the task title directly in that header, bounds its own keyboard scrolling
and keeps ID copying in Overview metadata. Overview pairs a reading column with a 265px
metadata/relationship column; the latter becomes 225px at 850px and below, and
both columns stack at 600px and below. Long text wraps and tables/code retain
local horizontal scrolling.

The [dashboard decision](../../archived/feature/2026-10-20-project-task-dashboard.md) and
[original dashboard design](../../archived/architecture/2026-10-20-task-dashboard-mvp-design.md)
record the snapshot and modal ownership choices retained here. This decision partially supersedes
their right-side reading layout. Synchronous layout cleanup releases keyboard
listeners, background inertness and counted scroll ownership; the separate
passive cleanup restores focus after sibling DOM removal, following the choice
recorded in the
[focus restoration decision](../../archived/bug-fix/2026-10-20-drawer-focus-restoration.md).
Relationship navigation changes the resource within one dialog lifetime.

The dialog remains above the [fullscreen graph](2026-10-22-task-graph-fullscreen.md).
The [fullscreen-reading decision](2026-10-25-task-detail-fullscreen.md) extends
the same mounted shell with viewport reading and a semantic frame keyboard owner.
Escape first leaves detail fullscreen, then closes details, then exits the graph,
after nested children consume their own layer; a vanished entry falls back to the
surviving fullscreen exit control or the current project view's visible controls,
with the project heading retained for an empty project. Both modal owners use
the same counted body scroll lock, including when the graph unmounts first.
The [attachment decision](../../archived/feature/2026-10-21-task-attachment-web.md) records the
same-origin rendering and request choices retained here. The Tab/Escape bridge now follows
the active root and loaded document under the fullscreen-reading decision, using
`dialogFocusables` without changing the frame or dialog lifecycle.

The [inspection requirements](../../../../docs/spec/daynight-task-inspection.md)
TI6–TI7 and [design](../../../../docs/design/daynight-task-inspection.md) own the
visible contract. The [web acceptance map](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns the production journeys for geometry, independent scrolling, graph and
standalone entries, refresh removal, fullscreen and frame keys. The
production-component mockups reuse the dialog and styles; the standalone
inspection prototype remains a target for graph inspection and a visual input
for Markdown reading. It does not establish the source-bound acceptance of
either delivery.

## Alternatives

**Keep the right-side layout and increase its width.** A wider side panel retains
the existing attachment and modal composition, but its position does not provide
the centered reading behavior required by TI6. Reusing that composition inside a
centered shell preserves the lifecycle without retaining the original geometry.

## Consequences

Task reading gains a wider desktop column while metadata remains nearby.
Overview retains visible gutters and stacks its columns on narrow screens without
page-wide horizontal overflow. Attachments retain left/right placement at those
widths. The normal-mode heading, tabs and footer reduce available content height;
the split-view decision owns its compact spacing and per-pane scroll rules.
Fullscreen-reading owns additional compact chrome and informational-footer hiding
for readable content at short fullscreen heights, preserving normal-mode geometry.

The dialog remains an independent live detail read and never patches the graph
snapshot. The [Markdown description decision](../architecture/2026-10-22-task-description-markdown.md)
extends Overview with CommonMark/GFM and root-based attachment navigation,
sharing the existing attachment controller and preserving this modal lifecycle.
Graph-card inspection, smooth paths and Markdown reading each require their own
source-bound acceptance.
