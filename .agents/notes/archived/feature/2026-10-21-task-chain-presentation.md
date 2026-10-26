# Agent Note: Task Chain Presentation

Status: implemented

## Problem

A project accumulates independent task chains over time. Showing the oldest
roots first pushes recent work below historical chains. Fully completed chains
also occupy the same list as unfinished work, but a completed root can still
have unfinished descendants. The original inline view also used ordering and visibility to choose its
initially expanded graph, so inconsistent choices could open a different chain
from the first visible row. Database creation timestamps can distinguish
tasks within one JavaScript millisecond. Generous row padding also limits how
much work fits in one viewport, especially with long titles.

## Decision

The [task view decision](../../implemented/feature/2026-10-22-project-task-views.md) separates ordinary
singleton tasks from multi-member chains. The original shared root list remains
the historical premise for this ordering and density decision. Current rows use
the [external dependency model](../../implemented/architecture/2026-10-23-external-dependency-design.md):
the earliest ordinary root is each component's representative. Its exact service
order supplies newest-first presentation without decoding database times into
JavaScript milliseconds. Status or ordinary metadata edits do not reorder it;
changed membership or representative can change its heading and position.

A chain row is hidden by default only when its distinct main-set progress has
`status === "done"`, which is equivalent to every distinct main task being
complete. Status badges, completed counts and visibility share that model-derived
status. The [chain status decision](../../implemented/bug-fix/2026-10-22-task-chain-status.md)
replaces the original root-status badge with an aggregate chain badge.
Standalone completion belongs to its own tab and individual task status. A
completed representative with unfinished component members stays visible. The native
Show completed chains
checkbox includes the completed-chain count and reveals those rows; the compact
view toolbar reports visible and total chains alongside newest-first ordering. Standalone tasks have their own completed
visibility choice, count and direct-detail rows. Each category's all-complete
state remains distinct from an empty category or project and offers a reveal
action. That action focuses the persistent
checkbox before the empty-state button disappears.

ChainList receives visible representatives alongside the complete immutable
GraphIndex. Its representative row now discloses a compact list under the
[Goal-list decision](../../implemented/feature/2026-10-26-goal-task-lists.md); the sibling
dependency-graph control alone opens the graph. The [graph-dialog
decision](../../implemented/feature/2026-10-26-task-chain-graph-dialog.md) replaces the original inline
default selection and persisted expansion. Its temporary original task witness
resolves the current component; changed representatives do not overwrite a
valid witness. A missing, standalone or hidden witness closes the dialog. First
visits, reloads and returns leave it closed. The independent filters and page
positions retain the [browsing preference
ownership](2026-10-21-task-browsing-preferences.md).

Graph projection, progress and API order retain the responsibilities in the
[projection decision](2026-10-20-task-graph-projection.md). Every displayed graph
keeps all component members and complete prerequisite context. A prerequisite
can be context in several graphs without becoming a shared member. Project
counters and selected details use the full snapshot. Row filtering makes no
request and does not change dependency direction or layout. A detail remains
open when its graph disappears but the task still exists; closing restores a
surviving trigger or a control in the active task view. The task view decision
owns active-category fallback when a trigger is no longer visible.

The original density adjustment established compact representative buttons, 7px
list gaps and naturally growing long titles. Goal headers retain those list
gaps and 13px desktop / 12px narrow-screen titles while separating disclosure
from the graph action. The progress area narrows with the viewport, and the
graph control can wrap on narrow screens. Compact child rows show individual
task status. Native actions, focus outlines and complete aggregate progress
remain present. Task-node and canvas geometry keep their existing dimensions.

## Alternatives

**Change the graph API to descending order.** The API already serves a stable
exact ascending sequence to other clients and the pure graph model. Reversing
only root presentation supplies the requested browsing order without changing
the exact sequence consumed by those clients.

**Sort roots with JavaScript dates.** Millisecond conversion merges distinct
database timestamps and can order roots by ID when their true creation times
differ. Reversal preserves the existing exact database comparison.

**Hide every root whose own status is done.** A finished prerequisite can head
an unfinished chain. Using the main-set progress preserves that work in the
list and distinguishes root state from chain completion.

**Remove done nodes from each displayed graph.** This discards prerequisites
and changes the meaning of shared and external dependencies. Hiding only whole
completed chains keeps every visible graph's complete dependency context.

**Shrink text to fit more rows.** Most excess height came from padding and
spacing. Reducing that space keeps title sizes and permits larger metadata and
status text while increasing list density.

**Use a fixed row height.** That creates a hard ceiling for long Chinese or
English titles and progress labels. A minimum height gives short rows a compact
floor while allowing content to grow without clipping.

## Consequences

Compact rows expose more work in the same viewport while retaining readable
content and a full-row click target. Recent unfinished chains appear first while
historical completed work remains one explicit control away. Presentation arrays are bounded by the project node
limit; completed-chain classification uses component progress and
never duplicates graph nodes or changes project totals. Task topology determines
category before completion filtering. Visibility, selected section/category and
page browse positions are independent local per-project preferences. Graph
opening is temporary; hiding its chain closes the dialog without opening a
replacement, and revealing rows again does not reopen it. A task actually removed from the snapshot retains the existing
detail-close notice and focus behavior.
