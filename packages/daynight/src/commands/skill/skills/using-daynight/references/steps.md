# Steps

Steps are ordered Task-owned records: title, Markdown description,
todo/in_progress/done/skipped status, creation/update times. Projects define
names, granularity and use. Steps persist across Sessions; transient plans,
commands, logs and operational authorization stay in Sessions.

Status, order and review outcome are independent: all transitions (including
self-transitions) and multiple in_progress Steps are allowed. Done proves neither
passed review nor Task completion. Steps affect no readiness, claims or execution
authority; Task status never updates them.

For writes, read [write safety](write-safety.md). `task step list <task-id> --json`
supplies the parent Task version shared with metadata/properties/status. Omitting
[`--if-version`](write-safety.md#decisions-and-versions) reads complete Steps before
writing. Changes increment parent version once; no-ops preserve version/times.
The 1 MiB request limit includes JSON escaping.

Writes retain original Project/Task/Step IDs and request UUID. Unknown outcomes
exit 1 without a success resource; at most one current-facts read may occur while
the same operation is live. Found/absent proves no historical success/rollback;
a same-ID record need not be the original. Cancellation/exhausted budgets start
no detached read. Without current observation, use ordinary list/show with
original ID and explicit Project; apply [uncertain results](write-safety.md#uncertain-results).

## Read Steps

```bash
daynight task step list <task-id> --json --project <project-id>
daynight task step show <task-id> <step-id> --json --project <project-id>
```

Task list/show/graph omit the full collection. Identify Steps by Task plus the
complete eight-hex ID (case-insensitive input, lowercase output, significant
leading zeros), never UUID/display position. Different Tasks may share an ID.

| Read/output | Contents |
| --- | --- |
| List | Saved order; parent version, total count, display position, full short ID, status and complete title. JSON: projectId/taskId/version/steps. |
| Show | Every target field, including full description/times. JSON: projectId/taskId/version/step. |

Neither JSON resource is a bare array. JSON preserves raw strings/exact int64;
text visibly escapes terminal/bidi controls. Empty collections are valid;
invalid scope/fields/IDs/text/status/UTC microsecond times are errors, never empty
results. Complete validation precedes output; successful JSON is one value plus LF.

Explicit `--project` works outside Git without hidden Project/parent reads;
omission uses repository discovery. Help needs no configuration, Git or network.
Exit 0=success, 2=invalid arguments, 1=operation failure; diagnostics use stderr.
A 401 directs `daynight login` without automatic login/replay. Output failure may
leave partial stdout and still fails.

## Add a Step

```bash
daynight task step add <task-id> --title "Review round 2" --id 00abcdef --description "" --status todo --after <step-id> --if-version <observed-version> --json --project <project-id>
```

Title is required; omitted description/status default to empty/todo. Titles and
Markdown preserve original text. Mutually exclusive `--before`/`--after` anchors
are Task-local; omit both to append. `--id` accepts eight hex characters;
otherwise one UUIDv4 first segment is chosen before submission. Unknown results
never select a replacement ID. Confirmed add returns the complete collection in
the requested position.

## Update content or status

```bash
daynight task step update <task-id> <step-id> --title "Review findings" --description "Resolve the remaining major issue." --if-version <observed-version> --json --project <project-id>
daynight task step set-status <task-id> <step-id> done --if-version <observed-version> --json --project <project-id>
```

Update needs title, description or both (atomic together). Omission preserves;
`--description=""` clears. Titles need a non-Unicode-White_Space character:
U+FEFF alone is valid, U+0085 alone invalid. Original characters/whitespace remain intact.
Set-status accepts all four states independently of Task/other Steps.

## Move a Step

```bash
daynight task step move <task-id> <step-id> --first --project <project-id>
daynight task step move <task-id> <step-id> --after <anchor-id> --if-version <observed-version> --json --project <project-id>
```

Choose exactly one of `--before`, `--after`, `--first`, `--last`; relative anchors
must be another Step in the same Task. Invalid combinations/self-reference fail
before configuration/network access. Movement preserves every Step's identity,
content, status, times and other Steps' relative order. Current position is a no-op.

## Delete a Step

```bash
daynight task step delete <task-id> 00ABCDEF --if-version <observed-version> --json --project <project-id>
```

Delete permanently removes one record/description in any state; referenced
attachments, PRs, Sessions and other materials remain. There is no Step history
or restore command. Confirmation returns the complete remaining collection,
including steps: [] after the last deletion. Repeated deletion, soft-deleted
parents and version exhaustion remain errors.

Confirmed write text prints `Step added. ID: <id>`, `Step updated. ID: <id>`,
`Step status set. ID: <id>`, `Step moved. ID: <id>` or `Step deleted. ID: <id>`, then
the complete collection. `--json` prints only that resource plus LF. Known refusals
retain safe service codes, request IDs and capacity details. Confirmed receipts
survive local output/cleanup failures, which still exit nonzero.
