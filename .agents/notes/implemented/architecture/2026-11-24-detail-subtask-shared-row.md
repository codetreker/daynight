# Agent Note: Shared Task rows in ordinary Task details

Status: implemented

## Problem

The direct child tab in ordinary Task details exposes only each child's title and
lifecycle. The same ordinary Task in a project list exposes its identity,
assignment, tags, timing and execution restrictions. Readers need those facts
and independent ID copying without changing the authorized child scope, page
order or detail navigation. The child endpoint returns complete Task details but
does not supply the project list's admitted Worker and Session observations.

## Decision

`OrdinarySubtaskRow` adapts each authorized child `TaskDetail` to `TaskRowModel`
and composes the production `TaskRow` with `TaskAssigneeIdentity`. The adapter
preserves the response's title, ID, tags, assignment, timing, platform,
automatic-execution permission, readiness, dependency blocking and `readTaskPaused`
result. Worker is explicitly `unknown` and Session is `null`; neither absent nor
unverified execution metadata proves an empty history or a current Session.

`OrdinaryTaskRelations` remains the owner of authorized child pagination,
independent parent reads, resource withdrawal and fixed-parent creation. Its
stable child keys and row instance identities preserve still-valid controls and
focus during refresh. The title's actual child overview URL and ordinary opening
callback use the existing draft-aware browser navigation; modifier and middle
clicks retain native link behavior. ID copying uses the shared independent
control and feedback. Row-specific presentation and status styles belong to the
shared row, while the relation host owns the list container and page controls.

The relation host supplies the child list's `TaskExecutionClockProvider` from the
exact project snapshot passed by `TaskDetailSurface`. This clock carries observed
time and the project's warning threshold, independently of child-scope authority.
An explicit null snapshot creates an unsampled clock without inventing a time
anchor or warning threshold. Running duration stays unknown; completed intervals
render through the shared rules when project settings are available. A standalone
caller that omits the snapshot can inherit an existing clock; without one it
receives an unsampled provider. The detail host cannot depend on a page ancestor
for this assembly because Goal acceptance graphs can append a detail surface
outside the page clock's subtree. Timed children in that surface still require a
clock, even when no current project time sample is available.

Shared member, tag-color and usage helpers become active only while Subtasks is
visible and its current resource remains admitted. Relation reads continue under
their existing authorization even when the tab is hidden. No per-row Task,
Worker or Session requests are introduced. The
[relation decision](2026-11-23-web-ordinary-task-relations.md) owns authoritative
parent projection, the [tab decision](2026-11-24-web-subtask-tab.md) owns the stable
reading surface, and the [shared row decision](2026-11-15-shared-project-task-row.md)
owns common field presentation and independent controls.

## Alternatives

**Extend the title-and-status row locally.** This would create another owner for
Task fields, status presentation, copy feedback and responsive styles that must
stay aligned with the existing production row.

**Use the project snapshot adapter for child details.** The authorized child page
is the complete relationship source, while shared snapshots can omit ordinary
parent fields. Worker and Session observations have their own admission rules;
a structurally similar Task detail cannot substitute for those observations.

**Read missing execution records for every child.** Additional per-Task reads
would add request and cancellation ownership to pagination, and could combine
facts from different admitted histories. Explicit unknown inputs preserve the
available evidence without adding that execution-observation mechanism.

## Consequences

Ordinary Task child tabs in dialogs, independent pages and fullscreen use the
same field presentation, status semantics and copy behavior as project rows.
The response order, child scope and creation rules remain independent of the
shared row. Worker details and current Session entry remain unavailable until a
reliable admitted source is supplied; the lifecycle still displays correctly.
The local clock adds no reads and lets timed children render in every detail
host; a missing sample remains visible as unknown running duration.
Hidden or withdrawn tabs stop auxiliary demand while retaining the relation
host's existing reading continuity. Long titles and full UUIDs use the shared
row's wrapping rules rather than another detail-specific row layout.
