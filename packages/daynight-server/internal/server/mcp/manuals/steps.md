# Task Steps

Read this to query or maintain ordered Steps. Every mutation also requires
[Write safety](daynight://manuals/write-safety.md). Project rules determine how
Steps are used; [Materials](daynight://manuals/materials.md) explains where formal
requirements and results belong.

## Identity, order and lifecycle

A Step belongs to one Task resource. Its ID has eight hexadecimal characters:
input accepts either case, output is lowercase, and leading zeros matter.
`0000000a` is a complete ID, not display position 10. IDs may repeat in different
Tasks; retain the Project, Task and Step together.

Steps have their own title, description, order and status. Statuses are `todo`,
`in_progress`, `done` and `skipped`; any transition is allowed, including a
same-state request and several in-progress Steps. Step `done` records that its
work ended, not that review passed. Steps do not drive Task readiness, automatic
acquisition or completion, and Task status does not automatically change Steps.
Deleting a Step has no public restore or edit history. Keep formal outputs in
their proper material owner.

Reads and writes require current access to the live parent resource. Deleted
Task or Goal material is unavailable; a parent or permission failure is not an
empty collection or evidence that one Step was removed.

## Read the content needed for the decision

`task_step_list` and `task_step_show` default to `view: "summary"`. Summaries
contain ID, status, position, `titlePreview` and `titleTruncated`; they omit the
description and may shorten the title. `view: "full"` returns the complete title
and description, plus timestamps. Request full content before decisions that
depend on it.

The examples are separate `tools/call` params, with fictional IDs and an observed
version. Use actual results for your operation. Business data is in
`structuredContent.data`.

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

List data contains `projectId`, `taskId`, exact decimal-string parent `version`,
`projection`, ordered `items` and nullable `nextCursor`. Continue with the cursor
unchanged under the same account, Project, Task and view. The cursor binds the
parent version and position: malformed or wrong-scope cursors are rejected, and
a changed parent produces `version_conflict`. Restart the collection and
reassess; never combine old and new pages. Empty `items` without continuation is
a valid empty collection. Failed reads cannot be substituted for it.

`task_step_show` selects a complete `stepId` within the same scope and returns
parent IDs/version, `projection` and `step`. Set `view: "full"` to obtain the
selected Step's complete content. Use tool schemas for the exact page limits and
arguments; list defaults to 50 and accepts 1–100.

## Mutate at the observed parent version

Steps share the parent Task version with versioned metadata, status and property
writes. Read the current collection and Task definition needed by the decision,
then supply that exact `ifVersion`. One real collection change increments the
parent version once; a no-op preserves version and timestamps, but still rejects
a stale version. A Task write can invalidate a Step decision and conversely.
Omitting `ifVersion` causes a pre-submission parent-version read; it cannot
protect a decision made from an earlier observation.

| Tool | Operation-specific conditions |
| --- | --- |
| `task_step_add` | Optional explicit `id`; omission lets the service choose. Omitted status is `todo`. Use at most one `before` or `after` anchor; omission appends. |
| `task_step_update` | Supply title or description, or both; omission preserves a field and an empty description clears it. |
| `task_step_set_status` | Set the selected Step's status independently of Task lifecycle. |
| `task_step_move` | Supply exactly one `before`, `after`, or `position: "first"|"last"`; anchor IDs belong to the same Task. |
| `task_step_delete` | Delete the selected Step and obtain the resulting collection facts. |

```json
{
  "name": "task_step_add",
  "arguments": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "taskId": "22222222-2222-4222-8222-222222222222",
    "id": "c0ffee01",
    "title": "Verify the attachment references",
    "description": "Record the observed reference check and link the formal result.",
    "status": "todo",
    "ifVersion": "12",
    "returnView": "full"
  }
}
```

Mutation data includes the resulting version and change facts. `returnView`
defaults to summary, which can identify the changed Step and collection count
without returning the complete collection. Full returns the resulting ordered
`steps`. Read full content when the next decision requires it; a summary receipt
does not establish that the collection has been consumed.

## Investigate an uncertain mutation

Retain the original scope, explicit or returned Step ID, request correlation,
`refs` and reported completion facts. A Step ID is an object identity, not a
submission or replay key: MCP Step tools have no client request-UUID parameter.
An unknown add must not automatically be repeated with the same or a new ID.
Presence, absence or equal title describes current state; none identifies which
historical add occurred. Read the original collection or selected ID for current
facts, preserving parent and permission failures. A selected Step absence can carry the
admitted parent version in error `refs`; it still reports current absence only. Interpret `confirmed`,
`not_committed` and `unknown` results through Write safety before a new decision.
