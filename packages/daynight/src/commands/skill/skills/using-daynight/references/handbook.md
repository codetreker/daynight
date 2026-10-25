# Daynight handbook

Use the installed `daynight` CLI. Discover command groups with `daynight --help`
and read the relevant command's `--help` for arguments, options, and output
formats. The installed `dn` alias accepts the same commands. This reference indexes project/task commands and explains the context
needed to use them correctly.

## Command index

| Command | Purpose |
|---|---|
| `setup` | Configure access to the service origin and optional personal token. |
| `project create` | Register a repository as a project or find its existing project. |
| `project list` | Find projects on the configured service. |
| `project show` | Inspect a project's details. |
| `task create` | Register a todo task with its metadata and dependencies. |
| `task ready` | Read a bounded candidate page of todo tasks with completed prerequisites. |
| `task list` | Read every matching page; defaults to unfinished tasks. |
| `task show` | Read one task's complete details and exact version. |
| `task update` | Change metadata, automatic-execution permission, platform requirements, dependencies, or PR references; status is not writable. |
| `task set-status` | Set todo, in_progress, or done using an observed exact version. |
| `task delete` | Soft-delete one task using an observed exact version, retaining stored data and attachments. |
| `task graph` | Inspect the project's dependency graph and summary. |
| `task attachment put` | Upload or replace one attachment file. |
| `task attachment list` | Read a task's attachment inventory and metadata. |
| `task attachment read` | Retrieve an attachment's original bytes. |
| `task attachment remove` | Delete one attachment file. |

## Operational context

**Service credentials.** Read the installed `daynight setup --help` for credential
configuration. Use setup's hidden interactive token prompt or its explicit
stdin option; never put a token in command arguments, chat, task descriptions,
checkpoints or attachments. A configured token is bound to the normalized service
origin: changing the origin removes the previous token. Tokens require HTTPS
except for literal localhost or loopback HTTP addresses. Project discovery and
explicit project IDs grant no access; the service decides from current membership
when authorization is enabled. A 401 points to setup and does not permit an
anonymous retry or a blind repeat of a mutation. Reconcile an unconfirmed write
before another mutation. Setup saves configuration and performs no login or
network check.

**Project discovery.** Inside a Git worktree, task commands can omit `--project`:
the CLI matches the origin repository URL to a project on the configured
service. An explicit project overrides discovery for that invocation. Resolve
missing or ambiguous matches rather than guessing an ID or creating a project
to make a query succeed.

**Read scope.** Ready is a candidate page of todo tasks, ordered by
creation rather than relevance. An empty page does not rule out in-progress or dependency-blocked work. List traverses every matching page but
excludes `done` by default; include completed tasks explicitly when checking the
full backlog or prior registrations. Its grouping is in-progress, ready todo,
blocked todo, then done when included; this does not rank relevance.
Human lists are summaries; JSON lists omit only `description` and preserve every
other task field. Use show when a description is needed; ready, details and write
results retain full tasks. Graph provides compact dependency context without
full descriptions, PR properties, or versions. Read the selected task's details
before acting. A graph-limit error still permits bounded candidate and
individual task reads.

**Task status.** Creation starts in `todo` with no task approval stage and does
not start execution. `task set-status <task-id> <status> --if-version <version>`
sets any of `todo`, `in_progress`, or `done`. The service checks the exact version
before a same-status no-op; it preserves all fields for a current-version no-op
and refuses stale versions. A real change increments the version once. Generic
metadata updates cannot write status. Status, materials, and readiness grant no
implementation, publication, deployment, or merge permission.

Entering in_progress or done requires every direct prerequisite done. Reopening
done to todo or in_progress is refused when a direct successor is in_progress or
done; successors are never changed automatically. Entering in_progress starts a
new execution interval and clears completion; returning to todo clears both
endpoints. In_progress to done retains the nullable start and records completion.
Todo to done records only completion, with unknown duration. Same-status and
metadata updates preserve timing. State changes provide no process ownership,
release, transfer, stop, or lease semantics. The Web confirms every status choice,
including the current status; cancel and Escape submit no request.

**Task deletion.** `task delete <task-id> --if-version <version>` removes a task
from normal lists, graphs, readiness, and detail access while retaining its stored
data, dependency records, and attachment files. It is independent of the task's
status. Deletion is refused while an undeleted task depends on it or an active
worker claim owns it; remove the dependency or release the stopped worker through
the authorized workflow before reconsidering deletion. Deleting a task requires
explicit user authorization for that task; deletion is not a completion action.

Read the full task and preserve the exact version used for the deletion decision.
Without `--if-version`, the CLI reads the latest version immediately before
submitting; that read cannot protect an earlier decision. A successful deletion
returns no task resource. An authorized read of a deleted task returns
`410 task_deleted`, distinct from a missing task or inaccessible project. On a
lost response, GET the task to reconcile: `task_deleted` confirms it is deleted;
a live resource requires a new decision, and a permission or transport failure
leaves the outcome unconfirmed. Never replay deletion automatically. The Web
requires a confirmation dialog; the CLI command submits directly.

**Automatic execution permission.** Tasks expose the required boolean
`allowAgents`, independent of status and dependency readiness. New tasks
start false; public creation cannot set it. Existing tasks receive true through
the database migration. Use `task update <task-id> --allow-agents true|false --if-version <version>` only
for an explicitly authorized permission change.
Omission preserves the current value, including explicit false. Actual changes
are locked during in_progress; exact-version same-value requests keep the
version and timestamps, while stale versions still conflict. Status changes and other metadata updates preserve the flag.

`task list` and `task ready` accept `--allow-agents true|false`. The server
combines that condition with other filters before pagination and the ready limit;
an unfiltered ready page may contain tasks without automatic-execution permission.
Automatic selection requires true and automated workflows must not enable it
themselves. An explicitly user-selected task may still use manual execution regardless
of the flag. Permission does not grant execution, publication or merge authority.
A lost permission PATCH response is an unconfirmed write: read actual task state
before reconsidering the operation, without resubmitting automatically.

**Execution platform.** Complete tasks, inventory items and graph nodes expose
`requiredPlatform` as `null`, `windows`, `linux` or `macos`; null means unrestricted.
Set a requirement with `task create --required-platform <platform>` or
`task update <task-id> --required-platform <platform> --if-version <version>`.
Clear it with `task update <task-id> --clear-required-platform --if-version <version>`;
setting and clearing in one command is invalid. Omitting both update options
preserves the requirement. Existing and new tasks without a requirement are
unrestricted. Actual changes are locked during in_progress; an exact-version
same-value request keeps version and timestamps, while stale versions conflict.
Explicitly user-selected tasks and fixed queues retain their manual execution
path independently of platform compatibility. Automatic selections keep their
actual-platform context and recheck full-task eligibility before set-status.

`task list` and `task ready` accept `--compatible-platform <platform>`. The
server includes unrestricted tasks and exact matches, combining this condition
with status, readiness and `--allow-agents` before pagination or the ready limit.
Platform compatibility does not change readiness or enable automatic execution.
Preserve the filter when requesting additional candidate inventory; do not filter
a bounded unfiltered ready page locally. A query option selects a candidate
platform and does not establish the actual execution environment. Worker runtime
must identify its own platform; a Linux runtime in WSL is Linux.

**Task concurrency.** Bind each metadata update and status change to
the exact version read for that decision using `--if-version`; the CLI's default
pre-submit read cannot protect an earlier decision. Preserve full int64 decimal
digits without numeric rounding. Entering in_progress is a versioned transition, not an
assignee lock, renewable lease or proof that existing work belongs to this
session. On a conflict, reread and reconsider; a new action needs a fresh
decision, not merely a newer version. Never retry a mutation automatically.

**Dependency classification.** `dependsOn` contains every direct prerequisite;
`externalDependsOn` is its explicit external subset. Ordinary prerequisites are
`dependsOn` minus that subset. Both are canonical, duplicate-free UUID sets,
not insertion order. Every prerequisite must be done before entering in_progress or done,
including external ones; cycle checks and project access rules use all edges.
External means cross-chain within the same project, not a cross-project
reference. It separates chain ownership, not blocking or authorization. Use
ordinary relationships for confirmed same-chain work and external relationships
for verified prerequisites owned by another chain. Confirm task content and
ownership; done status, a similar title, current graph roots or the displayed
component do not establish the classification.

**CLI relationship replacement.** `--depends-on` declares ordinary prerequisites;
`--external-depends-on` declares external ones. Supplying either option compiles
their full union as `dependsOn` and the exact external set as `externalDependsOn`.
This replaces every relationship and its classification. An external-only option
replaces the set with only those external edges; it does not append or merely
mark an existing edge. An ordinary-only option makes every supplied edge ordinary
by explicitly sending an empty external subset. Repeat options for the complete
intended sets. Duplicate or cross-declared IDs fail, including case-equivalent
UUIDs. Omit both options to preserve relationships; `--clear-dependencies` sends
both empty sets and conflicts with either option. Before a dependency edit, read
all D/E values and derive the ordinary set D−E, then preserve every still-needed
relationship under its intended declaration. Read back the full sets afterward.
Installed command help owns exact syntax.

**Direct API patches.** API fields are independently optional. Omitting both
preserves relationships. Supplying only `dependsOn` replaces IDs, preserves
classification on surviving edges and makes new edges ordinary. Supplying only
`externalDependsOn` preserves IDs and replaces the complete external subset;
supplying both replaces both sets exactly. The external set must belong to the
final complete set. This API partial-patch rule differs from the CLI compiler's
explicit full relationship replacement; do not infer CLI append semantics from it.

**Other replacement fields.** Descriptions and PR reference lists replace the
whole supplied field. Preserve every still-needed value. Omitted fields stay
unchanged; clearing and option-pairing syntax is in command help.

**Markdown descriptions.** Write self-contained task briefs in Markdown following
[create-task](create-task.md). The Web displays CommonMark/GFM, while API and CLI
reads preserve the original string, including line breaks and fenced code. There
is no format flag. Relative description links and images start at the current
task's attachment root; Markdown attachment internals start at their containing
file's directory. Keep real case-sensitive paths inside the task root, confirm
uploaded contents before linking them, and preserve Markdown and valid references
when replacing a description. Shared inputs retain their source task ID and path
or verified immutable repository URL; they are not cross-task relative links.

**Attachment independence.** Task reads contain no attachment inventory.
Attachments use case-sensitive relative paths; uploads to the same path replace
that file, so keep mock UI resources at their referenced relative locations.
Attachment changes do not change the task's version, status, or update timestamp.
Task versions therefore cannot protect attachment writes. Multiple file
operations are independent, and file bytes and metadata can change partially;
confirm actual contents as well as metadata when reconciling a write.

**Unconfirmed writes.** A timeout, cancellation or lost response may follow an
applied change. Read back current task fields or attachment contents before
another mutation; cancellation does not prove rollback. For an unconfirmed
create, establish identity from complete fields and operation context; a matching
title or an empty lookup alone is insufficient. Preserve actual errors and
resource IDs rather than reporting success or blindly resending a write.

Task registration, execution, and selection follow [create-task](create-task.md),
[run-task](run-task.md), and [autopilot](autopilot.md), respectively. For a chain
of independently tracked delivery stages, use [the Goal protocol](goal.md).
Every stage and delivery task follows the same todo/in_progress/done contract.
A fixed Goal queue may use existing scoped execution authorization for its ready
successors; registration and discussion confirmation grant no delivery execution
permission.
