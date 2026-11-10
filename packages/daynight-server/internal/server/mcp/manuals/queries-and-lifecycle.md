# Queries and lifecycle

Use task queries to establish the current facts before deciding what to do. Choose the read by its scope: a candidate batch, a project inventory, one complete task, or a dependency graph answer different questions.

Examples below show the `params` object for an MCP `tools/call` request. The UUIDs, Step IDs, message IDs and versions are fictional. Replace them with identifiers and exact versions obtained from successful reads of the intended service. The client supplies the JSON-RPC envelope and protocol metadata. Use the connected server's `tools/list` definitions for the complete current schemas.

## Establish Project scope first

Task queries require the intended `projectId`. A normal MCP connection has no implicit current Project. Use a verified Project/Task link or explicit ID, retain the Project from a valid Worker assignment, or resolve a host-provided repository address with `project_resolve`. The resolver returns the ordinary Project in `structuredContent.data`; its `id` is the input for later Task tools.

If no target context is available, use `project_list` and have the user explicitly select the Project. A resolver `not_found`, `resource_conflict` or input/query failure does not authorize registration or choosing an arbitrary result. Read [Product concepts](daynight://manuals/concepts.md) for the complete selection paths and address-matching boundaries.

## Choose the read

| Tool | Question it answers | Important boundary |
| --- | --- | --- |
| `task_ready` | Which matching tasks are ready candidates now? | One current first batch, default 5 and maximum 20; no continuation. |
| `task_list` | Which tasks match these filters in this Project? | A paginated inventory; terminal tasks are excluded unless explicitly requested. |
| `task_show` | What does this selected task currently contain? | Summary is the default. Request `view: "full"` for the complete task body. |
| `task_graph` | What ordinary task chain and direct external prerequisite context surround this task? | Complete selected graph, with compact nodes; it does not supply task descriptions or exact task versions. |
| `task_properties` | What property definitions exist, or what complete property values does this task have? | Schema mode is service-wide; values mode is scoped to a Project and Task. |
| `task_step_list`, `task_step_show` | What ordered Steps or selected Step belong to this Task? | An independent collection sharing the parent Task version; summary is the default. |
| `task_thread_read` | What complete discussion messages are before or after this message, or in the latest page? | Independent message pagination; no task projection or task version fence. |
| `task_session_current`, `task_session_list` | Which Session belongs to the current execution, or which Sessions belong to this Task's history? | Current association never falls back to an older Session; the directory has independent pagination. |
| `task_session_show` | What identity, observed state and readable source belong to this exact Session? | Preserve the selected Session ID when the Task starts a new execution. |
| `task_session_read`, `task_session_entry` | What messages or complete large entry belong to this exact Session? | Message pages and UTF-8 entry chunks have independent opaque cursors. |

Task descriptions, Steps, Thread messages and attachment bytes are separate resources. A successful Task read does not prove that these other materials have been read. See [Materials](daynight://manuals/materials.md) and [Files and references](daynight://manuals/files-and-references.md).

There is no `task_search` MCP tool. For inventory-based discovery or duplicate checks, use the available `task_list` filters, traverse all matching pages, and read relevant task details. Do not invent a search argument or transfer CLI search syntax into MCP calls.

## Locate and read a Task Session

Use the Session ID from an observation or `task_session_current`. The latter requires `projectId` and `taskId`, and returns `status`, nullable `claimId`, `agentControlMode` and `session`. `registered` supplies the exact inspection; `not_registered` means the current execution has no registered Session, and `not_applicable` means there is no execution association. Neither empty result selects historical content.

`task_session_list` takes the same scope, optional `limit` (default 20, range 1–200) and optional `cursor`. Its `items` run newest to oldest; pass the returned `nextCursor` unchanged until it is null. Each row identifies the original claim and execution generation, control mode, content kind, current binding and archive status. Reading a historical Session does not replace it with a newer claim's Session.

For `task_session_show`, supply `projectId`, `taskId` and the selected `sessionId`. Its inspection separates the exact Session identity and current fence from `currentBinding`, observed state and `source` (`live`, `archive` or `unavailable`). An unavailable observation remains explicitly unavailable; it does not prove that the Session is idle. `contentReadVersion` reports whether the live Controller supports original-content reads. Herdr Sessions identify `terminal_recording`; their recordings are not chat messages.

Read the latest page with:

```json
{
  "name": "task_session_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "sessionId": "33333333-3333-4333-8333-333333333333",
    "limit": 20
  }
}
```

The page returns `sessionId`, `historyEpoch`, `source`, `items`, `beforeCursor`, `hasMoreBefore`, `coverage` and `observedAt`. Items within the page run oldest to newest. To read earlier history, pass `beforeCursor` as `before` with the same Project, Task and Session. Continue according to `hasMoreBefore`; an empty filtered page can still have an earlier continuation. The optional `conversation: true` keeps user and assistant messages from the selected page only. It does not scan extra history to fill the page or alter its cursor boundary.

The default page has at most 20 entries and accepts `limit` from 1 to 200. Its complete HTTP response is bounded to 256 KiB, including errors, the MCP envelope and request identity. Send each history read in a separate request; a one-element legacy batch is supported, while a multi-call batch containing a history read is rejected before any tool runs. An oversized request identity or encoded response receives a bounded HTTP `resource_limit_exceeded` error. A large entry can therefore have `body: null`, `truncated: true` and a `contentRef`, even when fewer than the requested entries fit. The cursor still advances past that entry. Resource descriptors are bounded and may set `resourcesTruncated`; they contain no resource bytes. `timestamp: null` means the entry has no common timestamp, not that the service inferred a time.

To retrieve an entry's canonical JSON, pass its `contentRef.cursor` to `task_session_entry` with the same `projectId`, `taskId` and `sessionId`. The result includes `entryId`, `revision`, `sha256`, `byteLength`, `offset`, `fragment`, `nextCursor` and `eof`, plus its source, epoch and observation time. `fragment` contains at most 32 KiB of UTF-8 and never splits a code point. Append fragments in byte-offset order; continue with each returned `nextCursor` until `eof` is true. Preserve decimal byte lengths and offsets as strings. Verify the assembled UTF-8 byte length and SHA-256 before parsing its canonical JSON. A returned chunk is a content fragment, not necessarily independently parseable JSON.

Every page and chunk rechecks access and the exact Session. Cursors bind their source and revision: `reset_required` requires restarting from the newest page, including when live content becomes an archive; `content_changed` requires obtaining a fresh entry reference before assembling again. Do not combine bytes from different revisions, hashes or epochs. `history_pending`, `history_unavailable` and `source_corrupt` distinguish unfinished archival, unavailable content and corrupt content. An older Controller can supply compatible short entries, but `upgrade_required` means its display-budget placeholder cannot supply the original entry. `unsupported_mode` identifies Herdr content that is not available through chat-history tools.

Archive reads return the same bounded pages and chunks without making the client download the full archive. `coverage` and the observation's `partial` flag preserve incomplete content; a successful read does not prove that missing archive resources exist. These read tools never create a write receipt or authorize sending input to the Session.

## Summaries and full content

Task summaries carry `projection: "summary"`, IDs, a `titlePreview` and its `titleTruncated` flag, status, exact decimal-string version, readiness, `blockedByCount`, assignment, platform and automatic-selection fields. They do not contain the full description, complete title, properties, dependency arrays or execution timestamps.

A title preview is not a resource identity or evidence that two tasks are duplicates. Use the complete Task UUID. When `titleTruncated` is true, read the full task before judging its title or purpose.

The meaning of `full` depends on the tool:

| Read | `summary` | `full` |
| --- | --- | --- |
| `task_show` | Task selection fields and marked title preview | Complete Task, including title, description, properties, dependency arrays and timestamps |
| `task_ready` | Summary for each returned candidate | Complete Task for each returned candidate, including description and properties |
| `task_list` | Summary for each returned item | Full list resource, including full title, properties, dependencies and timestamps, **without description** |
| `task_step_list`, `task_step_show` | Step ID, status, position and marked title preview | Complete Step title, description, status, position and timestamps |
| `task_graph` | Complete selected graph with compact relationship nodes | The same complete relationship scope; nodes still have title previews and no task description, properties or version |

For example, read the complete selected task with:

```json
{
  "name": "task_show",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "view": "full"
  }
}
```

Business results are in `structuredContent.data`, not in the tool's short `Completed.` text. A full Task has `projection: "full"`, `id`, `projectId`, `title`, `description`, `properties`, `status`, `version`, `createdAt`, `updatedAt`, nullable `startedAt`, `completedAt` and `cancelledAt`, dependency arrays, nullable `requiredPlatform` and `assignedTo`, `allowAgents` and `ready`.

Version values such as `"12"` are strings containing exact positive decimal integers. Preserve their digits when making a version-bound decision. See [Write safety](daynight://manuals/write-safety.md).

Task mutations that return a Task use `returnView`, rather than the read argument `view`. Their default response is also a summary. A successful write returning a summary does not mean the complete resulting description has been inspected.

## Ready candidates

A ready candidate is a `todo` Task whose direct prerequisites are all `done` or `cancelled`. Readiness is about dependency scheduling. It does not confirm that all required materials exist, that acceptance has passed, or that a user has authorized execution.

```json
{
  "name": "task_ready",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "limit": 5,
    "allowAgents": true,
    "compatiblePlatform": "linux",
    "view": "summary"
  }
}
```

`limit` accepts 1–20 and defaults to 5. Permission and platform filters apply before the limit. Compatible tasks include unrestricted tasks and those requiring the specified platform. Querying for `linux` does not prove the actual host runs Linux.

Results are ordered by creation time and UUID. `structuredContent.data` contains `items` and `projection`; it has no `nextCursor` or `next` field. Repeating the request asks for the current first batch again. It cannot enumerate later candidates, and a repeated call may observe changes.

`task_ready` has no assignee filter. To find all ready tasks assigned to the connected account, use `task_list` with `ready: true` and `assignedTo: "me"`, then traverse its pages. Do not fetch a capped unfiltered ready batch and filter it locally as though the result were complete.

An empty ready result does not mean the Project has no tasks. In-progress work, blocked todo work, terminal history or tasks excluded by the supplied filters may still exist.

## Project inventories and filters

`task_list` requires `projectId`. Its page `limit` defaults to 50 and accepts 1–100. The following filters combine on the server before pagination:

| Input | Meaning |
| --- | --- |
| `status` | Select one of `todo`, `in_progress`, `done` or `cancelled`. |
| `all: true` | Include both terminal statuses as well as unfinished work. Cannot be combined with `status`. |
| `assignedTo` | A local user UUID, `"me"` for the current authenticated account, or `"unassigned"`. |
| `ready` | Filter by the computed readiness boolean. |
| `allowAgents` | Filter by automatic-selection permission. |
| `compatiblePlatform` | Include unrestricted Tasks and those matching `windows`, `linux` or `macos`. |
| `view` | `"summary"` by default, or `"full"` list resources without descriptions. |

With neither `all: true` nor an explicit status, both `done` and `cancelled` are excluded. Include terminal history when the question requires it; a default unfinished list cannot rule out previously completed or cancelled work.

Results group in-progress Tasks first, then ready todo, blocked todo, and terminal Tasks when selected. Within each group, creation time and UUID determine order. This is scheduling-oriented ordering, not relevance ranking.

For all ready work assigned to the current account:

```json
{
  "name": "task_list",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "ready": true,
    "assignedTo": "me",
    "limit": 50,
    "view": "summary"
  }
}
```

To inspect history, make a separate query such as `all: true` or `status: "cancelled"`. Do not add `all: true` to a request that already selects a status.

### Continue a list correctly

A successful list result has this data shape:

```json
{
  "items": [],
  "nextCursor": null,
  "projection": "summary"
}
```

This example represents an empty result. A nonempty `items` array contains the selected projection. If `nextCursor` is a string, pass that returned opaque string as `cursor` in the next call, preserving the Project, authenticated account, filters and view. Continue until `nextCursor` is `null`.

The cursor binds the caller, Project, filters, ordering and view to a Project task-version fence. Treat it as an opaque continuation token; do not decode, edit, manufacture or transfer it to another query or account. A malformed or mismatched cursor is an `invalid_input` failure. A Project task change detected against the fence returns `list_changed`; discard that partial traversal and restart without the cursor before claiming a complete inventory.

There is no promised reusable cursor lifetime. A previously valid cursor can become unusable when its bound state or scope changes. Keep complete traversal distinct from a collection of unrelated pages. If the required scope changes, begin a new traversal.

A subsequent `task_show`, Step read, Thread read or attachment read is a new observation. These calls do not share the list's snapshot fence. Read the actual current task and materials before a decision; do not combine a list's old version with content obtained later and present them as one snapshot.

## Dependency graph reads

```json
{
  "name": "task_graph",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "dependsOnly": true
  }
}
```

The graph contains the entire bidirectionally connected component of ordinary dependencies around the selected Task, plus one layer of direct external prerequisites of those members. It includes all statuses. It does not recursively expand those external context Tasks or include tasks merely because they depend externally on a member.

`structuredContent.data` contains `project`, `observedAt`, `summary`, `projection`, `tasks`, `returnedNodes` and `totalNodes`. The dependency-only `tasks` nodes contain `id`, the full direct `dependsOn` set, and its `externalDependsOn` subset. They are still inside the graph result object; the MCP result is not a bare node array.

Normal graph nodes also include title previews, status, dependency and blocking arrays, assignment, platform, permission, readiness and timestamps. Neither graph projection returns the Task's exact version or full description. Read `task_show` separately when those facts are needed.

Dependency references may point beyond the returned graph. Inspect relevant outside tasks or graphs when checking paths; absence from this selected graph is not proof that a dependency does not exist. See [Dependencies](daynight://manuals/dependencies.md) for read/write classifications, reduction and post-change checks.

## Task state and time

Task statuses are:

| Status | Meaning |
| --- | --- |
| `todo` | Work has not started in the current execution interval. It may be ready or blocked. |
| `in_progress` | Work is recorded as in progress. This state is not an executor lock, lease or process handle. |
| `done` | The work is recorded as successfully delivered. Actual results and applicable acceptance must support that conclusion. |
| `cancelled` | No further execution is required. Cancellation is irreversible and does not establish that the requirements were delivered. |

New Tasks start `todo` with `allowAgents: false`. Registration does not start execution. `task_update` changes metadata; `task_set_status` changes status.

Before entering `in_progress` or `done`, every direct prerequisite must be `done` or `cancelled`. Cancellation itself does not require satisfied prerequisites. Cancelling a predecessor preserves dependency edges and can make a successor ready when all its other conditions are met; it does not supply missing deliverables or stage confirmations.

A done Task cannot be reopened while a direct successor is `in_progress` or `done`; cancelled successors do not add this restriction. Done can become cancelled without withdrawing dependency satisfaction. A cancelled Task cannot return to another status.

| Actual transition | Timestamp effect |
| --- | --- |
| Enter `in_progress` | Start a new execution interval; clear `completedAt`. |
| Return to `todo` | Clear `startedAt` and `completedAt`. |
| `in_progress` to `done` | Preserve nullable `startedAt`; record `completedAt`. |
| `todo` to `done` | Record `completedAt` without a start time; elapsed execution time is unknown. |
| Enter `cancelled` | Record `cancelledAt`; preserve the prior execution start/completion times. |

In time-bearing Task resources, `cancelledAt` is required and nullable. The current terminal timestamp is `completedAt` for done work and `cancelledAt` for cancelled work. Do not interpret a preserved historical completion time as delivery of the cancelled requirement.

A real status change increments the Task version once. A same-status request with the current version changes no fields; a stale version still conflicts. Metadata updates do not restart execution timing. Ordinary status writes do not release or stop a worker, transfer process ownership or renew a lease. An active worker claim must be released through an authorized management operation before cancellation; changing status is not a substitute.

For an already authorized ordinary state change based on version `"12"`:

```json
{
  "name": "task_set_status",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "status": "in_progress",
    "ifVersion": "12",
    "returnView": "full"
  }
}
```

This example omits `claimId` because it is an ordinary operation. An owned active Worker assignment has a separate explicit original-claim completion contract; do not infer a claim from Task properties or fall back between ordinary and claim-bound completion after rejection. See [Operation boundaries](daynight://manuals/operation-boundaries.md).

### Cancellation and deletion

Cancellation preserves the readable Task, properties, Steps, Thread, execution history, attachments and dependency edges under current access checks. It does not close PRs or branches, set a deletion marker, or constitute acceptance.

`task_delete` soft-deletes the Task. It disappears from ordinary lists, ready results, graph membership and normal detail access while stored records and attachment bytes are retained. Deletion is independent of status and is not successful completion.

Deletion is strict by default: an undeleted task depending on the target prevents deletion. The explicitly authorized `removeDepends` option can remove incoming ordinary and external dependency references in the same deletion transaction. That can change other tasks' versions and readiness. It is not a display-only cleanup. Deletion is also refused while the target has an active worker claim.

A read returning `task_deleted` is different from an inaccessible or missing object. Permission, authentication and transport failures leave absence or deletion unconfirmed. Follow [Write safety](daynight://manuals/write-safety.md) when a deletion response is lost.

## Properties and metadata

Task properties are a server-defined catalog. To discover definitions:

```json
{
  "name": "task_properties",
  "arguments": {
    "mode": "schema"
  }
}
```

Schema mode accepts no Project or Task input. Values mode requires both:

```json
{
  "name": "task_properties",
  "arguments": {
    "mode": "values",
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222"
  }
}
```

The values result contains `projectId`, `taskId`, the exact Task `version`, and the complete `properties` object. Full Task reads also contain properties; summaries do not.

These are different property states:

```json
{}
```

The key is absent.

```json
{"pullRequests": []}
```

The key is explicitly present with an empty array. A present JSON `null` is a third state where the property's definition allows it; it cannot be substituted for absence or an empty array. The server validates property names and values, including nullability and public writability. Unknown or invalid values are errors, not an empty property object.

`task_set_property` replaces one whole value from `valueText`; `task_remove_property` removes its key. Property names are complete case-sensitive literals: a dot does not select a nested path. Setting `pullRequests` requires its complete ordered array, retaining entries that still belong there. Metadata creation/update does not accept a property-specific PR field. Use the returned Task version for any subsequent decision and [Write safety](daynight://manuals/write-safety.md) for conflict or unknown-outcome handling.

Other metadata has separate semantics. `assignedTo` is a nullable local account UUID; `requiredPlatform` is null, `windows`, `linux` or `macos`; `allowAgents` controls automatic selection. An actual assignee change resets `allowAgents` to false. Actual assignment, platform and permission changes are prohibited while `in_progress`; same-value requests preserve fields but still check the exact version. Human assignment grants neither Project access nor control of an existing worker claim.

## Read Steps independently

Steps belong to one Task and have their own order, title, description and status. Use the complete eight-hex-digit `stepId` within that Task. Input accepts either case; output is lowercase, and leading zeros remain significant. A Step display position is not its ID, and different Tasks may use the same Step ID.

```json
{
  "name": "task_step_list",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "view": "full",
    "limit": 50
  }
}
```

The result data contains `projectId`, `taskId`, exact parent Task `version`, `projection`, ordered `items` and nullable `nextCursor`. An empty `items` array with no continuation is a valid empty collection. A failed read cannot be treated as an empty collection.

Step list pages default to 50 records and accept 1–100. Continue with the returned cursor while preserving account, Project, Task and view. The cursor carries the parent version and position. A malformed or wrong-scope token is rejected; if the parent version has changed, continuation fails with `version_conflict`. Restart the Step collection from the beginning and reassess the new parent version rather than combining old and new pages.

To read one selected Step in full:

```json
{
  "name": "task_step_show",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "stepId": "0000000a",
    "view": "full"
  }
}
```

The data contains parent IDs and version, `projection: "full"`, and `step`. Step statuses are `todo`, `in_progress`, `done` and `skipped`. Any transition, including a same-state operation and multiple simultaneous in-progress Steps, is allowed by the system. Order, status and business review result are independent. `done` records that Step work ended; it does not mean review passed or the Task is done.

Steps do not change Task readiness, automatic acquisition or Task completion. Task status does not automatically change Step statuses. Project rules determine how Steps are divided and maintained. Step writes share the parent Task version with versioned Task metadata, properties and status changes; read the actual current parent version before deciding. A Task status is not a replacement for reading this collection.

## Read Thread messages independently

`task_thread_read` returns one bounded page of complete immutable discussion messages, ordered oldest to newest within the page. Without a boundary, it selects the latest page, not the beginning of the thread.

```json
{
  "name": "task_thread_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "count": 20,
    "details": true
  }
}
```

`count` defaults to 20 and accepts 1–100. A bounded page may contain fewer messages than requested without truncating message bodies. The data shape is:

```json
{
  "items": [],
  "hasMoreBefore": false,
  "hasMoreAfter": false
}
```

Each nonempty message has `id`, `author`, `body` and `createdAt`, plus `replyTo` when present. `author` has `userId`, nullable `displayName`, and the case-sensitive boolean field `Agent`. With `details: true`, verified Agent authors can include `execution` containing `claimId`, `workerId` and `provider`. Empty display names do not remove the account UUID or establish an anonymous author.

Use exactly one boundary at a time:

- To read older history, pass `beforeId` equal to the earliest message ID actually returned on the current page; check `hasMoreBefore`.
- To continue forward, pass `afterId` equal to the latest message fully consumed; check `hasMoreAfter` and retain that consumed position.
- An empty forward read does not advance the position. Keep the prior `afterId`.

For example, a forward read after a message already consumed is:

```json
{
  "name": "task_thread_read",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "afterId": "33333333-3333-4333-8333-333333333333",
    "count": 20
  }
}
```

A boundary must identify a message in that same Task; `message_not_found` cannot be treated as an empty page. `beforeId` and `afterId` are message UUIDs, not task-list or Step-list cursors.

Posting does not change Task status, version, timestamps, properties or dependencies, and does not trigger an Agent. A post receipt also does not advance the continuously read position. If the last consumed message was A, an unseen participant message B followed by a local post C must still be read from `afterId: A`; jumping to C would skip B. Keep accepted requirements and results in their [formal material owners](daynight://manuals/materials.md), and handle uncertain post outcomes through [Write safety](daynight://manuals/write-safety.md).

## Read an original Session operation

`task_session_operation` reads an explicitly identified Task Session operation,
including a historical Session after the Task has acquired a new claim:

```json
{
  "name": "task_session_operation",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "sessionId": "33333333-3333-4333-8333-333333333333",
    "operationId": "44444444-4444-4444-8444-444444444444"
  }
}
```

Successful `structuredContent.data` contains the original `operation` and
`currentBinding`. The latter reports whether the original Session is still the
current Task execution; it never substitutes a new Session. Reading checks the
current credential and Project access, does not restore a command queue, and
does not produce a write-commit result. Resource refs preserve all four IDs.

The `not_found` error means no receipt was available for that query. The original
send outcome remains unknown; absence does not prove that the request was never
sent. Keep its IDs and query them again when appropriate, without replacing the
operation ID or submitting again. Authentication and membership failures are not
absence. Follow [Session send safety](daynight://manuals/write-safety.md).

## Recognize incomplete observations

A successful empty collection, an exhausted cursor, a missing resource and an unsuccessful request mean different things. Preserve the actual error and request context. Do not convert an access failure, `list_changed`, `version_conflict`, invalid cursor, transport loss or resource contention into an empty result.

Before a decision, establish the selected task identity, read the complete content genuinely needed, and keep the exact version associated with that observation. Read dependencies and shared materials when relevant to the decision. Discovering ready work, viewing a discussion or seeing a task in progress does not authorize implementation, publishing, merging or automatic successor selection; those boundaries are explained in [Operation boundaries](daynight://manuals/operation-boundaries.md).
