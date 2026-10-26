---
name: using-daynight
description: Manage concrete work and design reviews in Daynight; register tasks, execute one specified task, or review an explicitly requested handoff.
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
PR links may supplement the material; they do not replace it. The description
and its actual sources follow the shared [task content standard](references/task-content.md),
including task-owned confirmation and delivery evidence.

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

The following are skill modes, not additional CLI commands. Read only the
selected reference, then use [the handbook](references/handbook.md) for the
operations it requires. Do not load every mode by default.

| Mode | Use when | Reference |
|---|---|---|
| `handbook` | Answering usage questions or performing requested task-management operations | [Handbook](references/handbook.md) |
| `create-task <request>` | Preparing or registering persistent work explicitly requested by the user | [Create task](references/create-task.md) |
| `run-task <task-id>` | Executing one specified ordinary task | [Run task](references/run-task.md) |
| `handoff <task-id>` | Reviewing an explicitly requested task for handoff and enabling permission after it passes | [Handoff](references/handoff.md) |
| `execute-task-in-managed <task-id>` | The worker startup prompt explicitly declares the `worker-managed` environment, this skill, and this mode | [Managed execution](references/execute-task-in-managed.md) |

The managed execution reference is loaded only for that explicit worker launch;
ordinary calls do not read it. Task properties, the working directory, and
environment variables do not select the managed mode. An invocation presented
as managed with an incomplete launch declaration waits for the missing context.

For ordinary calls, honor the explicitly selected mode. For `using-daynight`
without further input, infer the ordinary mode and target from the current
request and conversation. If context is insufficient or ambiguous, ask what the
user intends. Do not default to `handbook` or select a task merely because one
is ready. This skill does not discover and continuously select subsequent tasks.

## Shared constraints

- Create tasks only with explicit permission for their scope. Implementation
  requests, tracking needs, and inferred mode selection alone do not grant
  creation permission. An explicit user or applicable repository instruction
  requiring Daynight tracking or review is standing creation permission for the
  necessary tasks within the user's confirmed scope; reuse suitable existing
  tasks and do not ask for that permission again. Permission to create a Goal
  covers its discussion stages and confirmed in-scope breakdown, created only at
  the user-confirmation gates in the Goal protocol; unrelated work needs
  separate permission.
- Creation produces `todo` for every normal task and Goal stage and does not
  start execution. A request to start a Goal discussion authorizes entering
  `in_progress` for that discussion only; a user-confirmed transition authorizes
  the next discussion under the Goal protocol. Registration and discussion
  confirmation grant no delivery execution permission. Existing explicit
  execution authorization remains limited to its stated task or Goal scope.
- Use a normal task for one independently tracked outcome. Work requiring
  multiple independently tracked delivery stages is a Goal, expressed through
  existing tasks and `dependsOn`. Read [the Goal protocol](references/goal.md)
  when creating, executing, or advancing such a chain.
- Advance one specified task at a time, including CI, review, and merge waits.
  Subagents collaborate on that task. Execution returns after its task completes
  or requires external intervention; only ordinary execution may follow an
  explicit user-directed discussion transition under the Goal protocol. Task
  registration, completion, and discussion confirmation never select later
  delivery work.
- Keep execution, analysis, questions, proposals, and task discussions within the
  current task's confirmed objective, scope, deliverables, and acceptance criteria.
  Apply this boundary to subagents. Read parent Goal materials, shared architecture,
  and sibling or successor tasks as needed to understand this task's required
  inputs, interfaces, and constraints; reading them does not expand its scope.
  Report cross-task blockers and follow-up proposals without treating them as
  authorization to create or execute other tasks. Expanding the current task's
  scope requires explicit user confirmation. A Goal discussion or final-acceptance
  task may cover the whole Goal when that is its confirmed scope.
- Use the shared [task content standard](references/task-content.md) when
  creating, breaking down, handing off, or executing tasks. The description and
  actual references jointly supply the six content requirements; complete inline
  content needs no primary attachment. Give confirmations and delivery evidence
  an explicit location in the owning task. Confirm resources before linking and
  keep shared sources at their real owner. Each Goal delivery description directly
  identifies the architecture task and every required source location, including
  inline description sections and full paths for actual attachment documents,
  even for indirect successors, under the Goal protocol's readback rules. Express
  necessary direct prerequisites through complete `dependsOn` and its
  `externalDependsOn` subset. Omit redundant transitive dependencies under
  [the handbook's reduction rule](references/handbook.md#dependency-reduction).
  Same-chain prerequisites are ordinary; verified cross-chain prerequisites are
  external. Both block execution. CLI dependency options replace the full sets;
  preserve required relationships as the handbook requires.
- Task creation and execution do not enable `allowAgents`. Only an explicitly
  authorized [handoff](references/handoff.md) may enable it after content review;
  handoff does not start execution or replace other authority. Ordinary explicit
  task execution does not require automatic-selection permission or platform
  compatibility; dependencies, stage inputs, and execution authorization still
  apply. Automatic worker eligibility remains governed by the service and worker.
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
