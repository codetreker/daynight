---
name: using-daynight
description: Manage concrete work (features, bug fixes, architecture, and their breakdown) and design reviews in Daynight; create or execute tasks, and automatically execute related tasks only when explicitly requested.
---

# Using Daynight

Use the installed `daynight` CLI to keep persistent tasks aligned with the
user's authorized work. Task content, status and readiness describe work; they grant no
permission to implement, publish, deploy, communicate externally, merge, or push
a mainline branch.

## Required tracking and review

When this skill and Daynight are available, use Daynight to manage concrete work
with a defined objective and completion conditions: features, bug fixes,
architecture/design work, actual work items produced by their breakdown, and
independently scoped [final acceptance](#final-acceptance). An agent's transient
execution steps, such as reading files, running commands, and routine checks,
belong in its execution plan; their presence in a plan does not make them
Daynight tasks. Use the owning Daynight task for every solution, architecture,
and design review.

Before asking the user to review any solution, architecture, design, or related
discussion, save the complete current review material in the owning task's
description or attachments. Read it back to confirm it is accessible, then
provide the task ID or verified URL and any attachment paths. Keep revisions and
review decisions synchronized with that task. Chat summaries and repository or
PR links may supplement the material; they do not replace it. A short review
proposal may live in the description; detailed task plans retain their primary
Markdown ownership under the shared constraints.

Confirm the CLI, configured service, and intended project are accessible using
the handbook's discovery rules. Preserve actual availability or upload failures;
do not claim materials are ready for review until the saved contents are verified.

## Final acceptance

Final acceptance determines whether the complete requested task or Goal satisfies
its confirmed requirements. Define that outcome explicitly when creating or
breaking down work. Deliver the requirement-based conclusion, supporting evidence,
defects, and unverified items on the owning task. Record the verification methods,
tested source and environment, observations, and material limits.

Use manual verification, existing checks, or temporary helper scripts as
appropriate. Keep final-acceptance helpers in the project's temporary area and
uncommitted. Do not integrate them into repository tests, fixtures, runners, CI,
or tooling, or make building a maintained verification system the acceptance
deliverable. Review findings about a helper do not authorize that change of scope.

Complete acceptance according to the confirmed whole-task or whole-Goal criteria.
Finishing or passing helper scripts does not establish that the requested work is
complete. Do not report the underlying task or Goal as accepted while required
outcomes remain unmet or unverified. Verify necessary implementation deliveries
and PR merges as inputs; do not create a separate PR requirement for acceptance
helpers. Handle discovered product defects within the authorized implementation
scope.

Implementation and authorized defect-fix tasks retain their normal unit,
integration, and regression tests and required repository checks. A user-requested
maintained testing or automation capability is a development deliverable governed
by its own confirmed scope; do not infer it from a final-acceptance assignment.

## Select a mode

The following are skill modes, not additional CLI commands. Read the selected
reference, then use [the handbook](references/handbook.md) for the operations it
requires. Do not load every mode by default.

| Mode | Use when | Reference |
|---|---|---|
| `handbook` | Answering usage questions or performing requested task-management operations | [Handbook](references/handbook.md) |
| `create-task <request>` | Preparing or registering persistent work explicitly requested by the user | [Create task](references/create-task.md) |
| `run-task <task-id>` | Executing one specified task | [Run task](references/run-task.md) |
| `autopilot <goal or scope>` | The user explicitly requests automatic execution of Daynight tasks | [Autopilot](references/autopilot.md) |

Honor an explicitly selected mode. For `using-daynight` without further input,
infer the mode and target from the current request and conversation. If the
context is insufficient or ambiguous, ask what the user intends. Do not default
to `handbook` or select a task merely because one is ready.

Enter `autopilot` only after an explicit user request for automatic Daynight task
execution. A bare invocation may resume it when the conversation establishes
that it is already active. Loading this skill, discovering tasks, creating work,
and completing `run-task` never activate it.

## Shared constraints

- Create tasks only with explicit permission for their scope. Implementation
  requests, tracking needs, inferred mode selection, and autopilot activation
  alone do not grant creation permission. An explicit user or applicable
  repository instruction requiring Daynight tracking or review is standing
  creation permission for the necessary tasks within the user's confirmed scope;
  reuse suitable existing tasks and do not ask for that permission again.
  Permission to create a Goal covers its discussion stages and confirmed
  in-scope breakdown, created only at the user-confirmation gates in the Goal
  protocol; unrelated work needs separate permission.
- Creation produces `todo` for every normal task and Goal stage and does not
  start execution. A request to start a Goal discussion authorizes entering
  `in_progress` for that discussion only; a user-confirmed transition authorizes
  the next discussion under the Goal protocol. Registration and discussion
  confirmation grant no delivery execution permission. Existing explicit
  authorization may cover a stated task or fixed Goal queue and its ready
  successors without another per-task authorization.
- Use a normal task for one independently tracked outcome. Work requiring
  multiple independently tracked delivery stages is a Goal, expressed through
  existing tasks and `dependsOn`. Read [the Goal protocol](references/goal.md)
  when creating, executing, or advancing such a chain.
- Advance one task at a time, including CI, review, and merge waits. Subagents
  collaborate on the same task. `autopilot` owns selection of subsequent work;
  `run-task` and `create-task` return when their own work ends, except for the
  explicit user-directed discussion transition in the Goal protocol. Discussion
  confirmation does not activate autopilot or start delivery.
- Write each task description in Markdown as a self-contained brief: concrete
  problem, actions, scope, deliverables, constraints, observable completion summary,
  and real input references. Its own primary Markdown owns the detailed solution,
  acceptance criteria, and evidence. Confirm resources before linking them;
  description-relative links start at this task's attachment root. Attach resources
  according to actual ownership and need; reference shared inputs at their verified
  source. Each Goal delivery task's description directly identifies the architecture
  task and required architecture documents, including indirect successors; follow
  the Goal protocol's reference and readback rules. Express all prerequisites through
  `dependsOn` and their explicit external subset through `externalDependsOn`.
  Ordinary edges connect confirmed work in the same chain; mark a verified
  prerequisite from another chain as external.
  Both kinds block execution. CLI dependency options replace the full relationship
  set; preserve needed ordinary and external edges as the handbook requires.
- Automatic task selection requires `allowAgents=true`, readiness, and
  `requiredPlatform` compatibility with the actual current execution environment.
  Follow autopilot's runtime mapping, filter both ready and supplemental inventory
  before pagination, and carry automatic selection and its platform into run-task
  for a full-task recheck before version-bound `set-status in_progress`.
  Automated workers and agent workflows must not enable this permission themselves.
  Only an explicitly user-selected task or fixed Goal queue may follow the manual
  execution path regardless of the flag or platform compatibility; dependency,
  stage inputs and execution authorization still apply.
- Preserve the exact version observed when deciding a metadata update,
  `task set-status` change, or authorized `task delete`. Deletion retains stored
  data and attachments and requires explicit authorization for the target task.
  Add `--remove-depends` only when explicitly authorized to remove other tasks'
  ordinary and external dependencies on that task; omission keeps strict deletion.
  Generic updates cannot change status. Confirm writes,
  reconcile uncertain results before further mutations, and preserve actual
  failures. The handbook explains operational context; installed CLI help owns
  command usage.
- Follow the target repository's delivery rules and the user's authorization.
  When task acceptance includes PR delivery, a request to leave that PR for user
  review keeps the task `in_progress`. A Daynight discussion uses its own
  user-confirmation gate unless PR delivery is explicitly part of its acceptance.
  Completion rules grant no merge authority.
