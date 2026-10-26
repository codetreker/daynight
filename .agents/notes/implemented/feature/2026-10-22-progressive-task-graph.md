# Agent Note: Progressive Task Graph Overview

Status: implemented

## Problem

A complete chain context can approach an entire project's tasks and dependencies.
Rendering all of it at once makes the first view difficult to read and ties
local interaction cost to the complete graph. Task browsing needs complete data
and accurate progress while letting the reader control visible detail.

## Decision

The [external dependency decision](../architecture/2026-10-23-external-dependency-design.md)
uses an ordinary-edge component for the main set while retaining connected
ancestor context and these progressive controls. The original root-based input
explains this decision's initial circumstances; current membership is exclusive.

`projectChain` retains complete context P: an ordinary weak component forms main
M, every ancestor through all edge kinds is included, and P−M is context.
Unrelated successors of context tasks stay outside P. Only actual visible IDs S
are progressive. Full M owns chain progress and status; complete snapshots own
project and unfinished-tab counts. Proposed/todo/in_progress/done retain their
existing meanings. Ordinary components and ancestor closure are connected, so
direct-neighbor expansion can reach every task without a member-only control.

If P has at most fifty tasks and one hundred dependencies, initial S contains
all P. Otherwise `createGraphOverview(index, P)` starts at the representative and performs
stable undirected BFS, considering direct successors before prerequisites, each
direction in snapshot insertion order. Consider a candidate once, accept it only
if resulting S has at most fifty tasks and its complete induced edge set at most
one hundred dependencies, and queue only accepted tasks. These limits apply to
the initial overview of P, not the whole project or manual expansion.

`getTaskExpansion(index, P, S, taskId, direction)` chooses at most twenty hidden
direct neighbors within P in stable snapshot order, without recursion. Controls
report exact new tasks, new induced edges and remaining neighbors. Edge deltas
include links among added tasks. Manual expansion has no edge cap and may exceed
the initial fifty/one-hundred limits. Each task ID appears once.

`projectVisibleTasks(P, S)` retains membership and every real dependency with
both endpoints in S. No shortcut edges, aggregate cards or synthetic links are
introduced. The compact toolbar combines main/external membership, visible/
total tasks and dependencies, hidden-upstream status and fullscreen/reset controls.
It has no persistent explanatory paragraphs or reserved empty status block.
The original inline toolbar kept one line and truncated its left text to preserve
canvas height. The [graph-dialog decision](2026-10-26-task-chain-graph-dialog.md)
replaces that presentation with a viewport-sized reading area: summary and actions
can wrap, narrow layouts place them on separate lines, and complete action
controls remain accessible without horizontal scrolling. The dialog header owns
the locale selector in both modes, with compact narrow controls and a visually
hidden label whose accessible name remains available. Locale preference failures
appear below that selector without clipping the retry control. Native canvas controls
stay at bottom-left, separate from the top-right locale notice and bottom-right
attribution, so a persistent storage failure leaves zoom and fit accessible. The underlying counts
remain complete when only part of the graph is visible. The original
card decision reserved 220 by 136 pixels for every task: a 94px body, 40px
two-column footer and two border pixels. Uniform heights kept all controls in
consistent columns during progressive expansion, but also left an empty ruled
footer when both directions had no hidden neighbors. The
[conditional footer decision](../bug-fix/2026-10-22-task-card-expansion-footer.md)
partially supersedes that geometry: cards without controls are 220 by 96 and
omit the footer; cards with controls remain 220 by 136, retaining the empty
column when only one direction is available. At introduction the body was the native TaskDetailDialog trigger. The later
[inspection decision](2026-10-22-task-dependency-inspection.md) separates body
inspection, Details and direction controls into sibling buttons. The existing
Dagre polyline/native-arrow/local-dash renderer consumes only the visible graph.

Explicit expansion may relayout S, centers its anchor at current zoom and
focuses the anchor body. One “收起到概览” control recomputes the current overview,
frames it and retains reset-button focus. There is no branch ownership or
per-branch collapse.

Within the same representative/member scope, successful refresh intersects
actual old visible IDs with new P, adds the representative and keeps its
connected visible subset without adding a baseline or newly arrived tasks.
GraphVisibility owns projection, the ordered-member topology key, visible IDs,
inspection and viewport action. Membership changes with the same representative
reset that topology state and reinitialize InitialViewport, while TaskCanvas,
ReactFlow and the graph-dialog owner remain mounted. Fullscreen, active Details
and their inert/scroll locks therefore survive the topology reset. A valid
opening witness follows its current component; a representative change
initializes that graph while its dialog remains open, as owned by the
[graph-dialog decision](2026-10-26-task-chain-graph-dialog.md). Explicit reset
also computes a new baseline. Failure preserves old data only within the current
identity/project/auth scope. Refresh does not steal dialog focus; locale only
translates controls and counts without changing S or adding requests.

The delivered TaskDetailDialog, Overview/Attachments panels, adjacent attachment
panes, one right-side scroll owner, request state and modal focus ownership
remain intact. Refresh does not steal focus from an open dialog; a vanished
trigger uses existing close-time fallback. Language changes translate controls
and counts while preserving S, detail/attachment resources and viewport.

This partially supersedes always-visible complete context in the
[UX1 decision](2026-10-22-complete-prerequisite-context.md). UX1 delivered complete
ancestors and unambiguous context; those data guarantees remain. Its original
choice rendered the closure before inspection so later selection would not
change geometry. Explicit visibility makes structure changes deliberate while
bounding the initial graph.

This overview is delivered by [PR #134](https://github.com/codetreker/daynight/pull/134),
merged as `53e3a0c0ff4ec821f74a2401a3bfa7de24a3f4ea`, with source-bound production
and required CI/approval evidence. The first inspection attempt,
[PR #121](https://github.com/codetreker/daynight/pull/121), was abandoned without
integration. A replacement rebuilt from current main owns independent body/
Details actions, full/hidden ancestor semantics and smooth routes. The abandoned
PR's runtime results remain historical.

The four complete API capacity inputs retain 1,000 tasks each and their exact
999/5,000 edges, with five samples. The browser workload now requires bounded
initial S, all real induced visible edges and explicit expansion/reset, rather
than all input tasks/edges simultaneously in the DOM. `openMs ≤ 3000` and existing
detail/zoom/pan feedback ≤300ms remain. The original overview retained 31
scenarios; the [approval lifecycle](2026-10-22-task-approval-lifecycle.md) adds
three functional scenarios per target. The
[Markdown description decision](../architecture/2026-10-22-task-description-markdown.md)
adds one per target, producing 39 (22 native, 17 container).
Zero retries, timeouts, size refusals,
coverage and cleanup gates remain. Independent visible-route and paint checks
cover every edge; inspection additionally verifies selection timing and curves.
PR134 evidence remains bound to its delivered overview source; combined inspection
and Markdown evidence must come from its own source.

The [requirements](../../../../docs/spec/daynight-task-inspection.md) and
[design](../../../../docs/design/daynight-task-inspection.md) own behavior and
mechanisms.

## Alternatives

**Wrap the toolbar on narrow screens.** This keeps all labels visible at once,
but gives the header variable height and takes space from the graph. A single
row with truncated text preserved canvas height and kept actions in place for
the inline layout. The graph-dialog decision later accepts controlled wrapping
inside its larger viewport-relative area to keep labels and actions available.

**Offset the notice below top-right canvas controls.** This couples the notice
position to the controls' height and margin. The existing public bottom-left
control placement separates them without geometry constants or new state.

**Scroll the complete toolbar horizontally.** This preserves visual access to all
labels, but sends action buttons offscreen. Truncating only the left text keeps
the buttons immediately available at the right edge.

**Keep the complete projection always visible.** This made every ancestor
immediately available, but initial density and paint cost scaled with complete
context. Keeping complete P and explicit S retains data while bounding first
rendering.

**Fold only external tasks.** Long chains, dense merges and shared main tasks
would remain fully rendered. One visibility rule for both memberships addresses
all existing capacity shapes.

**Add aggregate cards and shortcut edges.** This requires shared-task ownership,
hidden-edge accounting and rules preventing artificial cycles. Real cards and
induced edges provide progressive access without a second graph semantics.

**Add per-branch collapse.** Shared ancestors and descendants make branch
ownership ambiguous. A global reset has a deterministic root-connected result
and no persistent ownership model.

**Cap manually added edges.** Highly connected hidden tasks could become
impossible to expand. A twenty-task batch bounds added cards while retaining all
resulting real dependencies.

**Refill the baseline on unchanged-topology refresh.** This can replace the
reader's chosen region without a membership reason. Actual-visible reconciliation
keeps browsing intent for the same scope. Explicit reset and genuine member-set
changes select a new bounded overview; the latter does not require a fullscreen
presentation remount.

**Combine workload policy and dependency inspection in one PR.** That couples a
material change in rendered workload with new selection, curve geometry and
acceptance mechanisms. Separate focused PRs establish progressive behavior and
its original-primitive budgets before adding inspection.

## Consequences

The header trades full visual text on narrow screens for a fixed single row with
immediately available actions. Truncation affects presentation; the DOM retains
complete localized statistics and the hidden-upstream live status.

Complete data and visible geometry have separate owners. Only explicit
expansion/reset, successful snapshot reconciliation and lifecycle changes alter
S. Opening details does not. Repeated manual expansion can reach complete P, but
arbitrary full-project rendering does not inherit the initial overview budget.

Per-branch folding and aggregates are deferred additive interactions. Branch
folding needs shared-task/collapse ownership; aggregates need independent group
and group-edge semantics. Keeping real IDs, complete P and induced S separate
preserves their extension points without implying those capabilities.

Acceptance independently derives initial membership, induced edges, batch deltas
and root-connected refresh retention. It covers 50/100 boundaries, stable order,
shared neighbors, todo/completed states, dense manual expansion, unrelated
external successors, failure retention and dialog focus. PR134 retained body-open
details and polylines as its delivered baseline. The later
[inspection decision](2026-10-22-task-dependency-inspection.md) now owns sibling
selection/Details, complete H/hidden counts and smooth routes; its current-source
runtime proof is separate from that original baseline.
