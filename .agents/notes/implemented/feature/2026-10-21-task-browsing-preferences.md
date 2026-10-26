# Agent Note: Project Task Browsing Preferences

Status: implemented

## Problem

The original inline task-chain view lost the chosen chain, explicit collapse
and completed-work visibility when reloaded or revisited. Restoring browsing
choices needed to respect the current visible list and temporary empty states.
Independent category, section and page-position choices also need predictable
restoration without changing server task data.

## Decision

Browser preferences are isolated by origin and project ID. Completed-chain
visibility uses a separate localStorage JSON-boolean record and defaults to
hidden. The [task view decision](2026-10-22-project-task-views.md) extends this
ownership with independent records for the selected category, standalone
completion visibility and the two task-category page positions. Within Task
list, absent category state defaults to chains, both completion filters default
to hidden, and page positions default to the start. The
[project section decision](2026-10-25-project-overview-task-sections.md) restricts
task scroll ownership to active Tasks. The independent outer section record
follows the [section restoration decision](../bug-fix/2026-10-25-project-section-restoration.md):
reload and return restore the selected section, with Overview as the default
without a saved record. There is no server preference or task-data change.

The original inline view also stored `{ expandedRootId: string | null }` in
`daynight:project-view:${projectId}`. Its string preserved the original member
witness through merges and splits, and null preserved explicit collapse. That
was appropriate while expansion was part of the page layout. The [graph-dialog
decision](2026-10-26-task-chain-graph-dialog.md) replaces persistent opening
with an explicit, temporary reading session: the old expansion record is no
longer read or written, entry starts closed, and leaving Task list or its Task
chains category closes the dialog. An open dialog still resolves its original
witness through the current ordinary component without overwriting a valid
witness with its representative. A missing, standalone or hidden witness closes
it instead of opening another chain. The [Goal-list
decision](2026-10-26-goal-task-lists.md) adds row-local task disclosure
separately from graph opening: mounted rows retain it through refresh and
dialog round trips, and remounted rows start collapsed without reviving the old
storage record.

Preference errors are displayed separately from graph request errors. Invalid
stored data and denied storage access leave browsing usable with in-memory
choices. Write failure preserves the current interaction and reports that it
cannot be retained after reload. Tabs, checkboxes, reveal actions and graph
controls remain operable. Selected details, graph layouts, zoom, pan, dialog
opening and fullscreen are not persisted. Page scroll restoration remains
independent per inner category. Stable hidden wrappers preserve associated
panel IDs, while inactive inner-category contents unmount. Outer Overview/Task
list switching retains the visited task workspace; Overview keeps a separate
per-mount position and cannot restore or write the task offsets.
The [dashboard decision](2026-10-20-project-task-dashboard.md) retains the
single-canvas and snapshot lifecycle rationale.

## Alternatives

**Keep preferences only in the project component.** This was sufficient for a
single visit and avoided a storage boundary. It lost a chosen root, explicitly
collapsed list and visibility choice on reload or project navigation. Current
graph opening is deliberately temporary, while section, category, filters and
page positions retain the independent persistence justified here.

**Use sessionStorage.** It retains reloads within one tab but loses preferences
when that tab closes. localStorage fits project viewing preferences across
visits without introducing an account or a server preference record.

**Add visibility to the delivered expansion record.** This would have changed
an existing stored shape solely to add an independent choice. A separate record
preserved the expansion format and let either preference be reported and
restored without a migration or compatibility branch. That separation now lets
filters retain their format after graph opening stops using storage.

## Consequences

Reload and project navigation restore the saved outer section, task category,
each category's completed visibility and page scroll position, while graph data
comes from a fresh complete snapshot. Graph dialogs start closed and require a
new dependency-graph action. Storage access is synchronous and bounded to small
project records. Privacy settings or invalid stored values can prevent
persistence; visible notices distinguish that condition from a save.
Preferences are local to one browser origin with no cross-browser
synchronization. Current tabs keep their own in-memory choices.