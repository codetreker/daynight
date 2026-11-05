# Agent Note: Graph Language Entry

Status: implemented

## Problem

The graph dialog duplicates the application's language control and its preference
feedback in a title bar that must also accommodate the chain title and close
control. Fullscreen changes the viewing area but does not create a separate
language preference or graph-reading session.

## Decision

The ordinary and fullscreen graph dialog have no local language selector or
preference feedback. The workspace header retains the application language
entry, and the standalone task page retains its own entry. The graph continues
to subscribe to the shared locale, so a change to that locale translates the
mounted graph without rebuilding its business state or viewport. The same dialog
and graph remain mounted across fullscreen changes, retaining the existing
focus containment, layered Escape and restoration behavior.

This partially supersedes the selector placement in the
[bilingual interface decision](../feature/2026-10-22-web-bilingual-interface.md)
and the notice geometry in the
[progressive graph decision](../feature/2026-10-22-progressive-task-graph.md).
The [inspection requirements](../../../../docs/spec/daynight-task-inspection.md)
and [design](../../../../docs/design/daynight-task-inspection.md) own graph
behavior and composition.

## Alternatives

**Keep a selector in the graph dialog.** The original placement allowed changing
language while modal isolation made the underlying page inert. It also duplicated
a global control and its preference feedback in both viewing modes; fullscreen
is not a separate language context.

## Consequences

Graph reading has more header space and no local preference notice competing
with graph controls. The workspace entry is unavailable while the modal isolates
the page. Locale changes from the shared provider still update an open graph,
without changing its
selection, geometry or reading state. The independent page and other modal
language entries retain their own existing behavior.
