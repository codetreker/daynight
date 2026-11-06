# Agent Note: Unfinished Task Tab Counts

Status: implemented

## Problem

The project tabs use different units for their badges: standalone tasks and
root-chain entries, both including completed work. A chain entry can contain
many tasks and overlap other roots through shared successors. Those numbers do
not communicate how many unfinished tasks remain in each view.

## Decision

Both tab badges count unfinished tasks from the complete snapshot. Pending and
in-progress tasks contribute one; done contributes zero. The historical
[four-state reader decision](2026-10-22-proposed-task-readers.md) extended the
inventory; the [status assignment decision](../architecture/2026-10-24-task-status-assignment.md)
removes that fourth state without changing the counting unit. Under the
[external dependency decision](../architecture/2026-10-23-external-dependency-design.md),
an ordinary singleton contributes to Standalone tasks and every multi-member
component task contributes to Task chains. Each ID is counted once; a finished
representative does not hide unfinished members. External context does not
change the counted owner.

The counts do not depend on active tabs, expanded roots or completed-item
filters. Categories with only finished tasks show zero even when completed rows
are visible. Snapshot replacement recomputes classification and counts together;
failed refreshes retain the last successful snapshot. There are no new API
requests or browser preference records. List toolbars still describe visible and
total standalone items or ordinary-component entries, including every page of
the filtered sequence; per-chain progress uses that component's complete members.
The [recent browsing and pagination decision](2026-10-27-recent-task-pages.md)
changes displayed recency and page size without changing these counting units.

This partially supersedes badge semantics in the [task view decision](2026-10-22-project-task-views.md).
Required behavior belongs in the [specification](../../../../docs/spec/daynight-web.md),
and the [design](../../../../docs/design/daynight-web.md) explains the projection.

## Alternatives

**Count unfinished root chains.** This reports the number of workflows that
remain open, but does not show their unfinished task volume. It retains mixed
units between the tabs.

**Sum unfinished tasks from each root's progress.** In the original root model,
shared successors inflated this sum. The complete-index unique-task fold kept
badge units independent of displayed roots. Ordinary components now remove
membership overlap, while the existing single fold still derives category and
unfinished count from one consistent snapshot.

## Consequences

The two badges use the same unit and sum to the project's pending plus
in-progress total. A dependency edit may move unfinished tasks between the two
badges on refresh. A chain badge can exceed the number of chain rows because it
counts their unique tasks. The ordinary-component list, all-edge graph contexts, aggregate chain status,
exact server ordering and original member-witness preferences use the same
snapshot without a persisted group identity.
