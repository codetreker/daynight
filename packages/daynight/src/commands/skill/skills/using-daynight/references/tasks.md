# Tasks

Establish the [Project](setup-and-projects.md#project-discovery) first; every write
also requires [write safety](write-safety.md).

## Queries

```bash
daynight task create --title "Improve installation" --description "Document prerequisites and verify setup."
daynight task create --title "Implement confirmed work" --status todo
daynight task list --all --json
daynight task list --status in_progress --json
daynight task list --ready --assigned-to me --json
daynight task list --assigned-to unassigned --json
daynight task ready --limit 20 --json
daynight task show <task-id> --json
```

Ordinary Task creation accepts only `--status proposed|todo`: default proposed is an unconfirmed
suggestion; todo is confirmed work, including internal multi-step Tasks. Defaults
are the signed-in assignee and automatic execution disabled; override assignment
with `--assigned-to <user-uuid>`. Creation returns text, not `--json`.

Task resources require `type` (`task` or `goal`) and nullable `parentId`.
Ordinary creation produces `type=task` with no parent; public creation/update
options expose neither field. Full Goal reads include
`progress:{total,done,cancelled,unfinished}`; counts are nonnegative integers and
done+cancelled+unfinished=total. Ordinary Tasks have no progress object.

| Read | Scope/output |
| --- | --- |
| `task list` | All matching pages; excludes done/cancelled unless `--all` or explicit `--status` (mutually exclusive). Text is summary; JSON omits only description. |
| `task ready` | One capped page of ready todo candidates; creation order, default 10, `--limit` 1–100. |
| `task show` | One complete Task: description, properties, exact version; read before deciding about it. |
| `task graph <task-id>` | Compact relationship view; see [Dependencies](#dependencies). |
| `task list --status in_progress --group-by chain` | One page of the selected user's in-progress chains/independent Tasks; see [grouped work](session-reads.md#grouped-work). |

List filters are `--ready`, `--assigned-to <user-uuid|me|unassigned>`,
`--allow-agents true|false`, and `--compatible-platform windows|linux|macos`.
They combine with AND before pagination and persist on every page. Platform
matching includes unrestricted Tasks and exact matches. `me` uses response
identity even on empty pages. Ready supports permission/platform filters but no
assignee filter; use `task list --ready --assigned-to me`. Readiness, assignment
and automatic permission are independent.

Lists order in_progress, ready todo, blocked todo, proposed, then selected
terminal Tasks; done/cancelled stay distinct. Neither list nor ready ordering
ranks relevance. List/show/graph include [Session observations](session-reads.md#observations);
ready and Task-returning writes retain full Task data without querying live Sessions.
A candidate page or single Task cannot prove a complete inventory or verify all
relationships. Include terminal Tasks for duplicate/history checks; read full
descriptions and separate materials required for the decision.

## Search

`task search <expression>` searches full IDs, titles and Markdown descriptions in
one Project, including done/cancelled. Pass one expression argument; use `--` for
a leading dash. Grammar: uppercase `AND`, `OR`, `NOT`, parentheses, quoted phrases,
`title:`, `description:`, `id:`; adjacency means AND. Matching is literal substring
with ASCII case folding.

Search accepts `--status`, `--assigned-to`, `--ready`, `--allow-agents` and
`--compatible-platform`, not `--all`; it traverses all pages in server relevance
order. Matches/chain
context are compact, not full Tasks. Text/JSON omit assignee and update time;
JSON fields are id, type, parentId, projectId, title, status, cancelledAt, context
and match. Search text also displays Type and Parent; context still describes
the independent task chain.
Any failure, including `search_changed`, leaves stdout empty; search again after
changes.

## Metadata

```bash
daynight task update <task-id> --title "Clarify installation" --if-version <observed-version>
daynight task update <task-id> --assigned-to <user-uuid> --if-version <observed-version>
daynight task update <task-id> --allow-agents true --required-platform linux --if-version <observed-version>
```

Update needs at least one mutable field. Supplied description replaces the
entire field: preserve required content; `--description=""` clears it, omission
preserves it. `--required-platform windows|linux|macos` conflicts with
`--clear-required-platform`.

`assignedTo` is one nullable human responsible, independent of properties/Worker
identity. Creation resolves the current account unless given an explicit UUID;
lookup failure prevents creation. Assignment writes accept UUIDs, not the list
filters me/unassigned. `--clear-assigned-to` clears assignment and conflicts with
`--assigned-to`.

A real assignment change resets allowAgents=false; equal assignment preserves it.
Assignment grants no Project access or execution transfer. Automatic claiming
needs a non-null assignee matching the Worker's authenticated account; existing
claim/manual-resume authority is separate. Actual assignment, permission and platform
changes are locked in_progress and do not change status. Task/graph JSON retain
assignedTo as UUID/null; text shows UUID/unassigned.

## Status and timing

```bash
daynight task set-status <task-id> in_progress --if-version <observed-version>
daynight task set-status <task-id> done --if-version <observed-version>
```

Goals support todo, in_progress, done and cancelled and can be reopened. They
have no parent, platform restriction or prerequisites; automatic execution is
disabled and they are never ready.

Without `--force`, before a Goal is set to done/cancelled, the CLI warns on stderr that child Task
states remain, new automatic claims are excluded and existing claims continue.
Goal terminal-status changes and deletion require interactive confirmation or
`--force`; noninteractive calls without force do not submit. Force skips only
the Goal prompt, preserving service business/version checks. Ordinary Tasks and
nonterminal Goal status changes do not prompt.

The following lifecycle and timing rules describe ordinary Tasks.

| Status | Meaning |
| --- | --- |
| proposed | Unconfirmed/unfinished; never ready, cannot satisfy prerequisites or be automatically claimed/resumed from released execution. |
| todo | Confirmed work not started this interval; ready only when every prerequisite is done/cancelled. |
| in_progress | Recorded progress, not an executor lock or lease. |
| done | Successful delivery supported by results and applicable acceptance. |
| cancelled | No further execution required; irreversible, not proof of delivery. |

Ordinary non-cancelled Tasks can move directly among proposed, todo, in_progress
and done, subject to dependency/Worker protections; no initial stage is mandatory.
Entering in_progress/done requires all direct prerequisites done/cancelled;
allowAgents=true never makes proposed ready.

Cancellation needs explicit target authorization, not missing delivery or failed
acceptance. It ignores the Task's own prerequisite gate, preserves edges and can
make successors ready without supplying outputs or stage confirmation. A done
Task cannot reopen while a direct successor is in_progress/done; cancelled
successors impose no restriction. Done→cancelled preserves prerequisite
satisfaction; cancelled cannot return to another state.

| Actual transition | Timing |
| --- | --- |
| Enter in_progress | Start new interval; clear completion time. |
| Return to proposed/todo | Clear start/completion times. |
| in_progress→done | Preserve nullable start; record completion. |
| proposed/todo→done | Record completion only; elapsed execution time unknown. |
| Enter cancelled | Record cancelledAt; preserve execution start/completion. |

Real status changes increment version once; same-status requests change nothing.
Metadata/same-status writes preserve timing. Time-bearing projections require
nullable cancelledAt, non-null only when cancelled. Current terminal time is
completedAt for done, cancelledAt for cancelled; historical completion does not
establish cancelled delivery.

Status writes neither release, stop, withdraw nor transfer Workers. An active
claim needs authorized release before cancellation. Released history on cancelled
Tasks authorizes neither resume nor withdrawal to proposed/todo. Cancellation
preserves readable Task material, properties, Steps, Thread, execution history
and attachment bytes; it does not mark deletion, rotate Project epoch or close
PRs/branches. Resource cleanup retains its ownership/retry rules. Ordinary
completion has no claim; assigned Workers use [the original claim](worker-operations.md).
Never switch paths to bypass a rejection.

## Dependencies

```bash
daynight task update <task-id> --depends-on <ordinary-prerequisite-id> --external-depends-on <external-prerequisite-id> --if-version <observed-version>
daynight task update <task-id> --clear-dependencies --if-version <observed-version>
daynight task graph <task-id> --depends-only --json
```

Task resources expose complete direct prerequisites D=dependsOn and external
subset E=externalDependsOn; ordinary prerequisites are D−E. These are normalized,
unordered UUID sets without duplicates. Ordinary edges belong to the same chain;
external edges cross chains within the same Project, never Projects. Both kinds
undergo cycle/access checks and block entry to in_progress/done until terminal.
Classification requires actual content/ownership, not status, titles, graph roots
or connected components.

For CLI create/update, repeated `--depends-on` supplies ordinary edges and
`--external-depends-on` external edges. Either option replaces **all** edges and
classifications: read D/E and declare every relationship to retain. IDs must be
unique across options, including equivalent UUID forms. Omit both to preserve;
`--clear-dependencies` clears both and conflicts with either declaration. Omit
dependency options for unrelated metadata changes; direct API partial-patch
semantics do not establish CLI preservation.

Graph nodes are ordinary Tasks, retaining parentId; Goal resources are not nodes.
Graph includes every status in the full bidirectional ordinary component plus
one layer of members' external prerequisites; external Tasks are not expanded.
Nodes omit full descriptions, PR properties and exact versions. Limits fail,
never truncate. `--depends-only --json` preserves that Task set but returns only
id, dependsOn and externalDependsOn; references may point outside it. Unavailable
prerequisites remain IDs without invented nodes or exposed details. After edits,
read relevant graphs/outside paths to verify full D/E and classification. An
absent graph node does not prove a missing dependency.

## Properties

```bash
daynight task properties --schema --json
daynight task properties <task-id> --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"Clarify installation"}]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
```

`--schema` reads server-defined types/write permissions without Project or Git;
it conflicts with Task ID/`--project`. Names are literal case-sensitive keys,
not nested paths. The service parses JSON or accepts direct text for string
properties. Set replaces one complete value, preserving other keys; retain
existing PR entries when replacing pullRequests. Remove deletes the key.
Absence, [] and JSON null differ; null needs schema permission.

Set/remove accept `--project`, not `--json`. For dash-prefixed names/values, put
options first, then `--` before positional arguments. Same-value set or already-absent removal changes no
stored fields. Results contain Task/Project IDs, exact version and all properties.
Unknown/read-only/malformed/illegally stored values return `400 invalid_input`;
database/internal faults remain `500 internal_error`.

## Task deletion

```bash
daynight task delete <task-id> --if-version <observed-version>
daynight task delete <task-id> --remove-depends --if-version <observed-version>
```

Goal deletion uses the [Goal impact confirmation](#status-and-timing) above. Its
confirmation warns that the Goal and all its Tasks become invisible, membership remains,
and running Tasks stop through the existing process after a subsequent successful
observation. `--remove-depends` applies only to ordinary Tasks.

For ordinary Tasks, soft deletion hides the Task from ordinary lists, graphs,
ready and detail reads, retaining stored data, its own prerequisites and
attachment bytes. It is status-independent, not completion. Active Worker claims
always block it; use authorized
release, not a status change.

Any undeleted dependent blocks default deletion. Explicitly authorized
`--remove-depends` atomically deletes the target and removes incoming ordinary/
external edges, including those added before the transaction; successors may
become ready. Changed Tasks increment versions, preserving status, timing, Worker
ownership and unrelated fields. Confirm target and affected dependencies first.

Success returns neither a Task nor removed-edge count. After an unknown response,
`410 task_deleted` confirms deletion; if the Task exists, decide again. Access or
transport failures cannot confirm it: follow
[uncertain results](write-safety.md#uncertain-results).
