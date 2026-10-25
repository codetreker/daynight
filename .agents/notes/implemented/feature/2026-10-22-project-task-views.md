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
adds the outer Overview destination, its default and retained task workspace. Under the
[external dependency decision](../architecture/2026-10-23-external-dependency-design.md),
chains are ordinary-edge weak components. An ordinary singleton is standalone
even when external prerequisites block it. Status and completed filters do not
change membership; a fresh snapshot replaces classification and statistics together.

Standalone native rows show individual facts and open details directly; a real
unfinished prerequisite has an explicit blocked badge. Known execution timing
follows the [timing decision](../architecture/2026-10-23-task-timing-design.md).
Chain rows aggregate component members, retain all upstream context and provide
fullscreen and Details. Normal `A → C ← B` is one chain with three members.
The original tab design retained one entry per root, and its original badges
counted entries. The [unfinished count decision](2026-10-22-unfinished-task-tab-counts.md)
replaces the badge unit with unfinished tasks. Current components give each task
one membership; toolbars separately report visible/total entries.

Each inner category has its own completed-item filter and page scroll position. The chain
view retains its original member witness or explicit-collapse choice when tabs change.
Both lists use the exact newest-first presentation order. Existing expansion
and completed-chain storage records retain their shapes; tab, standalone
visibility and scroll positions use independent records. Storage failure leaves
in-memory interaction available with a visible persistence notice. Page scroll
positions do not persist graph geometry, pan, zoom, details or fullscreen.
Both inner tabpanel wrappers keep stable IDs and hide the inactive category.
Only active category contents mount, so returning from Standalone tasks to Task
chains initializes its canvas viewport. The outer Task list subtree remains
mounted after first use when Overview is selected.

This partially supersedes the unified list in the [presentation decision](2026-10-21-task-chain-presentation.md)
and extends the [browsing preference decision](2026-10-21-task-browsing-preferences.md).
The [projection decision](2026-10-20-task-graph-projection.md) retains ownership of
complete dependency semantics; the [chain status decision](../bug-fix/2026-10-22-task-chain-status.md)
continues to own aggregate status. Required behavior and current mechanisms
belong in the [specification](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-web.md). The [interactive mockup](../../../../docs/design/mockups/task-views.html)
provides final visual styling without a backend.

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
witnesses resolve the surviving component and visible fallback handles absence. Inactive inner-category canvases consume no mounted graph resources, at the
cost of initializing pan and zoom after category return. Outer section switches
retain the visited task subtree and its graph state instead. Keyboard tabs,
native row actions and active-view focus restoration are
part of the delivered interaction, including empty and all-completed views.
The actual-backend `project-view-tabs` scenario runs on native and production
container targets; the [acceptance pipeline](../testing/2026-10-21-web-acceptance-pipeline.md)
retains strict inventory validation and the original capacity/limit scenarios.
The [complete context decision](2026-10-22-complete-prerequisite-context.md) adds
dense external ancestry without changing tab classification or chain membership.
