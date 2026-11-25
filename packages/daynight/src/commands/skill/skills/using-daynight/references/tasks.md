# Tasks

Establish the [Project](setup-and-projects.md#project-discovery) first; every write
also requires [write safety](write-safety.md).

## Queries

```bash
daynight task create --title "Improve installation" --description "Document prerequisites and verify setup."
daynight task create --title "Implement confirmed work" --status todo
daynight task create --type goal --title "Improve installation"
daynight task create --parent <goal-id> --title "Document prerequisites" --status todo
daynight task create --parent-task <task-id> --title "Fix a finding" --status todo
daynight task list --type goal --json
daynight task list --parent <goal-id> --json
daynight task list --parent-task <task-id> --all --json
daynight task list --tag <tag-id> --tag <another-tag-id> --tag-match any --json
daynight task list --untagged --json
daynight task list --all --json
daynight task list --status in_progress --json
daynight task list --ready --assigned-to me --json
daynight task list --assigned-to unassigned --json
daynight task ready --limit 20 --json
daynight task ready --tag <tag-id> --limit 20 --json
daynight task show <task-id> --json
```

For Task and Goal descriptions, follow the [material writing guidance](materials.md#descriptions-and-references).

Ordinary Task creation accepts only `--status proposed|todo`: default proposed is an unconfirmed
suggestion; todo is confirmed work, including internal multi-step Tasks. Goal
creation defaults to todo and accepts todo, in_progress, done and cancelled. Both
default to the signed-in assignee; override it with `--assigned-to <user-uuid>`
or create an unassigned resource with `--clear-assigned-to`. These options conflict.
Ordinary Tasks default to automatic execution disabled. Creation returns text, not
`--json`.

Task resources require `type` (`task` or `goal`) and nullable `parentId`.
Create, list and search default to `task`; `--type goal` selects Goals. Create,
update, list, search and ready accept `--parent <goal-id|none>`. For queries,
omission does not filter by parent, `none` selects Tasks without a direct Goal and a UUID
selects direct children of that Goal. On create omission means no parent; on update
it preserves the current parent. `none` writes null and a UUID sets the Goal.
Goals cannot have parents and may be empty. Membership is independent of Task
dependencies, status, assignee and materials; changing it does not move materials.
Existing Tasks and their materials are not migrated into Goals automatically.

Create, list, search and ready also accept `--parent-task <task-id>` for a
direct ordinary Task parent; it conflicts with `--parent`. A Team's `allowNestedSubtask` setting defaults to false: creating a child of an
ordinary child is rejected until the owning Team admin enables it. Existing trees
remain available when disabled or after a Project transfer. Ordinary parentage is
fixed at creation and cannot be changed through update. A parent must be visible,
in the same Project and nonterminal. Parentage does not create a dependency or
automatically start or complete the parent. Use `--all` on list to include done
and cancelled children. `--parent none` also matches ordinary children because
they have no direct Goal. Extended reads expose `parentTaskId` alongside the
Goal-only `parentId`; older services may omit the new field. An old service that
rejects a new filter or write is not retried with a weaker request.

Full Goal reads include `progress:{total,done,cancelled,unfinished}` for visible
direct ordinary children, independently of dependency chains. Counts are
nonnegative integers; done+cancelled+unfinished=total, with proposed/todo/in_progress
unfinished and all zeros for an empty Goal. Summary/sync omit progress; ordinary
Tasks have no progress object. Visible reads exclude deletion of a resource or
any deleted ancestor; authorized direct reads return `410 task_deleted` for effective
deletion without implying a child-row or version rewrite.

| Read | Scope/output |
| --- | --- |
| `task list` | All matching pages; excludes done/cancelled unless `--all` or explicit `--status` (mutually exclusive). Text is summary; JSON omits only description. |
| `task ready` | One capped page of ready todo candidates; creation order, default 10, `--limit` 1–100. |
| `task show` | One complete Task: description, properties, exact version; read before deciding about it. |
| `task graph <task-id>` | Compact relationship view; see [Dependencies](#dependencies). |
| `task list --status in_progress --group-by chain` | One page of the selected user's in-progress chains/independent Tasks; see [grouped work](session-reads.md#grouped-work). |

List filters are `--ready`, `--assigned-to <user-uuid|me|unassigned>`,
`--allow-agents true|false`, `--compatible-platform windows|linux|macos`,
`--type task|goal`, `--parent <goal-id|none>` and `--parent-task <task-id>`.
They combine with AND before pagination and persist on every page. Platform
matching includes unrestricted Tasks and exact matches. `me` uses response
identity even on empty pages. Ready supports parent and permission/platform filters but no
assignee filter; use `task list --ready --assigned-to me`. Readiness, assignment
and automatic permission are independent.

Ordinary list, ready and search accept repeated `--tag <tag-id>` UUIDs; IDs are
canonicalized, deduplicated and sorted. `--tag-match all` (default) requires all
selected tags, while `any` requires at least one. `--untagged` selects resources
without tags and conflicts with a nonempty tag selection. With neither selected
IDs nor `--untagged`, there is no tag predicate. The service applies it with
other filters before pagination or the ready limit; a Task matches only its own
tags, not its Goal's. The same selection is sent on every page. Invalid UUIDs
and conflicting options fail; unknown, deleted or cross-project tags produce
`invalid_tag_filter`. Request and cursor limits still apply and inputs are never
truncated. Grouped chain queries reject tag options.

Lists order in_progress, ready todo, blocked todo, proposed, then selected
terminal Tasks; done/cancelled stay distinct. Neither list nor ready ordering
ranks relevance. List/show/graph include [Session observations](session-reads.md#observations);
ready and full Task-returning writes do not query live Sessions. An update with
explicit Project and version returns a minimal receipt instead.
Full Task and Goal details, lists, ready results and full receipts contain their own `tags`
array of `{id,name}` references; `[]` means no tags. Text displays each name on
its own line, or `Tags: none`. Missing or invalid references fail as protocol
errors; graph nodes do not include tags.
A candidate page or single Task cannot prove a complete inventory or verify all
relationships. Include terminal Tasks for duplicate/history checks; read full
descriptions and separate materials required for the decision.

## Search

`task search <expression>` searches Task or Goal IDs, full titles and Markdown
descriptions in one Project, including done/cancelled. Pass one expression argument; use `--` for
a leading dash. Grammar: uppercase `AND`, `OR`, `NOT`, parentheses, quoted phrases,
`title:`, `description:`, `id:`; adjacency means AND. Matching is literal substring
with ASCII case folding.

Search accepts `--status`, `--assigned-to`, `--ready`, `--allow-agents`,
`--compatible-platform`, `--type`, `--parent`, `--parent-task` and the tag filters above, not `--all`; it traverses all pages in server relevance
order. Matches and direct parent context are compact, not full Tasks.
Tag filters intersect the expression; tag names are not search fields. An
expression is still required, so use list for tag-only queries.
Text/JSON omit assignee and update time;
JSON fields include id, type, parentId, parentTaskId, projectId, title, tags,
status, cancelledAt, context, parentTaskContext and match when supported by the
service. Search text also displays Type and Parent. `context:{taskId,title}`
identifies the direct Goal; `parentTaskContext` identifies the direct ordinary
parent. Dependencies do not establish parentage.
Any failure, including `search_changed`, leaves stdout empty; search again after
changes.

## Metadata

```bash
daynight task update <task-id> --title "Clarify installation" --if-version <observed-version>
daynight task update <task-id> --parent <goal-id> --if-version <observed-version>
daynight task update <task-id> --parent none --if-version <observed-version>
daynight task update <task-id> --assigned-to <user-uuid> --if-version <observed-version>
daynight task update <task-id> --allow-agents true --required-platform linux --if-version <observed-version>
```

With explicit `--project` and `--if-version`, update sends one PATCH without
Project or Task pre-reads and prints only Project ID, Task ID and resulting
version. Older services may return a full Task, which is validated in the same
response and reduced to that receipt. Without an explicit version, update reads
the Task first. A title change needs `task:write`; an `allowAgents` change needs
`agent:authorize`. Combined fields require all applicable scopes. Explicit Project
selection also lets show/list/graph read the Task endpoint directly; repository
discovery and other commands retain their existing read requirements.

Follow the [material writing guidance](materials.md#descriptions-and-references) when updating a description.
Update needs at least one mutable field. Supplied description replaces the
entire field: preserve required content; `--description=""` clears it, omission
preserves it. `--required-platform windows|linux|macos` conflicts with
`--clear-required-platform`.

`assignedTo` is one nullable human responsible, independent of properties/Worker
identity. Ordinary Task creation resolves the current account unless given an
explicit UUID or `--clear-assigned-to`; lookup failure prevents creation. Goal
creation with neither option omits `assignedTo` and the service defaults it to
the caller. Assignment writes accept UUIDs, not the list
filters me/unassigned. `--clear-assigned-to` clears assignment and conflicts with
`--assigned-to`.

A real assignment change resets allowAgents=false; equal assignment preserves it.
Assignment grants no Project access or execution transfer. Automatic claiming
needs a non-null assignee matching the Worker's authenticated account; existing
claim authority is separate. Actual assignment, permission and platform
changes are locked in_progress and do not change status. Task/graph JSON retain
assignedTo as UUID/null; text shows UUID/unassigned.

## Tag associations

```bash
daynight task create --title "Improve installation" --tag <tag-id> --tag <another-tag-id>
daynight task update <task-id> --tag <tag-id> --if-version <observed-version>
daynight task update <task-id> --clear-tags --if-version <observed-version>
daynight task tag add <task-id> <tag-id> --if-version <observed-version>
daynight task tag remove <task-id> <tag-id> --if-version <observed-version>
```

Create and update accept repeated tag UUIDs, normalized, deduplicated and sorted.
Create writes the tags and metadata atomically; omission creates no associations.
Update replaces the complete set; `--clear-tags` empties it and conflicts with
`--tag`. Omission preserves the set. Task and Goal tags are independent.

Add/remove read the current Task and PATCH the complete resulting set, including
when unchanged. An explicit version must match that read and remains the original
condition; otherwise the read version is used. Conflicts require a fresh decision.
A timeout or unknown result is not rollback: read the Task to inspect the saved
state and do not automatically replay the write. Successful receipts must contain
the submitted IDs.

## Status and timing

```bash
daynight task set-status <task-id> in_progress --if-version <observed-version>
daynight task set-status <task-id> done --if-version <observed-version>
daynight task set-status <task-id> cancelled --confirm --if-version <observed-version>
```

Goal read states are todo, in_progress, done and cancelled. They
have no parent, platform restriction or prerequisites; automatic execution is
disabled and they are never ready. When an ordinary child actually enters
`in_progress`, by a manual status change or Worker claim, its `todo` Parent Goal
also enters `in_progress` in the same transaction. Other Goal states are unchanged;
same-status requests and membership edits do not trigger this transition. Child
completion, cancellation, rollback or claim release does not end or revert the
Goal. Progress counts do not derive its status.

Without `--force`, before a Goal is created or set to done/cancelled, the CLI warns on stderr that child Task
states remain, new automatic claims are excluded and existing claims continue.
Goal terminal-status creation, changes and deletion require interactive confirmation or
`--force`; noninteractive calls without force do not submit. Force skips only
the Goal prompt, preserving service business/version checks. Ordinary Tasks and
nonterminal Goal status changes do not prompt.
These are client recognition and confirmation rules; the CLI does not implement
Goal-specific lifecycle effects. Service business/version checks govern writes.

The following lifecycle and timing rules describe ordinary Tasks.

An unfinished direct child prevents its parent's completion, ordinary
cancellation or deletion. The refusal identifies blocking Tasks when the caller
may read them. To cancel a parent and its unfinished descendants atomically,
pass `--confirm` with `cancelled`; the CLI submits the explicit request once
using the supplied or observed version. Already terminal descendants retain their
status. A protected descendant, including one with an active claim, rejects the
whole operation. `--force` remains the separate Goal confirmation option. An old
service may reject the new field; the CLI does not retry without it. For an
unknown write outcome, observe the original Task and descendants before deciding
what to do next.

| Status | Meaning |
| --- | --- |
| proposed | Unconfirmed/unfinished; never ready, cannot satisfy prerequisites or be automatically claimed. |
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
claim needs authorized release before cancellation. A cancelled Task cannot be claimed or withdrawn to proposed/todo; Session and archive history remain readable. Cancellation
preserves readable Task material, properties, Thread, execution history
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

Graph nodes are ordinary Tasks, retaining direct parent fields; Goal resources are not nodes.
Graph includes every status in the full bidirectional ordinary component plus
one layer of members' external prerequisites; external Tasks are not expanded.
Nodes omit full descriptions, PR properties and exact versions. Limits fail,
never truncate. `--depends-only --json` preserves that Task set but returns only
id, dependsOn and externalDependsOn; references may point outside it. Unavailable
prerequisites remain IDs without invented nodes or exposed details. After edits,
read relevant graphs/outside paths to verify full D/E and classification. An
absent graph node does not prove a missing dependency.
Hidden prerequisites retain physical state for readiness, reopening and cycles;
new dependency targets must be visible ordinary Tasks.

### Goal acceptance dependencies

```bash
daynight task goal-dependencies show <goal-id> --project <project-id> --limit 20 --json
daynight task goal-dependencies add <goal-id> --target <project-id>/<goal-id> --if-revision <revision>
daynight task goal-dependencies remove <goal-id> --edge <edge-id> --if-revision <revision>
daynight task goal-dependencies replace <goal-id> --edge <edge-id> --target <project-id>/<goal-id> --if-revision <revision>
daynight task goal-dependencies replace <goal-id> --clear --if-revision <revision>
```

These are Goal acceptance relationships, independent of ordinary Task
dependencies and Task metadata versions. The source Project is selected through
`--project` or repository discovery. Show reads one page: prerequisites are
complete on each page, while `--cursor` and `--limit` (1–50, default 20) page
visible successors. Each page is independently authorized. Text and JSON expose
the relationship kind and readable Goal status; an inaccessible prerequisite
has no target details. Editors receive its opaque edge ID and the relationship
revision, while readers without edit permission receive neither.

Repeat `--target` to add or replace targets and `--edge` to remove or retain
edges. Replace describes the complete desired set: `--edge` retains an existing
edge, including a hidden one; `--clear` explicitly supplies an empty set and
cannot be combined with targets or edges. A missing replacement set is rejected.
Targets must be readable Goals in the same owner Team. The service validates
cycles, permissions and completion constraints.

`--if-revision` is an exact positive int64 decimal string without leading zeroes.
Without it, the CLI reads the relationship once and uses its revision; a reader
without edit permission cannot obtain one. One edit submits at most one PATCH.
An edit receipt contains the Goal ID, resulting revision and whether the set
changed; `--json` returns those fields.
Conflicts and unknown outcomes are not replayed; a later read establishes only
current state, not the result of an uncertain submission. A service without the
relationship route requires an upgrade.

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
observation.

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
`410 task_deleted` confirms effective deletion, not which operation caused it or
whether the Task's own row was deleted. If the Task exists, decide again. Access or
transport failures cannot confirm it: follow
[uncertain results](write-safety.md#uncertain-results).
