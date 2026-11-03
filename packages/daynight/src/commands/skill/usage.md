---
name: daynight
description: Use the Daynight CLI to create and query projects and manage task responsibility, dependencies, properties and attachments with version-safe writes.
---

# Daynight Project and Task Usage

`daynight` and `dn` accept the same commands. Replace angle-bracket placeholders
with actual IDs or values. Use `daynight --help` for other capabilities and each
subcommand's `--help` for its exact options.

## Projects

```bash
daynight project create "Example project"
daynight project create "Example project" --repo https://github.com/owner/repo.git
daynight project list --json
daynight project show <project-id> --json
```

Creation uses the current Git worktree's origin unless `--repo` is supplied;
an explicit repository works outside Git. A unique equivalent repository returns
its existing project; multiple matches require choosing the intended project ID.
Task commands normally resolve the current origin to its project. Add
`--project <project-id>` to a task operation to select one explicitly, including
outside Git. Project and task IDs are complete UUIDs.

## Create and Query Tasks

```bash
daynight task create --title "Improve installation" --description "Document prerequisites and verify setup."
daynight task list --all --json
daynight task list --status in_progress --json
daynight task list --ready --assigned-to me --json
daynight task list --assigned-to unassigned --json
daynight task ready --limit 20 --json
daynight task show <task-id> --json
```

New tasks start in `todo`, unassigned unless explicitly selected, with automatic
execution disabled. `task list` excludes
`done` by default; `--all` and `--status` are mutually exclusive. List reads all
matching pages; JSON omits descriptions, so read `show --json` for a complete
task and its version. Creation returns text and does not accept `--json`.

`ready` reads one page, defaulting to 10 tasks; `--limit` accepts 1 through 100.
A task is ready when it is todo and every prerequisite is done. Both list and
ready support `--allow-agents true|false` and
`--compatible-platform windows|linux|macos`; filters combine with AND before
pagination. Platform filtering includes unrestricted tasks and exact matches.
List also accepts `--ready` and `--assigned-to <user-uuid|me|unassigned>`.
An assignee filter remains on every page and can combine with the other list
filters. `me` uses the successful response identity, including on empty pages,
and does not issue another identity request. `ready` has no assignee option; use
`task list --ready --assigned-to me` instead. Readiness, human responsibility and
automatic permission are separate.

## Version-Safe Writes

Read `task show <task-id> --json` before deciding a change, then supply its exact
`version` through `--if-version` on updates, status, property and delete writes.
Versions are positive decimal int64 values; preserve every digit without
floating-point rounding. Reread after each write before the next change.

Without `--if-version`, the CLI reads the latest version immediately before
submitting; that read does not protect an earlier decision. On conflict, reread
and reassess the change. Never blindly replay a write with a newer version.
Mutations are not retried. Cancellation, timeout or a lost response may follow a committed
write: read back actual fields or attachment content before another mutation.
Reconcile uncertain creation before creating another task; a matching title alone
does not prove identity.

## Fields and Status

```bash
daynight task update <task-id> --title "Clarify installation" --if-version <observed-version>
daynight task update <task-id> --description "" --if-version <observed-version>
daynight task create --title "Review installation" --assigned-to <user-uuid>
daynight task update <task-id> --assigned-to <user-uuid> --if-version <observed-version>
daynight task update <task-id> --clear-assigned-to --if-version <observed-version>
daynight task update <task-id> --allow-agents true --required-platform linux --if-version <observed-version>
daynight task set-status <task-id> in_progress --if-version <observed-version>
daynight task set-status <task-id> done --if-version <observed-version>
```

Update requires at least one mutable field. An empty description clears it;
omitted fields remain unchanged. Set `--required-platform windows|linux|macos`
or use `--clear-required-platform`, never both.

`assignedTo` is one optional human responsible for the task, not a property or
worker identity. Create/update accept `--assigned-to <user-uuid>`; update also
accepts `--clear-assigned-to` to send null. Setting and clearing conflict. Writes
accept UUIDs only; `me` and `unassigned` are list filters. A real assignee change
also sets `allowAgents=false`; an equal value preserves it. Assignment grants no
project access or transfer an existing execution. The accepted automatic claim
rule requires a non-null assignee matching the worker's authenticated account;
permission alone is not sufficient. Existing claim and manual-resume authority
remain separate.

Actual assignment, permission and platform changes are locked while in progress.
These settings do not change status; `set-status` accepts `todo`, `in_progress`
or `done`. Task and graph JSON always retain `assignedTo` as a UUID or null;
text output shows `Assigned to: USER_UUID` or `Assigned to: unassigned`.

Every direct prerequisite must be done before entering in_progress or done.
Reopening done work is refused while a direct successor is in_progress or done.
A same-status request still checks the version. Text options accept
`--option=value`; use that form for dash-prefixed values, such as
`--title=-example`. Where help advertises `--`, put options before it to preserve
dash-prefixed positional text.

## Dependencies and Graphs

```bash
daynight task update <task-id> --depends-on <ordinary-prerequisite-id> --external-depends-on <external-prerequisite-id> --if-version <observed-version>
daynight task update <task-id> --clear-dependencies --if-version <observed-version>
daynight task graph <task-id> --json
daynight task graph <task-id> --depends-only --json
```

Create and update accept repeated `--depends-on` for ordinary prerequisites in
the same chain and `--external-depends-on` for prerequisites in other chains.
Both kinds block execution until done. IDs must occur once across both sets.
Supplying either option replaces every dependency and classification: include
all ordinary and external prerequisites to retain. Omitting both during update
preserves them. `--clear-dependencies` clears both and conflicts with either.

Graph requires a task ID and returns its entire ordinary dependency component
in either direction plus chain members' direct external prerequisites; external
tasks are not expanded. `--depends-only` retains that task set and outputs only
`id`, `dependsOn` and `externalDependsOn`, including references outside the result.

## Properties

```bash
daynight task properties --schema --json
daynight task properties <task-id> --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"Clarify installation"}]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
```

Read server-defined types and write permissions with `--schema`, which cannot
be combined with a task ID or `--project`. Property names are literal keys,
not nested paths. The server parses JSON or accepts direct text for string
properties. Set replaces the complete property and preserves other keys;
include existing PR entries when replacing `pullRequests`. Unknown and read-only
properties are rejected. Set and remove accept `--project` and `--if-version`,
but not `--json`.

Remove deletes the key. Absence, an empty array and JSON null differ; null is
valid only when the schema permits it. For dash-prefixed names or values, put
options first and then `--` before positional arguments.

## Attachments

```bash
daynight task attachment put <task-id> ./design.md --path docs/design.md
daynight task attachment list <task-id> --tree
daynight task attachment list <task-id> --json
daynight task attachment read <task-id> docs/design.md > ./downloaded-design.md
daynight task attachment remove <task-id> docs/design.md
```

Put uploads one regular file, replacing the same target path; the default is its
source basename. Paths are case-sensitive, use `/`, preserve Unicode and remain
relative to the task attachment root. Empty, dot or parent segments, backslashes
and control characters are invalid. `--tree` and `--json` conflict.

Read outputs only original bytes, without labels or an added newline. A failed
read can leave a partial redirected file; check its exit code. All attachment
operations accept `--project`. They do not accept `--if-version`, and attachment
writes do not change the task version. Reconcile uncertain upload or removal
with list/read before another write.

## Delete Tasks

```bash
daynight task delete <task-id> --if-version <observed-version>
daynight task delete <task-id> --remove-depends --if-version <observed-version>
```

Deletion hides a task from normal queries but retains its stored data and
attachments; deleted tasks cannot be read or changed. Dependents prevent deletion
unless `--remove-depends` removes their ordinary and external edges to the target
in the same transaction, potentially making them ready. An active worker claim
always prevents deletion. Confirm the target and affected dependencies first.
