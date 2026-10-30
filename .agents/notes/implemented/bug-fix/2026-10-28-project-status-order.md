# Agent Note: Project Status Ordering

Status: implemented

## Problem

Creation order can put newer completed work ahead of older ongoing work in the
project task lists and Overview. A chain representative's individual status does
not describe its whole outcome, and placing standalone progress permanently last
can obscure running work behind pending or finished chains. Ordering only the
current page also keeps older running work off the first page.

## Decision

The project presentation reverses a copy of the exact service representative
order, then stably orders it by complete ordinary-component status:
`in_progress`, `todo`, `done`. Classification, recent filtering and pagination
consume that ordered copy. Single-member component status equals the standalone
task's status. Equal-status entries retain exact `createdAt DESC, id DESC`
without parsing timestamps into JavaScript milliseconds. The API, cached
summaries, full index, component members and graph projections retain their
existing orders and responsibilities.

Overview progress carries each chain's complete component status. The standalone
aggregate derives its status from its existing recent set: all done is `done`,
partial completion or any running task is `in_progress`, otherwise `todo`.
Overview stably orders the complete combined row sequence by the same status
priority before slicing a page. Equal-status chains keep their existing order;
the standalone aggregate follows chains in that status, without a synthetic
creation time. Fresh snapshots recalculate both lists and progress from the same
index.

This supersedes pure newest-first top-level presentation in the
[task view decision](../feature/2026-10-22-project-task-views.md) and fixed-last
standalone placement in the
[overview decision](../feature/2026-10-26-project-overview-progress.md).
The [recent browsing decision](../feature/2026-10-27-recent-task-pages.md)
retains its time window, whole-component filtering and page capacity, and the
[Goal list decision](../feature/2026-10-26-goal-task-lists.md) retains complete
child membership. Its original within-status snapshot order is retained for
unfinished children and completion-time ties; the
[completed-child ordering decision](../feature/2026-10-30-completed-subtask-order.md)
owns exact completion-time descending order and unknown-time placement.
Required behavior belongs in the
[Web requirements](../../../../docs/spec/daynight-web.md); composition belongs in
the [Web design](../../../../docs/design/daynight-web.md).

## Alternatives

**Sort timestamp strings or parsed dates again in the display.** The service and
cache already supply exact timestamp and ID order. Parsing dates into
milliseconds loses submillisecond distinctions, while a second timestamp
comparator adds another precision-sensitive owner without changing the result.
Stable status sorting of the reversed copy reuses the established ordering.

**Keep the standalone aggregate after every chain.** This preserves the former
category order but still places ongoing standalone work after pending or done
chains. Aggregate status supplies the same priority without inventing a creation
time for the row.

## Consequences

Older running outcomes can appear on the first page in the recent and full-history
views. Equal-status positions remain deterministic, and the aggregate can move
between pages when its status changes. Existing row keys preserve mounted row
state when it stays on the page; moving off-page retains the existing unmount
behavior. No API, cache format, persistent preference, page size, UI element,
wording or layout changes are introduced.
