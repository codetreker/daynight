# Agent Note: Fullscreen task graph viewing

Status: implemented

## Problem

The inline dependency canvas has a bounded height and shares horizontal space
with the workspace navigation. Large graphs need more viewing space while
retaining readable zoom, current position and access to task details. Keyboard
users must be able to operate and leave that expanded view.

## Decision

The existing graph toolbar switches its mounted canvas between the inline
layout and a fixed container filling the browser viewport. The container uses
modal dialog semantics, background inertness, visible-control Tab cycling and
an explicit exit button. Escape exits the graph when focus is inside it; exit
restores focus to the same toolbar button. Layout geometry, node identity and
React Flow viewport survive the switch. The mode belongs to the mounted graph
and is not persisted.

The centered task detail dialog retains its body portal and appears above the fullscreen
graph. Its keyboard events do not reach the graph container. The
[fullscreen-reading decision](2026-10-25-task-detail-fullscreen.md) extends the
detail view with its own viewport mode: after nested children handle their layer,
Escape leaves detail fullscreen, closes the detail dialog, then exits the graph.
No mode switch acquires a second detail scroll lock. When a refresh removes the original node but keeps
the fullscreen graph, detail focus returns to its exit control before the
ordinary root/page fallback. Both views acquire the same counted body scroll
lock: the final release restores the original overflow value even when a graph
refresh removes the graph while details remain open. Background inertness is
restored to its observed state when the graph exits or unmounts.

The [centered detail decision](2026-10-22-centered-task-detail-dialog.md) owns
the dialog geometry and reading columns while retaining this layering,
keyboard-event boundary and shared scroll lock. The
[requirements](../../../../docs/spec/daynight-web.md) own the interaction,
and the [design](../../../../docs/design/daynight-web.md) owns its structure.
The existing frontend-only browsing mockup renders the production components
and CSS. Production browser assertions extend existing journeys without
changing their inventory.

## Alternatives

**Browser Fullscreen API on the graph.** A fullscreen graph element would
exclude the detail drawer's body portal from the fullscreen subtree. Keeping
existing details available would require changing their portal ownership and
browser fullscreen lifecycle. Filling the browser viewport satisfies the
viewing goal with the existing drawer composition.

**A separate graph in a modal.** Mounting another React Flow instance would
repeat layout and require synchronizing viewport and selection state. Retaining
the existing canvas preserves those identities directly.

**Independent body overflow restoration.** Each view remembering the value on
entry fails when they release in a different order: one can restore scrolling
while the other remains open, and the last release can leave overflow hidden.
A shared ownership count makes release order irrelevant.

## Consequences

The graph gains the browser's available width and height while preserving its
current inspection position. The browser's own chrome remains available.
Narrow screens use the same controls and flexible canvas height. Graph and
detail-dialog modal lifecycles must continue to coordinate scroll ownership; graph
keyboard handling stays local so detail shortcuts retain precedence. Future
changes that remount the canvas on mode switches would violate viewport and
node identity preservation.
