# Task reads and lifecycle

Read this topic to select Task/Goal observations or change Task fields, status and properties. Establish unknown Account/Project context through [Concepts](daynight://manuals/concepts.md); every write also requires [Write safety](daynight://manuals/write-safety.md). Examples are `tools/call` parameters with fictional IDs and versions. Use `tools/list` for exact current arguments.

## Choose the observation

| Purpose | Tool and completeness |
| --- | --- |
| One definition and decision version | `task_show`, explicitly `view: "full"` when definition content matters |
| Current first batch of ready candidates | `task_ready`; bounded single batch, no pagination or assignee filter |
| Project inventory or all ready work for an assignee | `task_list`; server filters and fenced pagination |
| Ordinary chain and direct external prerequisites | `task_graph`; graph scope/projections are owned by [Dependencies](daynight://manuals/dependencies.md) |
| Property definitions or complete values | `task_properties`, `mode: "schema"` or `"values"` |
| Activity, grouped ongoing work or Session history | [Session reads](daynight://manuals/session-reads.md), including `task_work_list` |
| Step definitions, participant discussion or file bytes | [Steps](daynight://manuals/steps.md), [Threads](daynight://manuals/threads.md), [Attachment reads](daynight://manuals/attachment-reads.md) |

```json
{"name":"task_show","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","view":"full"}}
```

Results are in `structuredContent.data`. Task reads default to `summary`: identity, type/parent, marked `titlePreview`/`titleTruncated`, status, exact decimal-string version, readiness, `blockedByCount`, assignment, platform and automatic-selection fields. Summaries omit full title/description, properties, dependency arrays and execution times. A preview is neither identity nor duplicate proof; read full content when truncation or the decision requires it.

| Tool | Meaning of full |
| --- | --- |
| `task_show` | Complete title, description, properties, dependency arrays and timestamps |
| `task_ready` | Complete Task for each selected candidate, including description |
| `task_list` | Full list resource, including title, properties, relationships and times, **without description** |
| `task_graph` | Complete selected relationship scope, still compact nodes without Task description/properties/version |

Full time-bearing Task resources include creation/update times and nullable `startedAt`, `completedAt`, `cancelledAt`. Returned dependency `dependsOn` contains all prerequisites; `externalDependsOn` is its subset. [Dependencies](daynight://manuals/dependencies.md) explains the different input partition.

Mutations returning a Task use `returnView`, not read `view`, and default to summary. Inspecting a summary write result does not inspect the complete resulting definition. Separate Step/Thread/attachment reads are required even after full Task show.

Normal list/show and non-dependency-only graph add ephemeral Session observations; `task_ready`, mutation receipts and dependency-only graph do not. Task version does not freeze Session state, attachment bytes or separate observations. [Session reads](daynight://manuals/session-reads.md) owns freshness, partial results and nullable send eligibility; those observations do not grant intervention authority.

## Stored Task and Goal projections

`type: "task"` identifies ordinary work; `type: "goal"` identifies a stored Goal. Nullable `parentId` is an ordinary Task's Goal ownership link, not a dependency edge or something inferred from a title. Summary/full resources expose these fields. Full Goal resources additionally contain `progress: {total, done, cancelled, unfinished}` for its current direct children; Goal summaries and ordinary Task resources omit progress. Child changes do not increment the Goal version. These field excerpts illustrate the distinction:

```json
{"type":"task","parentId":"33333333-3333-4333-8333-333333333333"}
```

```json
{"type":"goal","parentId":null,"progress":{"total":5,"done":3,"cancelled":1,"unfinished":1}}
```

A Goal has no parent, `ready: false`, `allowAgents: false`, `requiredPlatform: null` and empty dependency/blocked sets. Do not interpret these constants as ordinary scheduling fields. Child completion accounting does not prove acceptance of the full Goal.

Normal dependency graph nodes remain `type: "task"` with nullable `parentId`; dependency-only nodes omit those fields. Goal is not a dependency-graph member or target, and a Goal cannot contain another Goal.

## Ready batches and inventories

A ready candidate is an ordinary `todo` Task whose direct prerequisites are all done/cancelled. Readiness establishes scheduling, not sufficient inputs, authorization, acceptance or ownership.

```json
{"name":"task_ready","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","limit":5,"allowAgents":true,"compatiblePlatform":"linux","view":"summary"}}
```

Ready limit defaults to 5, maximum 20. Permission/platform filters precede the limit; compatibility includes unrestricted Tasks. Results order by creation time and UUID. Data has `items` and `projection`, **no continuation**: another request returns the current first batch again. A platform filter does not prove host capability. An empty batch does not rule out proposed, blocked, in-progress, terminal or excluded work.

`task_ready` has no assignee filter. For all ready Tasks assigned to the current account, traverse `task_list` with `ready: true` and `assignedTo: "me"`; do not locally filter a capped unfiltered ready batch as a complete answer.

```json
{"name":"task_list","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","ready":true,"assignedTo":"me","limit":50,"view":"summary"}}
```

`task_list` defaults to `type: "task"`; select `type: "goal"` to list Goals. `parentId` on `task_list` and `task_ready` may be omitted for any parent, null for unowned Tasks, or a Goal UUID for its direct children. Filters apply before pagination or the ready limit. For example:

```json
{"name":"task_list","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","parentId":"33333333-3333-4333-8333-333333333333","all":true,"view":"summary"}}
```

Both queries accept `tagIds` as Project tag UUIDs, `tagMatch: "all" | "any"` (default `all`), and `untagged: true` for resources without tags. A nonempty `tagIds` set conflicts with `untagged: true`; an empty set without `untagged` adds no tag condition. Filters combine with the other selected conditions before pagination or the ready limit. Malformed UUIDs return `invalid_input`; nonexistent, deleted, or cross-Project tags return `invalid_tag_filter`. Remove the invalid selection and restart the query. Duplicate IDs do not change the selection.

List filters combine before pagination. Without `all: true` or explicit `status`, done/cancelled are excluded. `all: true` and a selected status are mutually exclusive. `assignedTo` accepts a user UUID, `me` or `unassigned`; readiness, automatic permission and platform are independent filters. List limit defaults to 50, maximum 100. Ordering groups in-progress, ready todo, blocked todo, proposed and selected terminal work, then creation time/UUID; it is not relevance ranking.

List data contains `items`, `nextCursor` and `projection`. Pass a non-null opaque `nextCursor` as `cursor`, preserving caller/Project/type/parent/filters/view (including the normalized tag selection); continue until null. The cursor binds ordering and a Project-wide typed resource revision fence, including changes outside the selected type or Parent that affect the result. Malformed/mismatched tokens fail `invalid_input`; a changed Project fence returns `list_changed`. Discard that traversal and restart without a cursor before claiming a complete inventory. There is no promised reusable cursor lifetime.

Task show, graph and material reads are new observations outside the list fence. Do not present an old list version and later-read content as one snapshot. Scope changes require a new traversal.

## Create and organize Tasks and Goals

`task_create` defaults to `type: "task"`; supply `type: "goal"` to create a Goal. Goal status defaults to `todo` and may initially be `todo`, `in_progress`, `done` or `cancelled`. Its omitted `assignedTo` selects the current account; explicit null leaves it unassigned. A Goal has no parent, dependencies or execution platform. It owns its description, properties, Thread and attachments independently of its children.

```json
{"name":"task_create","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","type":"goal","title":"Ship the project","returnView":"full"}}
```

Set an ordinary Task's `parentId` at creation or with `task_update`; it must name a visible Goal in the same Project. On update, omission preserves ownership, null removes it, and a UUID assigns or transfers it. A Parent-only update is valid and uses the child's exact decision version. Parent changes do not alter dependencies, assignment or child status. A terminal Goal still accepts organization changes, subject to the Task's own rules.

```json
{"name":"task_update","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","ifVersion":"12","parentId":null}}
```

## Ordinary Task lifecycle

New Tasks default to `proposed`, automatic execution disabled, and omitted assignee set to the current account. Explicit creation status supports proposed/todo; use todo when registering confirmed work. Registration does not start execution. `task_create` has no allowAgents input; later automatic permission requires its separate authorized update. Dependencies follow [Dependencies](daynight://manuals/dependencies.md).

Task and Goal creation and updates accept `tagIds`, a complete array of Project tag UUIDs. Omitted on creation means no tags; omitted on update preserves the current set, and `[]` clears it. Task full and summary results include `tags` as `{id,name}` references, or `[]`. Read the current Task and version before deciding how to reconcile an unknown write outcome; do not blindly repeat it.

| Ordinary Task status | Meaning |
| --- | --- |
| `proposed` | Unconfirmed suggestion; unfinished, never ready, excluded from automatic acquisition and prerequisite satisfaction |
| `todo` | Confirmed work not started in its current interval; ready or blocked |
| `in_progress` | Recorded execution interval, not a lock, lease or process handle |
| `done` | Successful delivery recorded; actual outputs and acceptance must support it |
| `cancelled` | Irreversible terminal state requiring no further execution; not delivery |

No fixed proposed/todo/in-progress/done approval order is imposed. `task_update` changes metadata; `task_set_status` changes status. Every direct prerequisite must be done/cancelled before entering in_progress or done. Cancellation has no satisfied-prerequisite gate and preserves edges; a terminal predecessor can affect a dependent's ready fact without incrementing its version or providing its promised output.

A done ordinary Task cannot reopen while a direct successor is in_progress/done; cancelled successors do not impose that restriction. Done can become cancelled without withdrawing scheduling satisfaction. Cancelled ordinary Tasks cannot return to another status.

| Transition | Times |
| --- | --- |
| Enter in_progress | New startedAt, clear completedAt |
| Return to proposed/todo | Clear startedAt/completedAt |
| in_progress → done | Preserve nullable startedAt, record completedAt |
| proposed/todo → done | Record completedAt without start; elapsed execution time unknown |
| Enter cancelled | Record cancelledAt, preserve historical start/completion |

Use completedAt for current done completion and cancelledAt for current cancellation. Historical completion retained on cancellation does not prove delivery of cancelled requirements. A real status change increments version once; current-version same-status changes nothing, while stale same-status still conflicts. Metadata writes do not restart timing.

```json
{"name":"task_set_status","arguments":{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","status":"in_progress","ifVersion":"12","returnView":"full"}}
```

This ordinary operation omits claimId; it does not launch a process or acquire a claim. An explicit original Worker assignment follows [Worker operations](daynight://manuals/worker-operations.md). Ordinary execution directed by the user is not restricted by automatic selection filters, but still requires actual capabilities, sufficient inputs, dependencies and authorization.

`assignedTo` is a nullable local user UUID; `requiredPlatform` is unrestricted null or the advertised platform. A real assignee change disables allowAgents; same-assignee preserves it. Actual assignment/platform/permission changes are refused during in_progress; current-version same-values remain no-ops. Assignment grants neither Project access nor control of another claim.

## Goal lifecycle

A Goal moves freely among `todo`, `in_progress`, `done` and `cancelled`, including reopening. `task_set_status` submits the desired status and exact version in one call; MCP does not require a separate confirmation token. A child actually entering `in_progress`, through a manual status change or Worker claim, also starts its `todo` Parent Goal in the same transaction. Other Goal states remain unchanged; same-status requests and membership edits do not trigger this transition, and child completion, cancellation, rollback or claim release does not end or revert the Goal. Child progress does not derive Goal status. Starting a new `in_progress` interval records a new start; returning to `todo` clears its interval times. `done` and `cancelled` record their respective time and retain a nullable start. A same-status request is a no-op at the current version.

A Goal in `done` or `cancelled` prevents new automatic claims of its children. Existing claims continue, and manual Task changes remain governed by the child's own rules. Goal assignment is independent of child assignment. Goal execution controls, Steps and Worker claims are not supported.

## Cancellation and deletion

Cancellation retains readable Task material, history and dependencies under current access checks. It neither closes PRs/branches, marks deletion nor accepts work. An active Worker must be released by its authorized management owner before ordinary cancellation; Task status is not process control.

`task_delete` hides stored resources from ordinary reads/list/ready/graph while retaining stored records and attachment bytes. Ordinary Task deletion is refused for an active Worker claim and, by default, when undeleted dependents exist. Explicitly authorized `removeDepends: true` removes incoming ordinary/external references in the same transaction, changing dependent versions and possibly readiness. Authority to delete one Task does not automatically cover this additional effect.

Deleting a Goal hides it and its children without removing their parent links or changing their states, versions or dependencies; `removeDepends: true` is rejected for Goal deletion. Active executions stop later through existing cleanup. Deletion is separate from completion/cancellation and synchronous process termination. A `task_deleted` response is distinct from not_found or inaccessible; authentication, permission and transport failures leave absence/deletion unconfirmed. Preserve original completion facts under [Write safety](daynight://manuals/write-safety.md).

## Properties

```json
{"name":"task_properties","arguments":{"mode":"schema"}}
```

Schema mode accepts no Project/Task input. Values mode requires both and returns complete properties with exact Task version:

```json
{"name":"task_properties","arguments":{"mode":"values","projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222"}}
```

Absence (`{}`), a present empty value (`{"pullRequests":[]}`), and permitted JSON null are different. Definitions govern valid names, values, nullability and public writability; errors cannot become an empty catalog/value object.

`task_set_property` replaces one whole value from `valueText`; `task_remove_property` removes the key. Names are complete case-sensitive literals: dots do not select nested paths. Retain the complete ordered pullRequests array when replacing it. Metadata creation/update has no property-specific PR field. Use the resulting version for any later decision, reassessing conflicts/unknown outcomes under write safety.
