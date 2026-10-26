# Agent Note: Complete Prerequisite Context

Status: implemented

## Problem

An expanded root chain can show a shared task and its direct external blocker
while hiding earlier prerequisites of that blocker. A reader cannot trace the
complete upstream path from the canvas. Adding ancestors also changes the left
edge of the layout and can place the chain's root to the right of the earliest
prerequisites, so a root-anchored viewport can conceal the new context.

## Decision

The [status assignment decision](../architecture/2026-10-24-task-status-assignment.md) owns the current three-state
protocol. Status journeys use exact registered PUT status writes; current
inventory is 33 native and 28 container results. The rollout counts below retain
their original delivery context; repeatable current commands and mappings belong
to the Web README.

The [external dependency decision](../architecture/2026-10-23-external-dependency-design.md)
retains complete ancestor context and implements ordinary-component membership
with explicit edge classification. It preserves the original reason for full
upstream reading while changing which tasks own chain progress and which edges
are dashed.

For a selected representative, `projectChain` keeps every ordinary-component
member in `mainIds`, then iteratively traverses all `dependsOn` edges to include
every ancestor. Additional tasks are stored in `externalIds`; their union is
complete context P. Every dependency ending in P is retained, and ancestor
closure guarantees its source belongs to P. UX1 initially displayed all P; the
[progressive overview decision](2026-10-22-progressive-task-graph.md) adds explicit
S for members and context. Stable ordering follows the complete snapshot.

Context does not import unrelated successors. For ordinary `A → D`, `B → C`
and `C → X`, with external `C ⇢ D`, expanding A's component displays members A/D
and context B/C. X remains outside P. B→C is an ordinary solid edge, C⇢D an
explicit dashed edge. An external shortcut stays dashed even when another
ordinary path connects both endpoints inside one component. Tasks occur once
per canvas; component progress counts members only and project totals count
each project task once. All edge kinds still contribute blocking and execution.

Context nodes retain dashed borders and the “外部前置” label. Edge dashes encode
only the persisted external marker, independently of node role; ordinary edges
between context tasks remain solid. Full/visible counts distinguish data from
display. The initial viewport fits the visible layout at 0.8–1 zoom when possible;
otherwise it anchors the leftmost rank at 0.8. A representative already in that
rank retains vertical centering; when context extends further left, the topmost
upstream task begins at a 32px inset. Pan, zoom, Fit and keyboard reveal keep
other cards accessible. Selection never reruns initialization.

This partially supersedes the direct-boundary projection in the
[projection and layout decision](../../archived/feature/2026-10-20-task-graph-projection.md). That earlier
decision kept direct blockers visible without recursively expanding ancestry;
its complete-snapshot validation, main-set counting and pinned Dagre layout
choices remain in force. The
[inspection design](../architecture/2026-10-22-task-inspection-design.md) owns the
task-card selection and smooth-route mechanisms. The
[centered detail decision](2026-10-22-centered-task-detail-dialog.md) implements
the reading shell. The [inspection decision](2026-10-22-task-dependency-inspection.md)
owns sibling selection/Details actions and smooth routes on the progressive graph.
The [Markdown description decision](../architecture/2026-10-22-task-description-markdown.md)
owns shared CommonMark/GFM and root-based attachment navigation.

The production capacity matrix preserves its chain, merge and shared-root graphs
and adds `capacity-external`: 1,000 nodes and 5,000 edges, with two main tasks and
998 external ancestors. It uses the same five expansions, 3,000ms opening budget,
300ms local-feedback budgets and independent size refusals. The progressive
overview keeps those complete inputs while changing DOM readiness to the bounded
visible graph, all real induced edges and explicit expansion/reset checks;
PR134 retained body-open-details and the existing polyline renderer as its
delivered baseline. Later inspection evidence must separately prove selection
and curved routes. The new initial upstream task replaces only that dataset's readable
root condition; existing datasets retain their root-visibility checks. Strict
inventory validation retains five native capacity/limit scenarios. The later
[bilingual interface decision](2026-10-22-web-bilingual-interface.md) expanded
functional checks to thirteen per target, producing eighteen native and thirteen
container scenarios at that stage. The
[authentication activation](../architecture/2026-10-22-authentication-activation.md)
added six functional scenarios per target, and the
[Markdown description delivery](../architecture/2026-10-22-task-description-markdown.md)
added one, producing the earlier twenty-five-native/twenty-container inventory.
The [approval lifecycle](2026-10-22-task-approval-lifecycle.md) added three approval
scenarios per target. The historical [withdrawal decision](2026-10-23-task-unapprove.md)
added one functional scenario per target. At that delivery the inventories were twenty-nine
native and twenty-four container scenarios, with these same five capacity/limit cases.

The [requirements](../../../../docs/spec/daynight-web.md) own visible behavior,
the [web design](../../../../docs/design/daynight-web.md) owns model and viewport
contracts. The [Web README](../../../../packages/daynight-web/README.md#production-browser-acceptance)
owns production verification; the [acceptance decision](../../archived/testing/2026-10-20-dashboard-production-acceptance.md)
records the original mechanism choices. Source-bound measurements remain
with the corresponding PR and CI run.

## Alternatives

**Retain only direct external predecessors.** This limited displayed context and
made direct blocking visible, but omitted the transitive path required for
complete prerequisite inspection. The earlier decision's rationale remains
preserved in its own note.

**Add missing ancestors when a card is selected.** This reduces initial content,
but selecting a task would change the visible set, layout and viewport while the
reader traces a dependency. Computing closure at expansion keeps later selection
purely presentational.

**Include all descendants of external tasks.** This would show entire connected
workflows, including branches such as X that do not contribute a prerequisite to
the selected chain. Ancestor closure supplies complete required context without
changing ordinary-component membership.

**Continue anchoring every large graph at its root.** This preserves the earlier
viewport but can put all newly included upstream tasks off the left edge. The
leftmost-rank policy exposes context at a readable scale while preserving the
existing root placement when the root is already leftmost.

## Consequences

A single open chain graph can approach the complete-project limit of 1,000 tasks
and 5,000 dependencies. Closure and projection use visited sets and iterative
traversal, remain linear in project nodes plus edges, and avoid deep recursive
call stacks. Only the open chain's current visible induced graph is laid out; component progress
calculation remains based on main sets.

Independent counts prevent external ancestors from changing chain completion,
filtering or status. Existing per-project browsing preferences and standalone
classification retain their formats and topology rules. Readable initial
placement can leave later tasks outside the viewport, with navigation controls
and keyboard focus providing access; Fit view remains explicit.

The added capacity case exercises dense ancestry under the unchanged production
budgets. It extends the fixed matrix rather than promising equal latency for
every DAG. Smooth line geometry, dependency-selection highlighting, the centered
detail shell and Markdown authoring remain separate focused deliveries; their
future work consumes the complete immutable projection.
