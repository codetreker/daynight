# Agent Note: Task Chain Graph Dialogs

Status: implemented

## Problem

Expanding a dependency graph inside a task-chain row changes the list height
and gives larger graphs a canvas constrained by the surrounding page. Persisted
inline expansion also opens a graph on entry without a new viewing action.
Graph reading needs a predictable area while preserving the list's position,
task inspection, fullscreen viewing and access to task details.

## Decision

A task-chain row opens one centered graph dialog through an explicit click or
keyboard action. Its default dimensions are `80vw` by `80dvh`; at viewport
widths of 740px or less, each dimension is the viewport minus 24px. The dialog
shows the chain title, status and progress above the existing graph. Its
background overlay leaves the compact list in place. A close button, backdrop
activation and Escape dismiss it and restore a surviving chain trigger or an
available list control without scrolling the page.

The project owns a transient original-member witness, initially null. It resolves
that task through `componentByTask` to a current visible multi-member chain.
Merges and splits do not replace a valid witness with the current representative.
If the task disappears, becomes standalone or belongs to a hidden chain, the
dialog closes and clears the witness. Leaving Task list or its Task chains
category also closes it; returning, reloading or revisiting the project does not
reopen a dialog. The former `daynight:project-view:${projectId}` expansion record
is no longer read or written. The independent section, category, completed-item
and page-scroll preferences retain their formats and ownership.

One dialog owner handles normal and fullscreen geometry, background inertness,
Tab containment and its counted body scroll lock. Fullscreen changes the same
mounted dialog and graph, preserving nodes, layout, inspection, visible tasks,
zoom and pan. It does not establish a second graph modal lifecycle. Closing the
dialog releases the canvas; opening it again initializes a new view. The graph's
existing bounded projection, expansion/reset and rendering remain unchanged.

Task details keep their body portal above the graph dialog. Escape handles one
applicable layer per press: detail child menu or confirmation, detail fullscreen,
detail dialog, graph fullscreen, then graph dialog. Detail closure restores its
original graph action, or the graph dialog's available close control if the
node disappeared. Graph and detail locks share the existing reference count;
background state and scrolling restore only after the last owner releases them.

This replaces the inline opening and persistence portions of the
[browsing-preference decision](2026-10-21-task-browsing-preferences.md),
[chain-presentation decision](2026-10-21-task-chain-presentation.md) and
[fullscreen decision](2026-10-22-task-graph-fullscreen.md). It preserves their
original ordering, filtering, single-canvas and layered-detail rationale. The
[Web requirements](../../../../docs/spec/daynight-web.md) own observable behavior;
the [Web design](../../../../docs/design/daynight-web.md) owns composition.

## Alternatives

**Keep inline expansion.** It retains immediate document context, but expanding
and closing rows changes list geometry and leaves graph size tied to the page.

**Open directly fullscreen.** It maximizes graph space but hides the project and
list context on every entry. A centered default leaves that context visible and
keeps fullscreen as an explicit action.

**Nest the old fullscreen modal inside a new graph modal.** Two owners would
compete for focus, inertness and Escape. One dialog lifecycle with a geometry
mode preserves the same graph without duplicating modal state.

**Restore the previous open graph from browser storage.** That would reopen a
modal without an explicit viewing action. Keeping opening state transient makes
entry and return predictable while retaining independent browsing preferences.

## Consequences

Graphs receive a stable viewing area without moving their task-chain list.
Viewport and inspection survive fullscreen and task-detail round trips. Closing,
category changes and project navigation intentionally end the graph-reading
session; its viewport is initialized on the next explicit opening.

The dialog must remain within the application root so the existing body-portaled
detail can isolate it. Refresh reconciliation and focus restoration must handle
removed triggers and changed representatives. Capacity, complete-prerequisite,
bilingual and browser acceptance requirements continue to apply to the same
graph implementation.
