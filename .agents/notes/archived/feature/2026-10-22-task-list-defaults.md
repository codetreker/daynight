# Agent Note: Task list defaults

Status: implemented

## Problem

Routine task inventory needs to make active and actionable work easy to scan.
Completed tasks compete with unfinished work, while descriptions, versions and
timestamps make each human list entry long. Callers still need an explicit way
to inspect completed work and complete resources for programmatic processing.

## Decision

`daynight task list` selects unfinished tasks by default. `--all` includes all
statuses, while `--status <status>` explicitly selects one status, including
`done`. These options conflict and are rejected before configuration, Git or
network I/O. `--ready` intersects the selected statuses, including with `--all`.

The command reads every matching page before selecting and stably grouping the
results: `in_progress`, ready tasks, remaining `todo`, then `done`.
Each group preserves the service order across pages. Human and JSON output consume the
same result sequence. Historical reader preparation added proposed as another
unfinished group. The [status assignment decision](../architecture/2026-10-24-task-status-assignment.md)
removes that state; current ordering and inputs use only the three groups of
unfinished work plus done.

Human task lists contain ID, project, title, status, readiness, dependencies,
blocking and all PR references. They omit description, version, creation time
and update time. Human show, ready, create and update results retain full task
resources. The later [JSON description decision](../simplification/2026-10-22-task-list-json-description.md)
partially supersedes the original choice to retain every task field in list
JSON: all list variants now omit only description. Show and ready JSON retain
full task resources. Shared escaping, full displayed field values, clear resource
boundaries and rendering space proportional to displayed content continue to
apply.

This partially replaces the
[original project/task CLI decision](../architecture/2026-10-20-project-task-cli-design.md).
Its complete human resource blocks made every field accessible without a detail
query and avoided terminal column-width assumptions. Operational inventory now
uses a smaller field set while detail and mutation output preserve that rationale.
The [requirements](../../../../docs/spec/daynight-project-task.md) own observable
behavior and the [design](../../../../docs/design/daynight-project-task.md) owns
command selection, pagination and rendering responsibilities.

## Alternatives

**Remove fields from every human task renderer.** This would also remove task
description, version and timestamps from bounded ready selection, details and
confirmed writes, although those operations supply the context and exact version
needed for decisions and subsequent updates. Operation-specific list rendering
keeps the inventory compact while preserving those consumers.

**Expand API filtering and sorting for the list default.** New service ordering
or multi-status filtering would change a shared pagination contract for behavior
owned by one CLI operation. Existing complete traversal and single-status/ready
filters already provide the data needed for final selection and stable grouping.

## Consequences

The default list focuses on unfinished work and puts active tasks before ready
candidates. `task list --all --json` provides an explicit inventory including
completed work, with every API field except description. Scripts using the
default list observe the same status selection and ordering as terminal callers.
The original full-resource JSON choice let scripts read descriptions without
individual detail queries; the replacement decision makes that extra read
explicit while retaining versions and timestamps in the inventory.

Global ordering requires the full matching traversal to finish; existing command
deadlines, byte budgets and refusal of partial metadata output still apply.
Pagination remains a sequence of service reads, not a cross-request snapshot.
The groups express list presentation order without adding a task priority field,
reservation or ownership claim. Bounded ready selection keeps its service order
and count bound.
