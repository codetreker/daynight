# Steps

Steps are ordered Task-owned records with a title, Markdown description,
todo/in_progress/done/skipped status and creation/update times. Projects define
their names, granularity and use. Steps persist across Sessions; transient plans,
commands, logs and operational authorization remain Session content.

Step status, order and review outcome are independent. Any of the four states
can follow any other, including itself, and multiple Steps can be in progress.
Done does not establish a passed review or Task completion. Steps do not affect
readiness, claims or execution authority, and Task status does not update Steps.

For writes, follow [write safety](write-safety.md).
`task step list <task-id> --json` supplies the collection's parent Task version,
shared with Task metadata, properties and status. When
[`--if-version`](write-safety.md#decisions-and-versions) is omitted, the CLI reads
the complete Steps before writing. Actual changes increment the parent version
once; no-ops preserve version and times. The 1 MiB request limit includes JSON
escaping.

Each write retains its original Project, Task, Step ID and request UUID. An
unknown outcome exits 1 with no success resource. The CLI may read current facts
once while that same operation is live; found/absent does not attribute historical
success or rollback. Cancellation or exhausted budgets do not start a detached
read. If no current observation is available, use ordinary list/show with the
original ID and explicit Project. A current same-ID record need not be the
original one. Preserve the identity and apply [uncertain results](write-safety.md#uncertain-results).

## Read Steps

```bash
daynight task step list <task-id> --json --project <project-id>
daynight task step show <task-id> <step-id> --json --project <project-id>
```

Task list/show/graph do not contain the full Step collection. List preserves
saved order and prints parent version, total count, display position, full short
ID, status and complete title. Show prints every target field, including full
description and times. Identify a Step by its Task and complete eight-hex ID;
input ignores case, output is lowercase, and leading zeros matter. A display
position or UUID cannot replace it. Different Tasks can have the same Step ID.

JSON list is the complete projectId/taskId/version/steps resource; show is
projectId/taskId/version/step. Neither is a bare array. JSON preserves raw strings
and exact int64 numbers; readable text visibly escapes terminal and bidi controls.
An empty collection is valid. Invalid scope, fields, IDs, text, statuses or UTC
microsecond times are errors, never an empty result. Complete results are
validated before output; successful JSON is one value followed by LF.

Explicit `--project` works outside Git without a hidden Project or parent read;
omission uses repository discovery. Help runs without configuration, Git or
network. Success exits 0, invalid arguments 2 and operation failure 1; diagnostics
use stderr. A 401 directs `daynight login` without automatic login or replay.
Output failure can leave partial stdout and still exits as a failure.

## Add a Step

```bash
daynight task step add <task-id> --title "Coding round 2" --project <project-id>
daynight task step add <task-id> --title "Review round 2" --id 00abcdef --description "" --status todo --after <step-id> --if-version <observed-version> --json --project <project-id>
```

Title is required; omitted description is empty and omitted status is todo.
Titles and Markdown retain original text. `--before` and `--after` are exclusive
Task-local anchors; omit both to append. `--id` accepts an eight-hex value;
otherwise one UUIDv4 first segment is chosen before submission. Unknown results
do not select a replacement ID. A confirmed add returns the complete collection
in the requested position.

## Update content or status

```bash
daynight task step update <task-id> <step-id> --title "Review findings" --description "Resolve the remaining major issue." --if-version <observed-version> --json --project <project-id>
daynight task step set-status <task-id> <step-id> done --if-version <observed-version> --json --project <project-id>
```

Update requires title, description or both; both save atomically. Omission
preserves a field and `--description=""` clears it. Titles need at least one
non-Unicode-White_Space character; U+FEFF alone is valid and U+0085 alone invalid.
Original characters and whitespace remain intact. Set-status accepts all four
Step states independently from the Task and other Steps.

## Move a Step

```bash
daynight task step move <task-id> <step-id> --first --project <project-id>
daynight task step move <task-id> <step-id> --after <anchor-id> --if-version <observed-version> --json --project <project-id>
```

Choose exactly one of `--before`, `--after`, `--first` or `--last`. A relative
anchor must be another Step in the same Task. Invalid combinations and
self-reference fail before configuration or network access. Movement preserves
every Step's identity, content, status and timestamps, and the relative order of
other Steps. Moving to the current position is a no-op.

## Delete a Step

```bash
daynight task step delete <task-id> <step-id> --project <project-id>
daynight task step delete <task-id> 00ABCDEF --if-version <observed-version> --json --project <project-id>
```

Delete permanently removes one record and its description in any Step state.
Referenced attachments, PRs, Sessions and other materials remain; there is no
Step history or restore command. Confirmed deletion returns the complete
remaining collection, including steps: [] after the last deletion. Repeated
deletion, a soft-deleted parent and version exhaustion remain errors.

Confirmed write text prints `Step added. ID: <id>`, `Step updated. ID: <id>`,
`Step status set. ID: <id>`, `Step moved. ID: <id>` or `Step deleted. ID: <id>`,
followed by the complete collection. `--json` prints only that resource and LF.
Known refusals retain safe service codes, request IDs and capacity details.
A confirmed receipt survives local output or cleanup failure, which still
exits nonzero.
