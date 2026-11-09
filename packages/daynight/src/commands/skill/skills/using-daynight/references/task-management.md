# Task management

Covers query scope, discussion, metadata, lifecycle, and dependency semantics.
See [authorization and scope](authorization.md) for operational permissions.
Follow [write safety](write-safety.md) for all writes.
Consult the relevant `--help` for arguments and field-clearing syntax.

## Task queries

| Read operation | Scope and limits |
| --- | --- |
| `task ready` | One capped page of candidate `todo` tasks whose direct prerequisites are all complete, ordered by creation, not relevance. An empty page does not rule out in-progress or blocked work. |
| `task list` | Traverse all matching pages. Excludes `done` and `cancelled` by default; explicitly include terminal tasks when checking for duplicates or inspecting history. `--assigned-to <uuid\|me\|unassigned>` filters responsibility, and combines with the other list filters. |
| `task search <expression>` | Search Task IDs, full titles and Markdown descriptions in one project, including done and cancelled tasks. Traverses all pages in server relevance order; returns a compact match and chain context, not complete tasks. |
| `task show` | A single task's full description, metadata, and exact version. Read it before operating on the selected task. |
| `task properties <task-id>` | The selected task's complete current property object and exact task version. |
| `task properties --schema` | The authenticated service's property definitions; no project or Git repository is required. |
| `task thread read <task-id>` | One bounded page of durable discussion, independent of task metadata and execution. |
| `task graph <task-id>` | The target's full bidirectionally connected component of ordinary dependencies, plus one layer of external prerequisites for those tasks. Includes all statuses without recursively expanding external tasks. |

For search, pass the complete expression as one argument; `--` supports a leading dash.
Use uppercase `AND`, `OR`, `NOT`, parentheses, quoted phrases, and `title:` or
`description:` or `id:` fields. Adjacent terms imply `AND`; matching is literal substring
with ASCII case folding. Search accepts the list filters `--status`, `--assigned-to`,
`--ready`, `--allow-agents`, and `--compatible-platform`, but not `--all`.
Its text and JSON omit assignee and update time; JSON entries contain only
`id`, `projectId`, `title`, `status`, `cancelledAt`, `context`, and `match`. A failure, including
`search_changed`, leaves stdout empty; rerun the search after a change.

Human-readable ordinary lists are summaries; their JSON entries omit only `description`.
Ready results, task details, and write results that return tasks contain complete tasks.
Dependency graphs provide compact relationship context without full descriptions, PR properties, or versions and cannot replace task details. `--depends-only --json` returns only `id`, the full `dependsOn` set, and its `externalDependsOn` subset.
Graph nodes retain complete dependency references, which may point outside the graph; read the relevant tasks or their dependency graphs when those paths need assessment.
Reaching the graph limit fails the command rather than returning a truncated graph.
A candidate page or a single task cannot replace complete relationship verification.

Lists group tasks into in-progress, ready todo, blocked todo, and, when explicitly included, terminal tasks. Done and cancelled remain distinct results.
These groups are not relevance rankings. See command help for filter syntax.

## Task Steps

Steps are an independent ordered Task resource. Read the complete collection with
`task step list <task-id> --json` or one record with `task step show <task-id>
<step-id> --json`; ordinary Task show/list/ready/graph and task-sync do not embed
the complete collection. A valid empty collection is `[]`; a failed or invalid
read is an error. Collection JSON includes projectId, taskId, the exact parent
Task version and ordered steps. Use the complete eight-hex Step ID within its
Task, not a prefix or display number. Input is case-insensitive, output lowercase,
and leading zeros remain significant; different Tasks may share an ID.

Use `task step add` to append or insert before/after an anchor, `update` to change
title or description, `set-status` to set a status, `move` with exactly one of
`--before`, `--after`, `--first` or `--last`, and `delete` to remove a record.
Update requires at least one field; an empty description explicitly clears it.
Deletion has no public restore or edit history. See each command's `--help` for
syntax and [write safety](write-safety.md#task-step-writes) for version and
unknown-outcome handling. Successful writes return the confirmed complete collection.

Step statuses are `todo`, `in_progress`, `done` and `skipped`; any transition is
allowed, including the same state and multiple in-progress Steps. Order, status
and business review result are distinct. Step `done` means the work ended, not
that review passed or the Task is complete. Steps do not affect Task readiness,
Worker acquisition or Task completion; Task state does not automatically change
Steps. Project rules determine appropriate use, without a system-imposed stage
sequence. Step writes preserve Task execution ownership and grant no execution
or delivery permission.

## Discussion threads

Use `task thread read <task-id>` for one bounded page of durable discussion,
independent of the current executor or Controller. The default is the latest
20 messages; `--count=N` accepts 1–100. Use exactly one of `--before-id` or
`--after-id` with a complete message UUID to read history or continue forward.
Pages display complete messages from old to new. A 256 KiB text limit can return
fewer messages than requested without truncating bodies. Thread read and post
accept `--project`; explicit selection does not read Task or Project first.

Readable blocks show full message/account Ids, Author, CreatedAt, optional
ReplyTo and Message. Agent authors include `Agent: True`; `--details` expands
verified claim/worker/provider attribution. A missing or empty display name
appears as Account with its actual account Id. There is no `--json` mode.
Terminal controls are visibly escaped and multiline bodies retain LF/TAB with
fixed indentation. More-before appears only above the page; more-after only
below it. Continue history from its first displayed Id, forward reads from its
last completely consumed Id. Empty forward reads preserve the input position.

Post with `task thread post <task-id> --body <text>`, optionally `--reply-to
<message-id>` and `--claim-id <active-claim-id>`. Body whitespace is preserved;
use `--body=-example` for dash-prefixed text. The service supplies the message
Id and author. Omit claim Id for an ordinary account; provide it explicitly for
verified Agent attribution. It is not inferred from task state or environment.
Messages are immutable and a reply must belong to the selected task.

Posting does not change task status, version, timestamps, properties or
dependencies, and does not trigger an Agent. Reading or posting discussion
grants no execution or delivery permission. Keep effective requirements and
results in their [content owners](task-content.md#task-thread-and-session-boundary).
Follow [Thread write safety](write-safety.md#thread-posts) for unknown outcomes.
A post receipt must not advance the continuously read position: after A, an
unseen B and a local post C must still be read using `--after-id A`.

## Metadata

`task update` cannot change status.
A supplied description fully replaces that field; retain content that must remain and omit unrelated fields.
Property values use the [property commands](#properties), independently of metadata updates.
See the [task content standard](task-content.md) for organizing descriptions and attachments.

| Field | Semantics and limits |
| --- | --- |
| `allowAgents` | Permission for automatic selection. False for new tasks and cannot be enabled during creation. Enable only after an explicit [handoff](handoff.md) review. Omission preserves its value when assignment does not change. |
| `requiredPlatform` | `null`, `windows`, `linux`, or `macos`; null means unrestricted. Can be specified during creation or updates and cleared during updates. |
| `assignedTo` | One optional human responsible for the task, represented by a local user UUID or null. Create/update use `--assigned-to <user-uuid>`; update uses `--clear-assigned-to` to send null. These options conflict. CLI creation defaults to the authenticated account when `--assigned-to` is omitted; an explicit UUID selects that person. Identity lookup failure prevents creation. Omission during update preserves the current value. |

A real assignee change, including first assignment or clearing, sets `allowAgents=false`
in the same update. A same-value assignment does not reset permission. The selected
new person must have project access; a retained former assignee may remain unchanged.
Human responsibility grants no project access or control of an existing claim.
Automatic acquisition requires assignment to the worker's authenticated account,
in addition to automatic permission and the other eligibility checks. Existing
claim inventory and explicit manual resume retain their execution-based authority.
Human responsibility is separate from the worker-managed execution assignment.

Actual changes to these fields are prohibited while `in_progress`.
Same-value requests preserve the version and timestamps, but stale versions still conflict.
Status, worker and property operations preserve the human assignee. Other metadata
changes preserve all omitted fields subject to the assignment/permission rule above.

List and ready support filtering by automatic-execution permission and platform compatibility.
The service combines filters before pagination or candidate limits.
Platform compatibility includes unrestricted and exact-match tasks without changing dependency readiness.
Preserve filters across pages; do not locally filter a capped, unfiltered ready page.
Assignee filtering belongs to `list`, not `ready`; combine `--ready --assigned-to me`
on list when needed. `me` is bound to the successful response principal on every
page, including empty pages; a complete list traversal cannot change that identity.
No extra identity lookup is required.

Ordinary execution explicitly targeted by the user is not restricted by automatic-selection permission or platform compatibility, but must still satisfy dependency, input, and authorization requirements.
Automatic execution must use the actual runtime platform and recheck full task eligibility before starting.
Query arguments do not prove the actual environment; a Linux runtime in WSL is Linux.

## Properties

Use `task properties <task-id>` to read current values and `task properties --schema` to inspect the service's definitions.
`task show` also contains properties. Schema discovery works without project discovery; property value operations use the selected task's project.

`task set-property <task-id> <property> <value>` replaces one complete value.
`task remove-property <task-id> <property>` removes that property record, so reads omit its key.
Setting `pullRequests` to `[]` retains an explicit empty array; it is different from removal.
A missing key, JSON null and an empty array are distinct, and the service definition decides whether null is allowed.

Names are complete, case-sensitive literal property names. A dot does not select a nested object path.
The service owns the property catalog, public writability and all value validation; a generic command does not create custom properties or bypass a read-only property.
The CLI forwards the value argument unchanged. Use JSON for structured values; a string property also accepts raw text under the service's parsing rule.
Use the command's `--` argument terminator when a positional value begins with a dash; keep options before the terminator.

To save PR references, provide the complete ordered JSON array of `{"url":"...","title":"..."}` objects as `pullRequests`, retaining every still-needed entry.
`task create` and `task update` do not accept property-specific PR options.
Use `--if-version` with the task version read for the decision; a conflict or uncertain result follows [write safety](write-safety.md), without automatic replay.
The CLI's default pre-submit property read does not protect a decision made from older material.
A same-value set or already-absent removal with the current version changes no stored fields; a stale version still conflicts.

Read commands support JSON output. Property reads and successful writes return the current property resource with task/project IDs, version and all properties.
Unknown attributes, malformed values, read-only writes and illegal stored property values are service `400 invalid_input` failures; database/internal faults remain `500 internal_error`.
Do not replace either failure with empty properties or silently drop a key.

## Status and timing

New tasks are `todo`, have no approval status, and do not execute automatically.
Use `task set-status` to set `todo`, `in_progress`, `done`, or `cancelled`.
Done means successful delivery; cancelled means no further execution is required.
Cancellation is irreversible and does not establish that requirements were delivered.
Cancel only within an explicit authorization to cancel the selected task; missing
delivery or failed acceptance alone is not cancellation authority.
Ordinary operations carry no claim; completion of a worker assignment must use [original-claim completion](autopilot-managed-task.md#complete-the-original-claim).
If either path is rejected, do not fall back to the other.

All direct prerequisites must be done or cancelled before entering `in_progress` or `done`.
Cancelling a task does not require its own prerequisites to be satisfied and does not
remove dependency edges or modify successors. A cancelled prerequisite can make a
successor ready, subject to every remaining prerequisite and execution condition.
A done prerequisite cannot be reopened while a direct successor is `in_progress` or `done`; successors are not modified automatically.
Cancelled successors do not add this restriction. Done may become cancelled without
revoking dependency satisfaction; cancelled cannot return to another state.

| Transition | Timing result |
| --- | --- |
| Enter `in_progress` | Start a new execution interval and clear the completion time. |
| Return to `todo` | Clear the start and completion times. |
| `in_progress` -> `done` | Preserve the nullable start time and record the completion time. |
| `todo` -> `done` | Record only the completion time; elapsed time is unknown. |
| Enter `cancelled` | Record cancelledAt and preserve the execution start/completion times. |

An actual status change increments the version once; a same-status operation with the current version changes no fields.
Metadata updates and same-status operations preserve timing.
Ordinary status changes have no process ownership, release, withdrawal, stop, or lease semantics.
An active worker claim must first be released or otherwise removed through an
authorized management operation before cancellation. Released history may be
retained on a cancelled task, but cannot authorize resume or withdrawal to todo.

Cancellation preserves task records, properties, Steps, Thread, execution history,
and attachment bytes. All materials remain readable under current access checks;
it does not set a deletion marker, rotate the project epoch, or close PRs/branches.
Existing resource cleanup retains its stop, archive, ownership and retry rules.
`cancelledAt` is required and nullable in time-bearing task projections: it is
non-null only for cancelled tasks. Current terminal time is `completedAt` for
done and `cancelledAt` for cancelled; original execution times are not rewritten.

## Dependency classification

`dependsOn` is the set D of all direct prerequisites, and `externalDependsOn` is its external subset E; ordinary dependencies are D minus E.
These are normalized UUID sets without duplicates or ordering semantics.

Ordinary dependencies belong to the same task chain; external dependencies are verified cross-chain prerequisites within the same project, not cross-project references.
Both kinds require done or cancelled prerequisites for starting and completion,
and participate in cycle and access checks. Cancellation itself has no unmet-input
prerequisite gate. Stage content and confirmation requirements remain independent
of a dependency being terminal.
Verify actual content and ownership; do not infer classification from done status, similar titles, graph roots, or connected components.

### CLI relationship replacement

`--depends-on` supplies the ordinary set, and `--external-depends-on` supplies the external set.
Supplying either option replaces all relationships and their classification: supplying only the ordinary option clears the external subset; supplying only the external option retains only those external relationships.
This is not an append operation.

Before editing, read the full D/E sets, compute D minus E, and declare every relationship that must remain with its intended classification.
Duplicate UUIDs, including equivalent UUIDs repeated across options, fail.
Omitting both options preserves relationships; the dependency-clearing option empties both sets and cannot be combined with dependency declarations.
After writing, [verify dependency changes](#verify-dependency-changes) across the complete relationships.

Partial updates through direct API patches differ from CLI semantics; do not infer that the CLI preserves undeclared relationships.
Omit all dependency options when updating only other metadata.

### Dependency reduction

Before creating tasks, registering a Goal breakdown, or changing dependencies, read the relevant dependency paths and retain only necessary direct prerequisites.
In `A -> B -> C`, arrows point from prerequisites to successors; C declares only B, not A again.

An ordinary edge is redundant only when another path consisting entirely of ordinary edges supplies the same prerequisite; an external edge may be supplied by an alternative path containing either kind of edge.
Preserve classification and check that all necessary paths still exist after reduction.
Source references do not require extra execution dependencies; this rule does not authorize cleaning up unrelated existing relationships.

### Verify dependency changes

After creating, replacing, or clearing dependencies, you must call `task graph` to read back the actual dependency graphs of the tasks involved, for example:

```bash
daynight task graph <task-id> --depends-only --json
```

Compare the D/E sets and classification with expectations, check that required prerequisite paths are complete, and check for direct edges removable under the reduction rules.
Disconnecting relationships may split the graph into multiple components; read each component starting from the tasks involved, not just the portion still connected to one starting task after the change.
Also read any paths outside the graph that require verification; an absent node does not prove that a dependency is missing or that no redundancy exists.

Do not report dependency checks as passed if graph reads fail or required paths remain unverified.
If missing or redundant relationships are found, reread task details, decide on changes, and verify again only within the authorized scope.
Consult `daynight task graph --help` for command arguments.

## Task deletion

`task delete` soft-deletes a task, removing it from ordinary lists, dependency graphs, ready results, and detail access while retaining stored data, its own prerequisite references, and attachments.
Deletion is independent of status and is not completion. Cancellation is a
readable business terminal state; it preserves dependencies and satisfies them
as done does, without claiming delivery. Neither operation grants execution or
acceptance authorization.

Deletion is strict by default: it is rejected if any undeleted task has a dependency pointing to the target.
When `--remove-depends` is explicitly authorized, the same transaction deletes the target and removes other tasks' ordinary and external dependencies on it, including references added before the transaction; this may make successors ready.
Tasks whose relationships change increment their versions while preserving status, timing, worker ownership, and other fields.

Deletion is always prohibited while the target has an active worker claim.
Reconsider deletion only after the stopped worker is released through an authorized management workflow; status changes cannot replace release.

Successful deletion returns neither a task resource nor a count of removed references.
If the response is uncertain, read the task: `410 task_deleted` confirms deletion; if the task still exists, decide again; permission or transport failures leave the outcome unconfirmed.
Do not equate inaccessibility or absence with deletion, and do not automatically replay deletion.
