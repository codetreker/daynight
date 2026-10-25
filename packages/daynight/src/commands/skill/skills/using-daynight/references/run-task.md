# Run one task

Execute exactly one specified task ID within the user's authorized scope. Read
[the handbook](handbook.md) for CLI operations, data semantics, and failures.
This mode owns execution and completion; it returns without choosing a successor
or activating autopilot. An explicit user-directed requirements-to-solution
discussion transition follows the Goal protocol after current-task completion;
it is not automatic backlog selection.

## Establish the task and stage

Read the complete task with `daynight task show <task-id> --json`. Its Markdown
description must make the problem, current actions, scope, deliverables,
constraints, and observable completion summary understandable. Read its own primary
Markdown's Solution and Acceptance criteria; equivalent headings in the task's
language are valid.
Resolve description-relative links and images from the current task's attachment
root; links inside a Markdown attachment use its own directory. Resolve real
shared input references using the source task ID and attachment path or a verified
immutable repository reference. Read required contents rather than assuming a
task read loads attachment inventory or bytes.

For a Goal stage or delivery task, read [the Goal protocol](goal.md) and identify
its role from the actual task content and context. Apply that stage's input and
output requirements. Requirements and solution discussions start from their stage briefs;
the completed requirements, applicable UI prototype, and architecture are outputs
of the stages that produce them. Delivery tasks require the delivered design and
applicable prototype. Before implementation, read every required architecture
document listed in the delivery task's description using its architecture task ID
and full attachment paths or verified immutable repository references. This also
applies when the architecture task is only an indirect prerequisite. Confirm the
description's references satisfy the Goal protocol. When a prototype is a required
input, view and exercise it with its resources. An unfinished output of the current
stage is not a missing input.

An explicitly user-selected task may use the manual execution path regardless of
`allowAgents` or platform compatibility; a fixed queue explicitly selected by the
user has the same manual path. These conditions gate automatic selection, not
explicit assignment. Automated task selection requires true and must not enable
the flag itself. An automatically selected ID passed here remains automatic
selection, even though run-task receives a concrete ID. Carry its actual runtime
platform from autopilot and wait if unsupported or unknown. Immediately before
setting in_progress, reread the full task and recheck `todo`, ready,
`allowAgents=true`, and `requiredPlatform` either null or equal to that same actual
platform. A changed or incompatible requirement prevents starting and requires a
new selection decision; a changed execution environment requires fresh runtime
identification and candidate queries. Use the exact version from this full-task
recheck with `--if-version`; an earlier candidate page does not authorize the
manual exception after automatic eligibility changes.

Check state, every direct prerequisite, authorized scope, and required stage
inputs. Read `dependsOn` and its `externalDependsOn` subset: ordinary edges
express same-chain prerequisites, external marks distinguish verified cross-chain
ownership. Both kinds must be done before entering in_progress or done. Classification
never grants permission to execute a prerequisite, enable automatic
execution, or remove a blocker.
A missing or unreadable primary Markdown, missing Solution or Acceptance criteria,
or missing or unreadable required architecture reference or input leaves execution
unready. Resolve it within the existing authorization or return the concrete issue.
Do not infer requirements from a title, silently invent acceptance criteria, or
move detailed plans into the description. Do not execute prerequisites as an
implicit expansion of the requested task.

Creation leaves a task `todo` and does not execute it. An explicit request to
start the current Goal discussion, or the user-directed transition that starts
solution discussion, authorizes entering in_progress for that discussion under
the Goal protocol; registration alone does not. Existing execution authorization
may cover the stated task or fixed Goal queue and its ready successors. Task
status never expands implementation or delivery authorization.

For ready `todo`, begin only when dependencies are done, required stage inputs are complete
and the work is authorized. Use `task set-status <task-id> in_progress` with the exact version observed for
that decision and confirm in_progress before starting. A stale version or
changed prerequisite requires rereading and reconsidering, with no automatic
mutation retry. For `in_progress`, recover existing work and coordinate using the
project's established mechanisms; the state is not an assignee lock or lease.
A task already `done` is reported as such unless reopening is within the explicit requested scope; use the same versioned status setter and dependency protection.
Preserve the requested task ID through recovery and waiting.

## Execute and maintain continuity

Before analysis, questions, or proposals, establish this task's confirmed scope
and acceptance criteria and apply the [shared scope constraint](../SKILL.md#shared-constraints)
to execution and discussion.

Identify [final acceptance](../SKILL.md#final-acceptance) from the task's confirmed
outcome before applying a development or PR delivery lifecycle. Read the complete
requirements and actual deliveries for the task or Goal being assessed, and apply
the shared rule to verification methods, temporary helpers, and result ownership.

Follow the target repository's instructions for worktrees, implementation,
review, validation, and delivery. Use the task's stage-appropriate solution and
acceptance criteria, including applicable final-style prototype interactions.
Requirements discussion defines the problem without architecture decisions or
production implementation. Only user-confirmed requirements and direction to
continue permit completing that discussion and starting solution discussion.
Solution discussion keeps the draft architecture and breakdown in its owning
task. Only explicit user confirmation of the current solution permits registering
and verifying the actual delivery tasks. Do not start delivery from either
discussion. Keep the discussion in_progress while its user-confirmation gate is
unmet; a material revision after confirmation needs renewed user confirmation.

Resolve material changes to the agreed solution or acceptance within the current
authorization. Rewrite the owning artifact and affected task summaries and input
references coherently. Preserve requirements; do not silently weaken acceptance.
Descriptions remain self-contained Markdown task summaries. Preserve valid
syntax, original content, and actual resource references during full-field
updates; confirm new or replaced resources before linking them. Dependency edits
must follow the handbook's CLI replacement contract: read full D/E, retain needed
ordinary D−E and external E declarations, submit their intended complete sets
with the observed version, and read back both. Omit all dependency options for
unrelated metadata updates. Each primary
Markdown owns its detailed plan and evidence; shared inputs remain at their
verified source.

Advance only this task. Subagents collaborate on it, and waiting for CI, review,
approval, or merge remains part of it. Keep all required delivery PR URLs and
titles in the complete `properties.pullRequests` list, preserving existing
entries. Record acceptance results and necessary delivery evidence, including
merge commits, with the primary Markdown's corresponding acceptance criteria.
Rewrite current evidence coherently rather than accumulating an execution log.
Keep operational progress, blockers, waiting items, and next action in the
conversation or existing execution checkpoint, retaining the task ID and needed
PR and workspace references.

## Confirm completion or return waiting

Goal requirements and solution discussion tasks use the user-confirmed material
and stage acceptance in the Goal protocol. A generic repository PR rule does not
add a PR-merge prerequisite to these Daynight discussions. If particular
repository artifacts or PR delivery are explicitly part of that discussion
task's acceptance, honor that requirement under the delivery rules below.
Unconfirmed discussion material keeps its discussion task in_progress.

Development tasks and design or documentation delivery tasks with PRs remain
`in_progress` until the hosting platform confirms **every necessary delivery PR
is merged** and all stage acceptance criteria are satisfied. Code completion,
passing CI, approved review, and an open PR do not satisfy this condition. Verify
actual merge state through the host's native client or API; do not assume a
particular host.

Completion rules grant no merge, deployment, external communication, or mainline
push permission. Follow existing authorization without asking again for actions
it covers. If the user requests an open PR for review or forbids merging, deliver
the reviewable PR, preserve `in_progress` and the waiting checkpoint, and return
its URL and required user action. Do not enable auto-merge. Missing permission,
unavailable merge visibility, or an unmet merge check likewise keeps completion
pending and successors blocked.

For tasks without a development or PR delivery path, use their stated stage
acceptance. For [final acceptance](../SKILL.md#final-acceptance), also apply the
shared whole-task or whole-Goal completion rule. In every case, confirm required
evidence is recorded and readable, then reread the complete in-progress
task and use `task set-status <task-id> done` with its exact
observed version. For Goal discussions, use their confirmation gates and verified
accepted materials; for delivery tasks, use their acceptance and required authorized PR
merges.
Only service confirmation establishes the status update; reconcile uncertain
results before reporting success. A Goal requirements discussion task's completion
means requirements are confirmed; solution discussion completion means the user-confirmed solution and
actual verified breakdown are delivered. Neither establishes whole-Goal completion.

Continue ordinary CI and review waits as this task. When progress requires
external intervention, preserve the target, actual state, concrete blocker,
existing work, and next action in the checkpoint, then return the waiting result.
Unstarted work stays `todo`; active work stays `in_progress`. Do not declare
completion or select other work to bypass a wait. After completion, return
without selecting a successor, except for an explicit user-directed discussion
transition under the Goal protocol. That transition does not activate autopilot
or authorize delivery. Whole-Goal acceptance follows the Goal protocol.
