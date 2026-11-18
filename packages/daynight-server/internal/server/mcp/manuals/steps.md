# Task Steps

Read [Overview](daynight://manuals/overview.md) first. Use this topic for ordered Step reads and writes; mutations also require [Write safety](daynight://manuals/write-safety.md). Project rules determine Step use, while [Materials](daynight://manuals/materials.md) owns formal requirements and results.

## Identity and lifecycle

A Step belongs to one ordinary Task; Goals have no Steps. Its complete ID has eight hexadecimal characters: input accepts either case, output is lowercase, and leading zeros matter. `0000000a` is an ID, not display position 10. IDs may repeat across Tasks; retain Project, Task and Step together.

Steps have independent title, description, order and status. Any transition among `todo`, `in_progress`, `done` and `skipped` is allowed, including same-state requests and multiple in-progress Steps. Done records that Step work ended, not review acceptance. Steps affect neither Task readiness, automatic acquisition nor completion; Task status does not automatically update Steps. Deletion has no public restore or edit history.

Reads and writes require current access to a live parent. Parent deletion or permission failure is not an empty collection or evidence that one Step was removed.

## Read complete content and consistent pages

| View | Content |
| --- | --- |
| `summary` (default) | ID, status, position, `titlePreview`, `titleTruncated`; no description, potentially shortened title |
| `full` | Complete title/description and timestamps |

Request full content when the decision needs it. `task_step_list` defaults to 50 entries, range 1–100. Its result has `projectId`, `taskId`, exact decimal-string parent `version`, `projection`, ordered `items` and nullable `nextCursor`.

Continue an unchanged cursor under the same account, Project, Task and view until null. It binds parent version and position: malformed/wrong-scope cursors are rejected; parent changes return `version_conflict`. Restart and reassess without mixing old and new pages. Empty `items` without continuation is a valid empty collection; failed reads are not.

`task_step_show` selects the complete `stepId` in the same scope and returns parent IDs/version, `projection` and `step` in the requested view.

## Mutate at the parent version

Steps share Task version with versioned metadata, status and property writes. Read the current collection and required Task definition, then supply that exact `ifVersion`. A real collection change increments it once; a no-op preserves version/timestamps but rejects a stale version. Either Task or Step writes can invalidate the other's decision. Omitting `ifVersion` reads the parent before submission and cannot protect an earlier decision.

| Tool | Conditions |
| --- | --- |
| `task_step_add` | Optional `id`; omission lets the service choose. Status defaults to `todo`. At most one `before`/`after` anchor; omission appends. |
| `task_step_update` | Supply title, description or both; omission preserves, empty description clears. |
| `task_step_set_status` | Changes Step status independently of Task lifecycle. |
| `task_step_move` | Exactly one of `before`, `after`, `position: "first"` or `position: "last"`; anchors belong to the same Task. |
| `task_step_delete` | Removes the Step and returns resulting collection facts. |

Mutation results include resulting version and change facts. Default summary `returnView` can identify the changed Step and collection count without returning the full collection. Full returns ordered `steps`; a summary receipt does not establish that the collection was consumed.

## Recover uncertain mutations

Retain original scope, explicit/returned Step ID, request correlation, `refs` and completion facts. Step ID is object identity, not a replay key; Step tools have no client request UUID. Do not automatically repeat an unknown add with the same or a new ID.

Read the original collection or selected ID. Presence, absence and equal title establish current state, not the historical add. Preserve parent/access failures. Selected-Step absence may carry the admitted parent version in error `refs`; that still establishes current absence only. Interpret completion through [Write safety](daynight://manuals/write-safety.md) before another decision.
