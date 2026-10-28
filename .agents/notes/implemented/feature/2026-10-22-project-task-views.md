# Agent Note: In-project Task Views

Status: implemented

## Problem

Disconnected tasks and dependency workflows require different browsing actions.
A disconnected task gains no context from expanding a one-node graph before
opening its details. A shared list also makes its singleton progress compete
with meaningful chain progress. Separating those workflows must retain one
project snapshot and avoid reclassifying a task when its prerequisites finish.

## Decision

The project Task list section has Standalone tasks and Task chains tabs within
its existing URL. They use the same snapshot, refresh and detail owner as
Overview. An absent inner-category preference selects Task chains; subsequent
visits retain that category per project. The [project section decision](2026-10-25-project-overview-task-sections.md)
owns the outer Overview destination and retained task workspace; the
[section restoration decision](../bug-fix/2026-10-25-project-section-restoration.md)
owns per-project outer selection and the Overview default without a saved record.
Under the
[external dependency decision](../architecture/2026-10-23-external-dependency-design.md),
chains are ordinary-edge weak components. An ordinary singleton is standalone
even when external prerequisites block it. Status and completed filters do not
change membership; a fresh snapshot replaces classification and statistics together.

Standalone native rows show individual facts and open details directly; a real
unfinished prerequisite has an explicit blocked badge. Known execution timing
follows the [timing
decision](../architecture/2026-10-23-task-timing-design.md). Chain rows
aggregate component members and expose direct child-task details through the
[Goal-list disclosure](2026-10-26-goal-task-lists.md). A separate
dependency-graph action retains complete upstream context, fullscreen and graph
Details. Normal `A → C ← B` is one chain with three members. The original tab
design retained one entry per root, and its original badges counted entries.
The [unfinished count decision](2026-10-22-unfinished-task-tab-counts.md)
replaces the badge unit with unfinished tasks. Current components give each
task one membership; toolbars separately report all filter-matching entries
against complete category totals, independently of page size.

Each inner category has its own Show all choice and scroll position. Both lists
use status-first presentation order with exact newest-first ties, as defined by
the [status ordering decision](../bug-fix/2026-10-28-project-status-order.md). The [recent browsing and pagination
decision](2026-10-27-recent-task-pages.md) replaces the unfinished-only default
with all unfinished work plus recent local-calendar completions, and adds
independent 20-entry pages without truncating component data. Current page
numbers remain in memory for the project visit; category, standalone visibility,
completed-chain visibility and scroll positions keep their independent records. Storage failure leaves in-memory interaction available with a visible
persistence notice. Page positions do not persist graph geometry, pan, zoom,
details or fullscreen. The original category design retained the inline member
witness or explicit collapse across switches; the [graph-dialog
decision](2026-10-26-task-chain-graph-dialog.md) replaces that persistent
expansion with click-only temporary opening. Leaving either Task chains or Task
list closes the dialog, and returning leaves it closed. Both inner tabpanel
wrappers keep stable IDs and hide the inactive category. Only active category
contents mount, so leaving Task chains resets row-local Goal disclosure on its
next mount. The outer Task list subtree remains mounted after first use when
Overview is selected, retaining those list choices across outer switches.

This partially supersedes the unified list in the [presentation
decision](../../archived/feature/2026-10-21-task-chain-presentation.md) and extends the [browsing
preference decision](../../archived/feature/2026-10-21-task-browsing-preferences.md). Complete
dependency semantics follow the choices recorded in the [projection
decision](../../archived/feature/2026-10-20-task-graph-projection.md); the [chain status
decision](../bug-fix/2026-10-22-task-chain-status.md) continues to own
aggregate status. Required behavior and current mechanisms belong in the
[specification](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-web.md). The original [interactive
mockup](../../../../docs/design/mockups/task-views.html) retains the earlier
inner-category visual baseline; the production-component browsing fixture
demonstrates current Goal lists, independent graph dialogs and category
behavior.

## Alternatives

**Separate navigation pages.** Independent routes would give each category a
navigation destination but repeat project context and separate two views of the
same snapshot. In-project tabs keep statistics, refresh and detail behavior in
one project workspace.

**Store a backend task kind.** A standalone/chain field would duplicate the
existing dependency topology and require every dependency write to maintain its
classification. Complete graph indexes already provide both incoming and
outgoing relationships, so classification remains a frontend projection.

**Regroup chains by connected component.** At the original tab decision this
was deferred because it changed root-based entries, projection and progress.
Keeping category state separate from domain projection preserved that option.
The later external-dependency requirement provides the missing boundary:
ordinary components now form chains, while external prerequisites do not merge
them. Its decision supersedes the earlier root-based membership choice.

## Consequences

Standalone tasks reach details in one action. Dependency workflows retain the
complete graph context and existing progress rules. Completion and readiness do
not move work between categories. Chain entry counts cannot be added as
project task totals, because a chain entry can contain many tasks and share
successors with other chains. The two tab badges instead sum to the project
unfinished-task total. Filters and tab choices make no API requests or server
changes.

Per-project browser records preserve browsing intent across visits while the
server remains authoritative for a freshly read snapshot. New dependency edits
can move a task between views or change its representative; original member
witnesses resolve the surviving component during an open graph session and an
unavailable chain closes that dialog. Inactive inner categories consume no
mounted graph resources. Outer section switches retain the visited task subtree,
while graph opening ends on either category or section departure. A new explicit
opening initializes its pan and zoom. Keyboard tabs,
native row actions and active-view focus restoration are
part of the delivered interaction, including empty and all-completed views.
The actual-backend `project-view-tabs` scenario runs on native and production
container targets. Strict inventory validation and the original capacity/limit
scenarios remain required, following the choices recorded in the
[acceptance pipeline decision](../../archived/testing/2026-10-21-web-acceptance-pipeline.md).
The [complete context decision](2026-10-22-complete-prerequisite-context.md) adds
dense external ancestry without changing tab classification or chain membership.
