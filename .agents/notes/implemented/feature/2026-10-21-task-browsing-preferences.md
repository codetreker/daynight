# Agent Note: Project Task Browsing Preferences

Status: implemented

## Problem

A project can contain several task chains. Reloading or returning from another
project loses the chosen chain, explicit collapse and completed-work visibility.
Restoring those choices must respect the current visible list: a saved root can
disappear or be hidden, and a project can temporarily have no visible chains.

## Decision

Browser preferences are isolated by origin and project ID. The existing
expanded-root JSON record keeps its original
`{ expandedRootId: string | null }` shape; null represents a collapsed list.
Completed-chain visibility uses its existing separate localStorage JSON-boolean
record and defaults to hidden. The [task view decision](2026-10-22-project-task-views.md)
extends this ownership with independent records for the selected tab, standalone
completion visibility and the two task-category page positions. Within Task
list, absent category state defaults to chains, both completion filters default
to hidden, and page positions default to the start. The [project section decision](2026-10-25-project-overview-task-sections.md)
opens the project on Overview independently of these records and restricts their
scroll ownership to active Tasks. There is no server preference or task-data change.

The [presentation decision](2026-10-21-task-chain-presentation.md) supplies
newest-first ordinary-component representatives. The saved string is an original
member witness: componentByTask resolves it to its current representative even
if a merge changes the displayed heading. A still-valid witness is not rewritten
to that representative, so a later split can return to the portion containing
the original task. Explicit null remains collapsed, including on reload.
Absent preferences select the newest visible chain. Missing or hidden witness
components use the existing visible fallback. Empty/loading/initial-failure
states do not invent explicit collapse, and zero-visible chains retain intent
for later reveal. Switching to standalone keeps that intent without a canvas.
Topology reset is separate from presentation lifetime: with an unchanged
representative, changed members reset the overview/inspection and framing but
keep the fullscreen canvas and active Details mounted. Replacing the
representative is a chain switch; neither case rewrites a valid witness.

Preference errors are displayed separately from graph request errors. Invalid
stored data and denied storage access leave browsing usable with in-memory
choices. Write failure preserves the current interaction and reports that it
cannot be retained after reload. The tabs, checkboxes, reveal actions and graph
controls remain operable. Selected details, graph layouts, zoom, pan and
fullscreen are not persisted. Page scroll restoration is independent per inner
category; inactive category contents unmount, so returning from Standalone tasks
to Task chains initializes the canvas viewport. Stable hidden wrappers preserve
each category's associated panel ID. Outer Overview/Task list switching instead
retains the visited task workspace; Overview keeps a separate per-mount position
and cannot restore or write these task offsets.
The [dashboard decision](2026-10-20-project-task-dashboard.md) retains the
single-canvas and snapshot lifecycle rationale.

## Alternatives

**Keep preferences only in the project component.** This was sufficient for a
single visit and avoided a storage boundary. It loses a chosen root, explicitly
collapsed list and visibility choice on reload or project navigation.

**Use sessionStorage.** It retains reloads within one tab but loses preferences
when that tab closes. localStorage fits project viewing preferences across
visits without introducing an account or a server preference record.

**Add visibility to the delivered expansion record.** That changes an existing
stored shape solely to add an independent choice. A separate record preserves
the expansion format and lets either preference be reported and restored
without requiring a record migration or compatibility branch.

## Consequences

Reload and project navigation reopen Overview while preserving the saved task
category, each category's
completed visibility and page scroll position, and chain expansion while graph data
still comes from a fresh complete snapshot. Storage access is synchronous and
bounded to small project records. Privacy settings or invalid stored values can
prevent persistence; visible notices distinguish that condition from a save.
Preferences are local to one browser origin with no cross-browser synchronization.
Current tabs keep their own in-memory choices. A nonempty list may replace a
hidden saved witness with its visible fallback; a zero-visible list retains intent
until rows are available again.
