# Tasks

Establish the [Project](setup-and-projects.md#project-discovery) before operating
on Tasks. For writes, also read [write safety](write-safety.md).

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

Creation defaults to `proposed`, an unconfirmed suggestion, assigned to the
signed-in account with automatic execution disabled. Creation accepts only
`--status proposed|todo`; use `todo` for confirmed work, including internal
multi-step tasks. `--assigned-to <user-uuid>` selects another person. Creation
returns text and does not accept `--json`.

| Read | Scope and limits |
| --- | --- |
| `task list` | All matching pages; excludes done and cancelled unless `--all` or an explicit `--status` is supplied. These options conflict. |
| `task ready` | One capped page of ready todo candidates, ordered by creation rather than relevance; default 10, `--limit` 1–100. |
| `task show` | One complete Task, including description, properties and exact version; read it before a decision about that Task. |
| `task graph <task-id>` | The ordinary dependency component in both directions plus its members' direct external prerequisites, including all statuses. |
| `task list --status in_progress --group-by chain` | One page of the selected user's in-progress chains and independent tasks; see [grouped work](session-reads.md#grouped-work). |

List accepts `--ready`, `--assigned-to <user-uuid|me|unassigned>`,
`--allow-agents true|false` and `--compatible-platform windows|linux|macos`.
Filters combine with AND before pagination and remain on every page. Platform
filtering includes unrestricted Tasks and exact matches. `me` uses the successful
response identity, including on an empty page. Ready supports permission and
platform filters but has no assignee option: use `task list --ready --assigned-to
me` for that purpose. Readiness, assignment and automatic permission are separate.

Lists group in-progress Tasks first, then ready todo, blocked todo, proposed and
selected terminal Tasks. Done and cancelled remain distinct; these groups are
not relevance rankings. Human-readable ordinary lists are summaries; their JSON
omits only description. Ordinary list, show and graph include
[Session observations](session-reads.md#observations). Ready and Task-returning
write results retain complete Task data without a live Session query.

Graph nodes omit full descriptions, PR properties and exact versions. Graph
limits fail the command rather than truncate the result. A candidate page or one
Task cannot establish a complete work inventory or verify all relationships.
Explicitly include terminal Tasks when checking for duplicates or inspecting
history. Read descriptions and separate materials where the decision needs them.

## Search

`task search <expression>` searches full IDs, titles and Markdown descriptions
within one Project, including done and cancelled Tasks. Pass the entire expression
as one argument; use `--` for a leading dash. Expressions support uppercase
`AND`, `OR`, `NOT`, parentheses, quoted phrases and `title:`, `description:` or
`id:` fields. Adjacent terms imply AND. Matching is literal substring with ASCII
case folding.

Search accepts `--status`, `--assigned-to`, `--ready`, `--allow-agents` and
`--compatible-platform`, but not `--all`. It traverses all pages in server
relevance order. Matches and chain context are compact, not full Tasks; text and
JSON omit assignee and update time. JSON entries contain `id`, `projectId`,
`title`, `status`, `cancelledAt`, `context` and `match`. A failure, including
`search_changed`, leaves stdout empty; rerun the search after a change.

## Metadata

```bash
daynight task update <task-id> --title "Clarify installation" --if-version <observed-version>
daynight task update <task-id> --description "" --if-version <observed-version>
daynight task update <task-id> --assigned-to <user-uuid> --if-version <observed-version>
daynight task update <task-id> --clear-assigned-to --if-version <observed-version>
daynight task update <task-id> --allow-agents true --required-platform linux --if-version <observed-version>
```

Update requires at least one mutable field. A supplied description replaces the
entire existing description; preserve required content. An empty description
clears it, while omission preserves it. `--required-platform windows|linux|macos`
conflicts with `--clear-required-platform`.

`assignedTo` is one nullable human responsible, independent of properties and
Worker identity. Creation without an explicit assignee resolves the current
account; failure prevents creation. An explicit UUID skips that identity lookup.
Assignment writes accept UUIDs only: `me` and `unassigned` are list filters.
`--assigned-to` conflicts with `--clear-assigned-to`.

A real assignment change resets `allowAgents=false`; an equal value preserves it.
Assignment grants no Project access and does not transfer an execution. Automatic
claiming requires a non-null assignee matching the Worker's authenticated account;
existing claim and manual-resume authority are separate. Actual assignment,
permission and platform changes are locked while in progress, and none changes
status. Task and graph JSON retain `assignedTo` as a UUID or null; text displays
the UUID or `unassigned`.

## Status and timing

```bash
daynight task set-status <task-id> in_progress --if-version <observed-version>
daynight task set-status <task-id> done --if-version <observed-version>
```

| Status | Meaning |
| --- | --- |
| proposed | Unconfirmed suggestion; unfinished, never ready, cannot satisfy prerequisites or be automatically claimed/resumed from released execution. |
| todo | Confirmed work not started in the current interval; ready only when every prerequisite is done or cancelled. |
| in_progress | Work recorded as in progress, without executor-lock or lease semantics. |
| done | Successful delivery, supported by actual results and applicable acceptance. |
| cancelled | No further execution is required; irreversible and not proof of delivery. |

Ordinary non-cancelled Tasks can move directly among proposed, todo, in_progress
and done, subject to dependency and Worker protections; no initial stage is
mandatory. All direct prerequisites must be done or cancelled before entering
in_progress or done. `allowAgents=true` does not make proposed work ready.

Cancellation requires explicit authorization for the selected Task; absent
delivery or failed acceptance does not supply it. Cancellation ignores the
Task's own prerequisite gate and preserves dependency edges. It can make a
successor ready without supplying missing output or stage confirmation. A done
Task cannot reopen while a direct successor is in_progress or done; cancelled
successors do not impose that restriction. Done can become cancelled without
withdrawing prerequisite satisfaction. Cancelled cannot return to another state.

| Actual transition | Timing |
| --- | --- |
| Enter in_progress | Start a new interval and clear completion time. |
| Return to proposed or todo | Clear start and completion times. |
| in_progress to done | Preserve nullable start time and record completion time. |
| proposed or todo to done | Record completion only; elapsed execution time is unknown. |
| Enter cancelled | Record cancelledAt and preserve execution start/completion times. |

A real status change increments the version once. Same-status requests change
no fields. Metadata and same-status writes preserve timing.
`cancelledAt` is required and nullable in time-bearing projections: non-null only
when cancelled. Current terminal time is completedAt for done and cancelledAt
for cancelled; historical completion time does not establish cancelled delivery.

Status writes do not release, stop, withdraw or transfer a Worker. An active
claim must first be released through an authorized management operation before
cancellation. Released history on a cancelled Task authorizes neither resume nor
withdrawal to proposed/todo. Cancellation preserves readable Task material,
properties, Steps, Thread, execution history and attachment bytes; it does not
mark deletion, rotate the Project epoch or close PRs/branches. Resource cleanup
keeps its own ownership and retry rules. Ordinary completion has no claim;
assigned Worker completion uses [the original claim](worker-operations.md).
A rejected path cannot be replaced with the other to bypass its protections.

## Dependencies

```bash
daynight task update <task-id> --depends-on <ordinary-prerequisite-id> --external-depends-on <external-prerequisite-id> --if-version <observed-version>
daynight task update <task-id> --clear-dependencies --if-version <observed-version>
daynight task graph <task-id> --depends-only --json
```

In Task resources, `dependsOn` is the complete direct prerequisite set D and
`externalDependsOn` its external subset E; ordinary prerequisites are D minus E.
Both are normalized UUID sets without ordering or duplicates. Ordinary edges
belong to the same chain; external edges are cross-chain prerequisites in the
same Project, never cross-Project references. Both kinds participate in cycle and
access checks and block entry to in_progress/done until terminal. Verify actual
content and ownership; status, titles, graph roots and connected components
cannot establish intended classification.

For CLI create/update, repeated `--depends-on` supplies the ordinary set and
`--external-depends-on` the external set. Supplying either replaces **all** edges
and classifications. Read D/E and declare every relationship to retain. IDs
must be unique across both options, including equivalent UUID forms. Omitting
both preserves relationships; `--clear-dependencies` clears both and conflicts
with either declaration. Omit dependency options for unrelated metadata changes.
Direct API partial patches have different semantics; do not infer CLI preservation
from them.

Graph returns the full ordinary component and one layer of its external
prerequisites, without expanding those external Tasks. `--depends-only --json`
retains that Task set but only returns id, dependsOn and externalDependsOn.
References can point outside the returned graph. After changing relationships,
read the relevant graphs and outside paths to verify the complete D/E sets and
classification; a missing graph node is not proof of a missing dependency.

## Properties

```bash
daynight task properties --schema --json
daynight task properties <task-id> --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"Clarify installation"}]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
```

`--schema` reads server-defined types and write permissions without Project or
Git context; it conflicts with a Task ID or `--project`. Property names are
literal case-sensitive keys, not nested paths. The service parses JSON or accepts
direct text for string properties. Set replaces one complete value, retaining
other keys; preserve existing PR entries when replacing pullRequests. Remove
deletes a key. Absence, an empty array and JSON null differ; null is valid only
where the schema allows it.

Set/remove accept `--project`, not `--json`. For dash-prefixed names or values,
put options first and `--` before positional arguments. A same-value set or
already-absent removal changes no stored fields. Results include Task/Project
IDs, exact version and all properties.
Unknown, read-only, malformed or illegally stored values return `400 invalid_input`;
database and internal faults remain `500 internal_error`.

## Task deletion

```bash
daynight task delete <task-id> --if-version <observed-version>
daynight task delete <task-id> --remove-depends --if-version <observed-version>
```

Soft deletion removes a Task from ordinary lists, graphs, ready results and detail
access while retaining stored data, its own prerequisite references and attachment
bytes. It is independent of status and is not completion. An active Worker claim
always blocks deletion; first use an authorized release operation, not a status
change.

By default, any undeleted dependent prevents deletion. Explicitly authorized
`--remove-depends` deletes the target and removes incoming ordinary/external
edges in one transaction, including references added before it. This can make
successors ready. Changed Tasks increment their versions while preserving status,
timing, Worker ownership and unrelated fields. Confirm the target and affected
dependencies before deciding.

Successful deletion returns neither a Task nor a count of removed edges. For an
unknown response, `410 task_deleted` from a Task read confirms deletion. If it
still exists, decide again. Missing access or a transport failure cannot confirm
deletion; follow [uncertain results](write-safety.md#uncertain-results).
