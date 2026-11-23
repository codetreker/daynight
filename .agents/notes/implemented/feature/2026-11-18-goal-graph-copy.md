# Agent Note: Goal graph link copying

Status: implemented

## Problem

A stable Goal graph address can be opened directly, but a reader in the graph
needs a way to share it without constructing the address by hand. Feedback must
not disturb the graph or leak a result from a previously displayed target.

## Decision

The shared normal and fullscreen Goal graph header copies the router's canonical
absolute address. The labelled shared copy control and Goal details occupy one
action row, which moves below the heading on narrow screens. Copy requests and
rendered results are scoped to the value generation and mounted instance;
pending remains focusable and synchronously rejects duplicate activation. Local
notifications report success or retryable failure without resizing the canvas.
The [Goal requirements](../../../../docs/spec/daynight-goals.md#goal-整体依赖图)
and [inspection design](../../../../docs/design/daynight-task-inspection.md#goal-整体图)
own the visible behavior and mechanism.

## Alternatives

**Use a member Task or a separate graph page as the link.** A member cannot
identify an empty or disconnected Goal and a separate page duplicates the graph
reader. The [address decision](2026-11-18-goal-graph-address.md) owns admission.

## Consequences

Readers can share the same graph from either entry while retaining their reading
state. Clipboard access remains subject to browser permission, with local failure
feedback and retry. A value returning to an earlier address is a new generation,
so neither a pending nor a completed earlier result is displayed.
