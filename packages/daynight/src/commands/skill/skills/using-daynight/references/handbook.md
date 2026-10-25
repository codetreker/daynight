# Daynight handbook

Use the installed `daynight` CLI. Discover command groups with `daynight --help`
and read the relevant command's `--help` for arguments, options, and output
formats. The installed `dn` alias accepts the same commands. This reference indexes project/task commands and explains the context
needed to use them correctly.

## Command index

| Command | Purpose |
|---|---|
| `login` | Authorize CLI access through the browser using a device code. |
| `logout` | Revoke and remove the current CLI credential. |
| `setup` | Configure review repositories or explicit test-server/automation overrides. |
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

**Service credentials.** The CLI defaults to `https://daynight.cc` without a
configuration file or `serverUrl`. An explicit origin overrides it for a test
server. Use `daynight login` to display a code and open the browser verification
page, or `daynight login --no-browser` to authorize in another browser. The user
must compare the code, check the account and explicitly approve. A saved CLI
credential never expires by default. The Web account's token manager can set a
future expiry, restore “Never expires”, or revoke it; changing expiry preserves the same
credential and does not require another login. Expired or revoked credentials
cannot be revived. `daynight logout` revokes the current credential and clears its saved value
after confirmation or an already-invalid response; network or unconfirmed
failures remain visible. Login does not execute any pending business operation.

A service command without a saved credential fails before dispatch and points
to `daynight login`; a server 401 gives the same guidance. Do not automatically
start login, retry anonymously, or blindly repeat a mutation. Reconcile an
unconfirmed write before another mutation. Project discovery and explicit project
IDs grant no access; current service membership decides authorization.

For noninteractive automation, read `daynight setup --help` and use the explicit
`--server-token-stdin` option with a token from a secret source. Never put a token
in command arguments, chat, task descriptions, checkpoints or attachments.
A token is bound to the normalized origin, and changing the origin removes its
old local value. Credentials require HTTPS except for literal localhost or
numeric-loopback HTTP. Setup saves configuration without network or login checks;
ordinary setup does not prompt for a server address or token.

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

**Task deletion.** `task delete <task-id> [--remove-depends] --if-version <version>`
removes a task from normal lists, graphs, readiness, and detail access while
retaining its stored data, its own prerequisite references, and attachment files.
Deletion is independent of the task's status. Without `--remove-depends`, an
undeleted task depending on the target prevents deletion; a task with no such
references can be deleted directly. The service checks this in the deletion
transaction; the CLI does not download the graph to decide whether deletion is
allowed.

`--remove-depends` is an optional switch with no value. It explicitly authorizes
removing all other tasks' ordinary and external dependencies on the target in the
same transaction as soft deletion, including references added before that
transaction executes. This can make affected tasks ready. Each task whose
relationships change receives a new version; its status, execution times, worker
ownership, and other data are preserved. The target's own prerequisite references
are retained. An active worker claim on the target always prevents deletion;
release the stopped worker through the authorized workflow before reconsidering
it. Deleting a task requires explicit user authorization for that task; removing
other tasks' dependencies requires that additional authorization. Deletion is not
a completion action.

Read the full task and preserve the exact version used for the deletion decision.
Without `--if-version`, the CLI reads the latest version immediately before
submitting; that read cannot protect an earlier decision. A successful deletion
returns no task resource or removed-reference count. An authorized read of a
deleted task returns `410 task_deleted`, distinct from a missing task or
inaccessible project. On a lost response, GET the task to reconcile:
`task_deleted` confirms it is deleted; a live resource requires a new decision,
and a permission or transport failure leaves the outcome unconfirmed. Never
replay deletion automatically. The Web confirmation explicitly authorizes
removing other tasks' dependencies together with deletion; the CLI submits its
selected mode directly.

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
