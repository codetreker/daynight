# Task and Goal reads

Start with [Overview](daynight://manuals/overview.md).

Use this topic for definitions, projections, readiness, inventories and property reads. Task/Goal creation, metadata/status/property changes and deletion require [Task writes](daynight://manuals/task-writes.md) with [Write safety](daynight://manuals/write-safety.md). Dependency-only changes require [Dependency writes](daynight://manuals/dependency-writes.md), Dependency graphs and Write safety. Creating a Task with dependencies or changing other Task fields alongside dependencies requires both mutation topics.

## Select the observation

| Purpose | Tool |
| --- | --- |
| One definition and decision version | `task_show`; request `view: "full"` when content matters |
| Current first batch of ready candidates | `task_ready`; bounded batch, no assignee filter or continuation |
| Inventory or all ready work for an assignee | `task_list`; server filters and fenced pagination |
| Ordinary chain and direct external prerequisites | `task_graph`; [Dependencies](daynight://manuals/dependencies.md) owns scope/projections |
| Property definitions or complete values | `task_properties`, `mode: "schema"` or `"values"` |
| Activity, grouped ongoing work and Session identity | [Session reads](daynight://manuals/session-reads.md) |
| Session messages and complete entries | [Session history](daynight://manuals/session-history.md) |
| Separate material | [Steps](daynight://manuals/steps.md), [Threads](daynight://manuals/threads.md), [Attachment reads](daynight://manuals/attachment-reads.md) |

Task reads default to `summary`: identity, type/parent, marked `titlePreview`/`titleTruncated`, status, exact decimal-string version, readiness, `blockedByCount`, assignment, platform and automatic-selection fields. Summaries omit full title/description, properties, dependency arrays and execution times. A preview is neither identity nor duplicate proof.

| Tool | Meaning of `full` |
| --- | --- |
| `task_show` | Complete title, description, properties, dependency arrays and timestamps |
| `task_ready` | Complete selected Tasks, including descriptions |
| `task_list` | Complete list resources including title, properties, relationships and times, **without description** |
| `task_graph` | Complete selected relationship scope; compact nodes still omit Task description, properties and version |

Full time-bearing resources expose creation/update times and nullable `startedAt`, `completedAt`, `cancelledAt`. Returned `dependsOn` includes all prerequisites; `externalDependsOn` is its subset. Write inputs use a different partition described in [Dependency writes](daynight://manuals/dependency-writes.md). Full and summary Task resources include `tags: [{id,name}]`, or `[]`.

Full Task show does not supply attachment inventory/bytes or complete Step/Thread collections. Normal list/show and non-dependency-only graph add ephemeral Session observations; ready results, Task mutation receipts and dependency-only graphs do not. Task versions freeze neither Session state, attachment bytes nor separate observations. [Session reads](daynight://manuals/session-reads.md) owns freshness, partial observations and nullable send eligibility; observations grant no intervention authority.

## Stored type, status and Parent

`type: "task"` identifies ordinary work; `type: "goal"` identifies a stored Goal. An ordinary Task's nullable `parentId` names its Goal owner; titles and dependency edges do not establish ownership. Summary/full resources expose both fields. A Goal has `parentId: null` and cannot contain another Goal.

Full Goal resources additionally expose `progress: {total, done, cancelled, unfinished}` for current direct children. Goal summaries and ordinary Tasks omit progress. Child changes do not increment the Goal version; counts establish no whole-Goal acceptance.

A Goal has `ready: false`, `allowAgents: false`, `requiredPlatform: null` and empty dependency/blocked sets. These are not ordinary scheduling fields. Normal dependency-graph nodes are ordinary Tasks with nullable `parentId`; dependency-only nodes omit type/Parent. Goals are neither graph members nor dependency targets.

| Ordinary status | Read meaning |
| --- | --- |
| `proposed` | Unconfirmed suggestion; unfinished, never ready or automatically acquired, and does not satisfy prerequisites |
| `todo` | Confirmed work not started in its current interval; ready or blocked |
| `in_progress` | Recorded execution interval, not a lock, lease or process handle |
| `done` | Successful delivery recorded; actual outputs/acceptance must support it |
| `cancelled` | Irreversible terminal state requiring no further execution; not delivery |

[Task writes](daynight://manuals/task-writes.md) owns transitions, times, Goal lifecycle and deletion.

## Ready batches

A ready candidate is an ordinary `todo` Task whose direct prerequisites are all done/cancelled. Readiness establishes scheduling, not input sufficiency, authorization, acceptance or ownership.

`task_ready` defaults to 5 candidates, maximum 20, ordered by creation time and UUID. Permission/platform filters apply before the limit; compatibility includes unrestricted Tasks, without proving host capability. Data contains `items` and `projection`, **no continuation**. Repeating the request selects the current first batch again. An empty batch excludes no proposed, blocked, in-progress, terminal or filtered-out work.

There is no assignee filter. To obtain all ready Tasks assigned to the caller, traverse `task_list` with `ready: true` and `assignedTo: "me"`; locally filtering a capped ready batch is incomplete.

## Inventory filters and continuation

`task_list` defaults to `type: "task"`; `type: "goal"` selects Goals. On list and ready queries, omitted `parentId` permits any Parent, null selects unowned Tasks, and a Goal UUID selects its direct children. Filters apply before pagination/ready limits.

Both queries accept Project tag UUIDs in `tagIds`, `tagMatch: "all" | "any"` (default `all`) and `untagged: true`. Nonempty tags conflict with `untagged: true`; empty tags without `untagged` add no condition. Duplicate IDs do not change selection. Malformed UUIDs fail `invalid_input`; nonexistent, deleted or cross-Project tags fail `invalid_tag_filter`. Remove the invalid selection and restart.

List conditions combine. Without `all: true` or explicit `status`, done/cancelled are excluded; `all: true` and explicit status conflict. `assignedTo` accepts a user UUID, `me` or `unassigned`; readiness, automatic permission and platform filters remain independent. Limit defaults to 50, maximum 100. Ordering is in-progress, ready todo, blocked todo, proposed, selected terminal work; within groups use creation time/UUID. This is not relevance ranking.

List data contains `items`, `nextCursor` and `projection`. Continue non-null `nextCursor` as `cursor` under the same caller, Project, type, Parent, filters and view, including normalized tag selection, until null. The cursor binds ordering and a Project-wide typed resource revision fence; relevant changes outside the selected type/Parent can invalidate it. Malformed/mismatched cursors fail `invalid_input`; a changed fence returns `list_changed`. Discard and restart that traversal before claiming completeness. No reusable cursor lifetime is promised.

Task show, graphs and material reads are separate observations outside the list fence. Do not combine old list versions and later content as one snapshot. Scope changes require a fresh traversal.

## Property reads

`task_properties` schema mode accepts no Project/Task input. Values mode requires both and returns complete properties with the exact Task version. Definitions govern valid names, values, nullability and public writability; read failures are not empty schemas/value objects.

Absence (`{}`), a present empty value (`{"pullRequests":[]}`) and permitted JSON null differ. For changes, read [Task writes](daynight://manuals/task-writes.md).
