# Agent Note: Task List Status and Assignee Filtering

Status: implemented

## Problem

A recent-completion window hides older completed work from the default task
lists, while a binary visibility switch cannot select a particular task status.
Filtering chain children also removes context needed to understand the progress
and dependency relationships of a matching task. Applying different conditions
to different members could retain a chain even though no task meets the user's
combined selection.

## Decision

The task lists share status and assignee conditions within a project visit.
Status defaults to all and can select `todo`, `in_progress`, `done` or `cancelled`; all
history remains available. A standalone task must itself satisfy both
conditions. A chain remains visible when one ordinary-component member satisfies
both; its actual representative and all ordinary members remain visible even
when they do not match. External prerequisites supply graph context but are not
members for matching. Filtering precedes pagination, and changing either
condition resets both task lists to their first page. Overview navigation adjusts
conditions that hide its target.

The status control keeps its native select and label, but replaces the browser's
arrow with the same symmetric SVG shape used by the adjacent assignee picker.
The icon does not intercept pointer input and the select reserves space for it.

The full index continues to own chain progress, readiness, dependencies,
statistics and graph context. The [recent browsing decision](../../archived/feature/2026-10-27-recent-task-pages.md)
retains the seven-local-day Overview projection and pagination rationale, but
its former task-list window and independent Show all preferences are replaced.
The [assignee foundation](../../archived/architecture/2026-11-03-task-assignment-foundation.md)
records the rationale for the existing identity and profile semantics. The [task view](../../archived/feature/2026-10-22-project-task-views.md),
[Goal list](../../archived/feature/2026-10-26-goal-task-lists.md), [project sections](../../archived/feature/2026-10-25-project-overview-task-sections.md),
[chain status](../../archived/bug-fix/2026-10-22-task-chain-status.md), [Overview progress](../../archived/feature/2026-10-26-project-overview-progress.md),
[status ordering](../../archived/bug-fix/2026-10-28-project-status-order.md), and
[shared scroll](../../archived/bug-fix/2026-11-03-shared-task-list-scroll.md) decisions
record the original choices behind the other behavior, which remains unchanged.
The [Web specification](../../../../docs/spec/daynight-web.md)
owns observable behavior and the [Web design](../../../../docs/design/daynight-web.md)
owns current composition.

## Alternatives

**Keep the recent default and Show all switches.** These distinguish only recent
and complete history, so finding an older task by actual status still requires
reading unrelated rows. Separate switches also make the two categories diverge.

**Filter the task snapshot or expanded children.** Removing nonmatching members
would obscure chain context or alter progress and readiness. Filtering the
complete component as one top-level item preserves those facts while allowing
matching tasks to determine visibility.

**Keep the browser's native arrow.** Its rendering differs from the adjacent
picker and can appear skewed; a fixed icon provides consistent geometry while
retaining the native control's selection and keyboard behavior.

## Consequences

A matching chain can display members with different statuses and assignees;
its aggregate status need not match the selected individual status. All-history
browsing can produce larger filtered sequences, but top-level pagination still
bounds the displayed page. A single expanded chain remains unbounded by page
size. Filters do not change synchronization, task data or access permissions,
and the Overview's recent window and project totals remain independent.
