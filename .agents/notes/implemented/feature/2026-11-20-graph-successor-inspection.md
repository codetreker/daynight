# Agent Note: Graph Successor Inspection

Status: implemented

## Problem

Selecting a task reveals its prerequisites but leaves affected downstream tasks
indistinguishable from unrelated work. Readers need to inspect both directions
within ordinary chains and Goal graphs while retaining their graph position and
visible task state.

## Decision

Both graph controllers derive complete prerequisite and successor sets from the
project index, including the selected task and ordinary and external relations.
Successor traversal uses the existing reverse index and a visited set. Shared
inspection classifies selected nodes first, then prerequisites, successors and
unrelated nodes. Edges require both endpoints in the prerequisite set or both in
the successor set, with prerequisite priority for malformed cycles.

Successor outlines, edge bodies and arrow markers share the semantic color
`#087F8C`. Prerequisite colors, lifecycle fills, external dashes, full card opacity
and independent keyboard focus remain visible. Shared text legends and localized
node and edge descriptions identify the two relations without relying on color.
Only the existing projection is painted; inspection never expands it or changes
layout, viewport or requests. Hidden upstream counts retain their original scope;
no hidden successor counter is introduced.

This extends the relation scope of the
[Goal graph inspection decision](2026-11-15-goal-graph-inspection.md), preserving
its selection lifecycle, projection and Details ownership. The original shared
body action made prerequisite inspection consistent across graph types; the same
mechanism now carries both directions. The
[inspection design](../../../../docs/design/daynight-task-inspection.md#完整依赖与可见交互)
owns the algorithms and presentation contract.

## Alternatives

**Color every edge whose endpoints belong to either relation.** The union would
highlight an ancestor-to-descendant bypass that does not pass through the selected
task, misrepresenting the inspected dependency route. Separate endpoint tests
preserve the distinction.

**Keep upstream-only inspection.** This leaves the affected downstream work
unidentified and does not satisfy the inspection goal.

## Consequences

Readers can follow prerequisites and affected work without moving the canvas.
Each selection and changed index requires an additional linear successor walk;
presentation still reuses existing geometry. The projection deliberately bounds
what is visible, so successor highlighting does not imply that every downstream
task appears in the current graph. Deterministic prerequisite priority keeps
malformed cyclic input renderable without claiming that cycles are valid.
