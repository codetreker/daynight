# Task management

Covers query scope, metadata, lifecycle, and dependency semantics.
See [authorization and scope](authorization.md) for operational permissions.
Follow [write safety](write-safety.md) for all writes.
Consult the relevant `--help` for arguments and field-clearing syntax.

## Task queries

| Read operation | Scope and limits |
| --- | --- |
| `task ready` | One capped page of candidate `todo` tasks whose direct prerequisites are all complete, ordered by creation, not relevance. An empty page does not rule out in-progress or blocked work. |
| `task list` | Traverse all matching pages. Excludes `done` by default; explicitly include completed tasks when checking for duplicates or inspecting history. |
| `task show` | A single task's full description, metadata, and exact version. Read it before operating on the selected task. |
| `task graph <task-id>` | The target's full bidirectionally connected component of ordinary dependencies, plus one layer of external prerequisites for those tasks. Includes all statuses without recursively expanding external tasks. |

Human-readable lists are summaries; JSON lists omit only `description`.
Ready results, task details, and write results that return tasks contain complete tasks.
Dependency graphs provide compact relationship context without full descriptions, PR properties, or versions and cannot replace task details. `--depends-only --json` returns only `id`, the full `dependsOn` set, and its `externalDependsOn` subset.
Graph nodes retain complete dependency references, which may point outside the graph; read the relevant tasks or their dependency graphs when those paths need assessment.
Reaching the graph limit fails the command rather than returning a truncated graph.
A candidate page or a single task cannot replace complete relationship verification.

Lists group tasks into in-progress, ready todo, blocked todo, and, when explicitly included, done.
These groups are not relevance rankings. See command help for filter syntax.

## Metadata

`task update` cannot change status.
A supplied description or PR reference list fully replaces that field; retain content that must remain and omit unrelated fields.
PR URLs are paired with titles; see help for syntax.
See the [task content standard](task-content.md) for organizing descriptions and attachments.

| Field | Semantics and limits |
| --- | --- |
| `allowAgents` | Permission for automatic selection. False for new tasks and cannot be enabled during creation. Enable only after an explicit [handoff](handoff.md) review. Omitting it from an update preserves its value. |
| `requiredPlatform` | `null`, `windows`, `linux`, or `macos`; null means unrestricted. Can be specified during creation or updates and cleared during updates. |

Actual changes to either field are prohibited while `in_progress`.
Same-value requests preserve the version and timestamps, but stale versions still conflict.
Status operations and other metadata operations preserve these fields.

List and ready support filtering by automatic-execution permission and platform compatibility.
The service combines filters before pagination or candidate limits.
Platform compatibility includes unrestricted and exact-match tasks without changing dependency readiness.
Preserve filters across pages; do not locally filter a capped, unfiltered ready page.

Ordinary execution explicitly targeted by the user is not restricted by automatic-selection permission or platform compatibility, but must still satisfy dependency, input, and authorization requirements.
Automatic execution must use the actual runtime platform and recheck full task eligibility before starting.
Query arguments do not prove the actual environment; a Linux runtime in WSL is Linux.

## Status and timing

New tasks are `todo`, have no approval status, and do not execute automatically.
Use `task set-status` to set `todo`, `in_progress`, or `done`.
Ordinary operations carry no claim; completion of a worker assignment must use [original-claim completion](autopilot-managed-task.md#complete-the-original-claim).
If either path is rejected, do not fall back to the other.

All direct prerequisites must be done before entering `in_progress` or `done`.
A completed prerequisite cannot be reopened while a direct successor is `in_progress` or `done`; successors are not modified automatically.

| Transition | Timing result |
| --- | --- |
| Enter `in_progress` | Start a new execution interval and clear the completion time. |
| Return to `todo` | Clear the start and completion times. |
| `in_progress` -> `done` | Preserve the nullable start time and record the completion time. |
| `todo` -> `done` | Record only the completion time; elapsed time is unknown. |

An actual status change increments the version once; a same-status operation with the current version changes no fields.
Metadata updates and same-status operations preserve timing.
Ordinary status changes have no process ownership, release, withdrawal, stop, or lease semantics.

## Dependency classification

`dependsOn` is the set D of all direct prerequisites, and `externalDependsOn` is its external subset E; ordinary dependencies are D minus E.
These are normalized UUID sets without duplicates or ordering semantics.

Ordinary dependencies belong to the same task chain; external dependencies are verified cross-chain prerequisites within the same project, not cross-project references.
Both kinds block starting and completion and participate in cycle and access checks.
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
Deletion is independent of status and is not completion.

Deletion is strict by default: it is rejected if any undeleted task has a dependency pointing to the target.
When `--remove-depends` is explicitly authorized, the same transaction deletes the target and removes other tasks' ordinary and external dependencies on it, including references added before the transaction; this may make successors ready.
Tasks whose relationships change increment their versions while preserving status, timing, worker ownership, and other fields.

Deletion is always prohibited while the target has an active worker claim.
Reconsider deletion only after the stopped worker is released through an authorized management workflow; status changes cannot replace release.

Successful deletion returns neither a task resource nor a count of removed references.
If the response is uncertain, read the task: `410 task_deleted` confirms deletion; if the task still exists, decide again; permission or transport failures leave the outcome unconfirmed.
Do not equate inaccessibility or absence with deletion, and do not automatically replay deletion.
